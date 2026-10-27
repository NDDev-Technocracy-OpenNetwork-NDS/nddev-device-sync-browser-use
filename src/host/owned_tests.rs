//! Protocol/lifetime fixtures, not browser-provider acceptance.
use super::*;

fn fixture() -> (Arc<Host>, mpsc::Receiver<Vec<u8>>, tempfile::TempDir) {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("runtime");
    runtime::private_directory(&runtime).unwrap();
    runtime::private_directory(&runtime.join("sessions")).unwrap();
    let (outbound, queue) = mpsc::channel(16);
    let host = Arc::new(Host {
        config: Config {
            runtime: runtime.clone(),
            bun: std::env::current_exe().unwrap(),
            executor: root.path().join("inert.ts"),
        },
        installed: None,
        cdp_socket: runtime.join("cdp.sock"),
        outbound,
        pending: Mutex::default(),
        next_request: AtomicU64::new(1),
        state: Mutex::new(State {
            connected: true,
            enabled: true,
            ..State::default()
        }),
    });
    (host, queue, root)
}

async fn message(queue: &mut mpsc::Receiver<Vec<u8>>) -> Value {
    let frame = tokio::time::timeout(CONTROL_IO, queue.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        u32::from_ne_bytes(frame[..4].try_into().unwrap()) as usize,
        frame.len() - 4
    );
    serde_json::from_slice(&frame[4..]).unwrap()
}

fn answer(host: &Host, request: &Value) {
    host.on_extension(json!({ "type": "result", "id": request["id"], "result": { "tabs": [] } }));
}

#[tokio::test]
async fn owned_handles_cannot_adopt_or_change_a_foreign_or_replaced_session() {
    let (host, mut queue, _root) = fixture();
    let original = host.create_owned("project").unwrap();
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    let mut foreign = original.clone();
    foreign.generation = "foreign".into();
    assert!(matches!(
        host.handle(Request::CloseOwned {
            session: foreign.clone(),
            close_tabs: true
        })
        .await,
        Reply::Refused {
            refusal: Refusal::SessionNotFound
        }
    ));
    assert!(matches!(
        host.handle(Request::OpenOwned { session: foreign }).await,
        Reply::Refused {
            refusal: Refusal::SessionNotFound
        }
    ));
    assert!(host.state().sessions.contains_key("project"));
    assert!(matches!(
        host.handle(Request::CloseOwned {
            session: original.clone(),
            close_tabs: false
        })
        .await,
        Reply::Closed
    ));
    let replacement = host.create_owned("project").unwrap();
    assert_ne!(original, replacement);
    for request in [
        Request::OpenOwned {
            session: original.clone(),
        },
        Request::CloseOwned {
            session: original.clone(),
            close_tabs: true,
        },
    ] {
        assert!(matches!(
            host.handle(request).await,
            Reply::Refused {
                refusal: Refusal::SessionNotFound
            }
        ));
    }
    assert!(matches!(
        host.session_life(&original.project, Some(&original.generation)),
        Err(Refusal::SessionNotFound)
    ));
    assert_eq!(
        host.session_life(&replacement.project, Some(&replacement.generation))
            .unwrap()
            .generation,
        replacement.generation
    );
    assert!(
        queue.try_recv().is_err(),
        "reservations and stale handles performed browser I/O"
    );
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn close_waits_for_late_open_and_prevents_new_generation_until_release_ack() {
    let (host, mut queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let opened = {
        let host = host.clone();
        let handle = handle.clone();
        tokio::spawn(async move { host.handle(Request::OpenOwned { session: handle }).await })
    };
    let claim = message(&mut queue).await;
    assert_eq!(claim["type"], "claim");
    let closed = {
        let host = host.clone();
        let handle = handle.clone();
        tokio::spawn(async move {
            host.handle(Request::CloseOwned {
                session: handle,
                close_tabs: false,
            })
            .await
        })
    };
    tokio::time::timeout(CONTROL_IO, async {
        while !host.state().sessions["project"].closing {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!closed.is_finished());
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    answer(&host, &claim);
    assert!(matches!(
        opened.await.unwrap(),
        Reply::Refused {
            refusal: Refusal::PermissionRequired
        }
    ));
    let release = message(&mut queue).await;
    assert_eq!(release["type"], "release");
    assert!(!closed.is_finished());
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    answer(&host, &release);
    assert!(matches!(closed.await.unwrap(), Reply::Closed));
    let replacement = host.create_owned("project").unwrap();
    assert_ne!(replacement, handle);
    assert!(matches!(
        host.handle(Request::OpenOwned { session: handle }).await,
        Reply::Refused {
            refusal: Refusal::SessionNotFound
        }
    ));
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn dropped_open_waiter_retains_pending_claim_until_actual_reply() {
    let (host, mut queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host
        .session_life(&handle.project, Some(&handle.generation))
        .unwrap();
    let opened = {
        let host = host.clone();
        let handle = handle.clone();
        tokio::spawn(async move { host.handle(Request::OpenOwned { session: handle }).await })
    };
    let claim = message(&mut queue).await;
    opened.abort();
    let _ = opened.await;
    assert_eq!(*life.pending.borrow(), 1);
    let closed = {
        let host = host.clone();
        let handle = handle.clone();
        tokio::spawn(async move {
            host.handle(Request::CloseOwned {
                session: handle,
                close_tabs: false,
            })
            .await
        })
    };
    tokio::task::yield_now().await;
    assert!(!closed.is_finished());
    answer(&host, &claim);
    let release = message(&mut queue).await;
    answer(&host, &release);
    assert!(matches!(closed.await.unwrap(), Reply::Closed));
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn unacknowledged_action_holds_closed_admission_instead_of_claiming_cleanup() {
    let (host, _queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host
        .session_life(&handle.project, Some(&handle.generation))
        .unwrap();
    drop(PendingWork::new(life));
    assert!(matches!(
        host.handle(Request::CloseOwned {
            session: handle,
            close_tabs: false
        })
        .await,
        Reply::Refused {
            refusal: Refusal::Timeout
        }
    ));
    assert!(host.state().sessions["project"].closing);
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    host.shutdown().await.unwrap();
}

#[cfg(target_os = "linux")]
async fn prepared_executor_fixture() -> (
    Arc<Host>,
    mpsc::Receiver<Vec<u8>>,
    tempfile::TempDir,
    OwnedSession,
    u32,
) {
    let (host, queue, root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host
        .session_life(&handle.project, Some(&handle.generation))
        .unwrap();
    {
        let mut state = host.state();
        let session = state.sessions.get_mut("project").unwrap();
        runtime::private_directory(&session.artifacts).unwrap();
        session.opened = true;
    }
    let (child, pid) = executor::owned_test_child().await;
    *life.executor.lock().await = Some(child);
    (host, queue, root, handle, pid)
}

#[cfg(target_os = "linux")]
async fn executing_fixture() -> (
    Arc<Host>,
    mpsc::Receiver<Vec<u8>>,
    tempfile::TempDir,
    OwnedSession,
    u32,
    tokio::task::JoinHandle<Result<view::Outcome, Refusal>>,
) {
    let (host, queue, root, handle, pid) = prepared_executor_fixture().await;
    let life = host
        .session_life(&handle.project, Some(&handle.generation))
        .unwrap();
    let task = {
        let host = host.clone();
        let life = life.clone();
        tokio::spawn(async move { host.run("project", &life, "inert", 25_000, None).await })
    };
    tokio::time::timeout(CONTROL_IO, async {
        while !host.state().sessions["project"].running {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(PathBuf::from(format!("/proc/{pid}")).exists());
    (host, queue, root, handle, pid, task)
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn close_during_execute_reaps_actual_owned_child_before_release_and_ack() {
    let (host, mut queue, _root, handle, pid, task) = executing_fixture().await;
    let closed = {
        let host = host.clone();
        let handle = handle.clone();
        tokio::spawn(async move {
            host.handle(Request::CloseOwned {
                session: handle,
                close_tabs: false,
            })
            .await
        })
    };
    let release = message(&mut queue).await;
    assert_eq!(release["type"], "release");
    assert!(
        !PathBuf::from(format!("/proc/{pid}")).exists(),
        "close reached release before child reap"
    );
    assert!(!closed.is_finished());
    answer(&host, &release);
    assert!(matches!(closed.await.unwrap(), Reply::Closed));
    assert!(matches!(
        task.await.unwrap(),
        Err(Refusal::PermissionRequired)
    ));
    assert!(!host.state().sessions.contains_key("project"));
    host.shutdown().await.unwrap();
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn shutdown_drains_actual_running_executor_without_a_detached_cleanup_task() {
    let (host, _queue, _root, _handle, pid, task) = executing_fixture().await;
    host.shutdown().await.unwrap();
    assert!(matches!(
        task.await.unwrap(),
        Err(Refusal::PermissionRequired)
    ));
    assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    assert!(host.state().sessions.is_empty());
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn control_disconnect_reaps_its_executor_and_retains_the_owned_handle_for_drain() {
    let (host, _queue, _root, handle, pid) = prepared_executor_fixture().await;
    let (mut client, server) = tokio::net::UnixStream::pair().unwrap();
    let control = {
        let host = host.clone();
        tokio::spawn(async move { host.control(server).await })
    };
    let mut frame = serde_json::to_vec(&Request::ExecuteOwned {
        session: handle.clone(),
        code: "inert".into(),
        timeout_ms: 25_000,
        expect: None,
    })
    .unwrap();
    frame.push(b'\n');
    client.write_all(&frame).await.unwrap();
    tokio::time::timeout(CONTROL_IO, async {
        while !host.state().sessions["project"].running {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(client);
    tokio::time::timeout(EXTENSION_REPLY, control)
        .await
        .unwrap()
        .unwrap();
    assert!(!PathBuf::from(format!("/proc/{pid}")).exists());
    assert!(host.state().sessions["project"].closing);
    assert!(
        host.session_life(&handle.project, Some(&handle.generation))
            .is_ok()
    );
    host.shutdown().await.unwrap();
}
