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
            activity: root.path().join("activity"),
            sessions: runtime.join("sessions"),
        },
        installed: None,
        cdp_socket: runtime.join("cdp.sock"),
        outbound,
        pending: Mutex::default(),
        next_request: AtomicU64::new(1),
        state: Mutex::new(State {
            connected: true,
            enabled: true,
            contract: Some(CONTRACT),
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

fn answer(host: &Arc<Host>, request: &Value) {
    let result = if request["type"] == "release" {
        json!({ "released": true })
    } else {
        json!({ "tabs": [] })
    };
    host.on_extension(json!({ "type": "result", "id": request["id"], "result": result }));
}

fn opened_client(host: &Host, handle: &OwnedSession, id: u64) -> mpsc::Receiver<String> {
    let (send, receive) = mpsc::channel(16);
    let mut state = host.state();
    let session = state.sessions.get_mut(&handle.project).unwrap();
    runtime::private_directory(&session.artifacts).unwrap();
    session.opened = true;
    session.client = Some(relay::Client::new(id, send, CancellationToken::new()));
    receive
}

fn forwarded(host: &Host, project: &str, client: u64, expired: bool) -> relay::Forward {
    let work = host
        .session_cdp_work(project, client)
        .unwrap_or_else(|_| panic!("synthetic current client was not admitted"));
    let permit = Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap();
    let mut forward = relay::Forward::new(
        work,
        project.into(),
        client,
        json!(1),
        tab_session(1),
        permit,
    );
    if expired {
        forward.deadline = Instant::now();
    }
    forward
}

fn command() -> Value {
    json!({ "type": "cdp", "tab": 1, "method": "Runtime.evaluate", "params": {} })
}

#[tokio::test]
async fn expired_cdp_is_released_only_by_strict_ack_for_its_exact_life() {
    let (host, mut queue, _root) = fixture();
    let old = host.create_owned("project").unwrap();
    let life = host
        .session_life(&old.project, Some(&old.generation))
        .unwrap();
    let mut client = opened_client(&host, &old, 1);
    let expired = host
        .submit_cdp(command(), forwarded(&host, "project", 1, true))
        .unwrap_or_else(|_| panic!("current CDP enqueue failed"));
    let _ = message(&mut queue).await;
    host.expire_pending(Instant::now());
    assert_eq!(life.cdp_state.load(Ordering::Acquire), CDP_UNCERTAIN);
    assert!(!life.uncertain.load(Ordering::Acquire));
    assert_eq!(*life.pending.borrow(), 0);
    assert!(client.try_recv().unwrap().contains("error"));

    // An unanswered command still in the map is retired by release too. Its
    // retirement is not delivered as a fabricated successful command result.
    let pending = host
        .submit_cdp(command(), forwarded(&host, "project", 1, false))
        .unwrap_or_else(|_| panic!("current CDP enqueue failed"));
    let _ = message(&mut queue).await;
    let other = host.create_owned("other").unwrap();
    let other_life = host
        .session_life(&other.project, Some(&other.generation))
        .unwrap();
    let _other_client = opened_client(&host, &other, 2);
    let other_id = host
        .submit_cdp(command(), forwarded(&host, "other", 2, false))
        .unwrap_or_else(|_| panic!("other CDP enqueue failed"));
    let _ = message(&mut queue).await;
    let closed = {
        let host = host.clone();
        let old = old.clone();
        tokio::spawn(async move {
            host.handle(Request::CloseOwned {
                session: old,
                close_tabs: false,
            })
            .await
        })
    };
    let release = message(&mut queue).await;
    assert_eq!(release["type"], "release");
    assert_eq!(life.cdp_state.load(Ordering::Acquire), CDP_UNCERTAIN);
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    answer(&host, &release);
    assert!(matches!(closed.await.unwrap(), Reply::Closed));
    assert_eq!(life.cdp_state.load(Ordering::Acquire), CDP_RELEASED);
    assert_eq!(*life.cdp_pending.borrow(), 0);
    assert!(!host.pending().contains_key(&expired));
    assert!(!host.pending().contains_key(&pending));
    assert!(host.pending().contains_key(&other_id));
    assert_eq!(*other_life.cdp_pending.borrow(), 1);
    assert_ne!(other_life.cdp_state.load(Ordering::Acquire), CDP_RELEASED);
    assert!(client.try_recv().is_err());
    let replacement = host.create_owned("project").unwrap();
    assert_ne!(replacement, old);
    host.on_extension(json!({ "type": "result", "id": pending, "result": { "late": true } }));
    assert_eq!(
        host.session_life("project", None).unwrap().generation,
        replacement.generation
    );
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn older_empty_release_ack_preserves_closed_admission_and_cdp_uncertainty() {
    let (host, mut queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host.session_life("project", None).unwrap();
    let _client = opened_client(&host, &handle, 1);
    host.submit_cdp(command(), forwarded(&host, "project", 1, true))
        .unwrap_or_else(|_| panic!("current CDP enqueue failed"));
    let _ = message(&mut queue).await;
    host.expire_pending(Instant::now());
    let closed = {
        let host = host.clone();
        tokio::spawn(async move {
            host.handle(Request::CloseOwned {
                session: handle,
                close_tabs: false,
            })
            .await
        })
    };
    let release = message(&mut queue).await;
    host.on_extension(json!({ "type": "result", "id": release["id"], "result": {} }));
    assert!(matches!(
        closed.await.unwrap(),
        Reply::Refused {
            refusal: Refusal::ExtensionUnavailable
        }
    ));
    assert_eq!(life.cdp_state.load(Ordering::Acquire), CDP_UNCERTAIN);
    assert!(host.state().sessions["project"].closing);
    assert!(host.state().sessions["project"].artifacts.is_dir());
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn unknown_lifecycle_mutation_cannot_be_discharged_as_cdp() {
    let (host, mut queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host.session_life("project", None).unwrap();
    let _client = opened_client(&host, &handle, 1);
    host.submit_cdp(command(), forwarded(&host, "project", 1, true))
        .unwrap_or_else(|_| panic!("current CDP enqueue failed"));
    let _ = message(&mut queue).await;
    host.expire_pending(Instant::now());
    drop(PendingWork::new(life.clone()));
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
    assert!(
        queue.try_recv().is_err(),
        "unresolved mutation reached release"
    );
    assert!(life.uncertain.load(Ordering::Acquire));
    assert_eq!(life.cdp_state.load(Ordering::Acquire), CDP_UNCERTAIN);
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn lost_release_waiter_retains_lifecycle_uncertainty_after_expiry_and_late_result() {
    let (host, mut queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host.session_life("project", None).unwrap();
    let _client = opened_client(&host, &handle, 1);
    host.submit_cdp(command(), forwarded(&host, "project", 1, true))
        .unwrap_or_else(|_| panic!("current CDP enqueue failed"));
    let _ = message(&mut queue).await;
    host.expire_pending(Instant::now());
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
    closed.abort();
    let _ = closed.await;
    assert_eq!(*life.pending.borrow(), 1);
    {
        let mut pending = host.pending();
        let Waiter::Reply { deadline, .. } =
            pending.get_mut(&release["id"].as_u64().unwrap()).unwrap()
        else {
            panic!("release was not lifecycle-owned");
        };
        *deadline = Instant::now();
    }
    host.expire_pending(Instant::now());
    assert_eq!(*life.pending.borrow(), 0);
    assert!(life.uncertain.load(Ordering::Acquire));
    answer(&host, &release); // This late, already-untracked reply cannot grant cleanup.
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
    assert!(queue.try_recv().is_err());
    assert_eq!(life.cdp_state.load(Ordering::Acquire), CDP_UNCERTAIN);
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn cdp_enqueue_refuses_full_queue_without_pending_or_uncertain_work() {
    let (host, mut queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host.session_life("project", None).unwrap();
    let _client = opened_client(&host, &handle, 1);
    while host.outbound.try_send(Vec::new()).is_ok() {}
    assert!(matches!(
        host.submit_cdp(command(), forwarded(&host, "project", 1, false)),
        Err(Failure::Refused(Refusal::Busy))
    ));
    assert!(host.pending().is_empty());
    assert_eq!(*life.cdp_pending.borrow(), 0);
    assert_eq!(life.cdp_state.load(Ordering::Acquire), 0);
    while queue.try_recv().is_ok() {}
    let delayed = forwarded(&host, "project", 1, false);
    host.on_control(false);
    assert!(matches!(
        host.submit_cdp(command(), delayed),
        Err(Failure::Refused(Refusal::SessionNotFound))
    ));
    assert!(queue.try_recv().is_err());
    assert_eq!(*life.cdp_pending.borrow(), 0);
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn delayed_old_cdp_cannot_enqueue_into_a_replacement_even_with_the_same_client_id() {
    let (host, mut queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host.session_life("project", None).unwrap();
    let _client = opened_client(&host, &handle, 1);
    let delayed = forwarded(&host, "project", 1, false);
    let closed = {
        let host = host.clone();
        tokio::spawn(async move {
            host.handle(Request::CloseOwned {
                session: handle,
                close_tabs: false,
            })
            .await
        })
    };
    let release = message(&mut queue).await;
    answer(&host, &release);
    assert!(matches!(closed.await.unwrap(), Reply::Closed));
    let replacement = host.create_owned("project").unwrap();
    let _replacement_client = opened_client(&host, &replacement, 1);
    assert!(matches!(
        host.submit_cdp(command(), delayed),
        Err(Failure::Refused(Refusal::SessionNotFound))
    ));
    assert!(queue.try_recv().is_err());
    assert_eq!(life.cdp_state.load(Ordering::Acquire), CDP_RELEASED);
    assert_eq!(*life.cdp_pending.borrow(), 0);
    assert_eq!(
        host.session_life("project", None).unwrap().generation,
        replacement.generation
    );
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn reenabled_opened_generation_still_waits_for_its_strict_release_ack() {
    let (host, mut queue, _root) = fixture();
    let handle = host.create_owned("project").unwrap();
    let life = host.session_life("project", None).unwrap();
    let _client = opened_client(&host, &handle, 1);
    host.on_control(false);
    host.on_control(true);
    let drained = {
        let host = host.clone();
        tokio::spawn(async move { host.drain_closing().await })
    };
    let release = message(&mut queue).await;
    assert_eq!(release["type"], "release");
    assert!(life.stop.is_cancelled());
    assert!(matches!(host.create_owned("project"), Err(Refusal::Busy)));
    answer(&host, &release);
    drained.await.unwrap();
    let replacement = host.create_owned("project").unwrap();
    assert_ne!(replacement, handle);
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn disabled_then_enabled_before_sweep_still_finishes_the_canceled_generation() {
    let (host, mut queue, _root) = fixture();
    let old = host.reserve("legacy", false).unwrap();
    host.on_control(false);
    host.on_control(true);
    assert!(old.stop.is_cancelled());
    host.drain_closing().await;
    assert!(!host.state().sessions.contains_key("legacy"));
    let replacement = host.reserve("legacy", false).unwrap();
    assert!(!Arc::ptr_eq(&old, &replacement));
    assert!(queue.try_recv().is_err());
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn legacy_open_drains_only_the_captured_closing_generation() {
    let (host, mut queue, _root) = fixture();
    let old = host.reserve("legacy", false).unwrap();
    host.on_control(false);
    host.on_control(true);
    let opened = {
        let host = host.clone();
        tokio::spawn(async move { host.open("legacy").await })
    };
    let claim = message(&mut queue).await;
    let replacement = host.session_life("legacy", None).unwrap();
    assert!(!Arc::ptr_eq(&old, &replacement));
    host.on_extension(json!({ "type": "result", "id": claim["id"],
        "error": { "code": "permission_required", "message": "permission_required" } }));
    assert!(matches!(
        opened.await.unwrap(),
        Err(Refusal::PermissionRequired)
    ));
    assert!(matches!(
        host.close_generation("legacy", &old, false, true).await,
        Err(Refusal::SessionNotFound)
    ));
    assert!(Arc::ptr_eq(
        &host.session_life("legacy", None).unwrap(),
        &replacement
    ));
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn legacy_open_reuses_its_pending_session_without_adopting_owned_reservations() {
    let (host, mut queue, _root) = fixture();
    host.reserve("legacy", false).unwrap();
    let legacy = host.open("legacy").await.unwrap();
    assert_eq!(legacy.project, "legacy");
    assert!(!legacy.executor);
    host.create_owned("owned").unwrap();
    assert!(matches!(host.open("owned").await, Err(Refusal::Busy)));
    assert!(queue.try_recv().is_err());
    host.shutdown().await.unwrap();
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
async fn shutdown_attempts_later_reaps_after_the_first_artifact_failure() {
    let (host, _queue, root) = fixture();
    host.create_owned("one").unwrap();
    host.create_owned("two").unwrap();
    // Select the actual captured iteration order, never assume HashMap key order.
    // No keys are inserted/removed before shutdown takes that same snapshot.
    let captured: Vec<(String, Arc<SessionLife>)> = host
        .state()
        .sessions
        .iter()
        .map(|(project, session)| (project.clone(), session.life.clone()))
        .collect();
    assert_eq!(captured.len(), 2);
    let first = captured[0].0.clone();
    let later = captured[1].0.clone();
    let first_artifact = {
        let mut state = host.state();
        let session = state.sessions.get_mut(&first).unwrap();
        session.opened = true;
        session.artifacts.clone()
    };
    let owned_bytes = b"inert owned regular file at the expected artifact directory";
    std::fs::write(&first_artifact, owned_bytes).unwrap();
    {
        let mut state = host.state();
        let session = state.sessions.get_mut(&later).unwrap();
        runtime::private_directory(&session.artifacts).unwrap();
        session.opened = true;
    }
    let foreign = root.path().join("foreign-sentinel");
    std::fs::write(&foreign, b"preserve unrelated synthetic bytes").unwrap();
    let (child, pid) = executor::owned_test_child().await;
    *captured[1].1.executor.lock().await = Some(child);
    assert!(PathBuf::from(format!("/proc/{pid}")).exists());
    assert_eq!(
        host.state().sessions.keys().cloned().collect::<Vec<_>>(),
        captured
            .iter()
            .map(|(project, _)| project.clone())
            .collect::<Vec<_>>()
    );

    assert!(matches!(
        host.shutdown().await,
        Err(Refusal::ExecutorUnavailable)
    ));
    assert!(
        !PathBuf::from(format!("/proc/{pid}")).exists(),
        "later executor was skipped instead of reaped"
    );
    let state = host.state();
    assert!(!state.sessions.contains_key(&later));
    assert!(state.sessions[&first].closing);
    assert!(Arc::ptr_eq(&state.sessions[&first].life, &captured[0].1));
    assert_eq!(std::fs::read(first_artifact).unwrap(), owned_bytes);
    assert!(host.config.runtime.join("sessions").is_dir());
    assert_eq!(
        std::fs::read(foreign).unwrap(),
        b"preserve unrelated synthetic bytes"
    );
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

#[tokio::test]
async fn an_idle_cli_session_closes_with_its_tabs_while_owned_and_recent_ones_stay() {
    let (host, mut queue, _root) = fixture();
    host.reserve("idle", false).unwrap();
    host.reserve("recent", false).unwrap();
    host.create_owned("owned").unwrap();
    let long_ago = Instant::now()
        .checked_sub(IDLE_CLOSE + Duration::from_secs(1))
        .unwrap();
    {
        let mut state = host.state();
        for project in ["idle", "recent", "owned"] {
            let session = state.sessions.get_mut(project).unwrap();
            runtime::private_directory(&session.artifacts).unwrap();
            session.opened = true;
            if project != "recent" {
                session.used = long_ago;
            }
        }
    }
    let sweep = {
        let host = host.clone();
        tokio::spawn(async move { host.close_idle(Instant::now()).await })
    };
    let release = message(&mut queue).await;
    assert_eq!(release["type"], "release");
    assert_eq!(release["group"], "idle");
    assert_eq!(release["close"], true);
    answer(&host, &release);
    sweep.await.unwrap();
    let state = host.state();
    assert!(!state.sessions.contains_key("idle"));
    assert!(state.sessions.contains_key("recent") && state.sessions.contains_key("owned"));
}

#[tokio::test]
async fn an_execution_after_the_switch_is_refused_for_the_switch_even_once_drained() {
    let (host, _queue, _root) = fixture();
    host.reserve("drained", false).unwrap();
    host.on_control(false);
    assert_eq!(
        host.execution_life("drained", None).err(),
        Some(Refusal::PermissionRequired)
    );
    host.state().sessions.remove("drained");
    assert_eq!(
        host.execution_life("drained", None).err(),
        Some(Refusal::PermissionRequired)
    );
    host.on_control(true);
    assert_eq!(
        host.execution_life("drained", None).err(),
        Some(Refusal::SessionNotFound)
    );
}

#[tokio::test]
async fn a_replacement_whose_life_closes_during_its_release_claims_and_starts_nothing() {
    let (host, mut queue, _root) = fixture();
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
    // An earlier executor ran, so the next start is a replacement that first refreshes its tabs.
    life.started.store(true, Ordering::Release);
    let run = {
        let host = host.clone();
        let life = life.clone();
        tokio::spawn(async move { host.run("project", &life, "inert", 25_000, None).await })
    };
    let release = message(&mut queue).await;
    assert_eq!(release["type"], "release");
    assert_eq!(release["close"], false);
    // The owner turns control off and on while that release is answered.
    host.on_control(false);
    host.on_control(true);
    answer(&host, &release);
    assert_eq!(run.await.unwrap().err(), Some(Refusal::PermissionRequired));
    // No claim reached the extension and no executor started.
    assert!(queue.try_recv().is_err());
    assert!(life.executor.lock().await.is_none());
    // The closed life is still drained by its own strict release.
    let drained = {
        let host = host.clone();
        tokio::spawn(async move { host.drain_closing().await })
    };
    let close = message(&mut queue).await;
    assert_eq!(close["type"], "release");
    answer(&host, &close);
    drained.await.unwrap();
    assert!(!host.state().sessions.contains_key("project"));
    host.shutdown().await.unwrap();
}

#[tokio::test]
async fn an_extension_of_another_contract_admits_nothing_and_confirms_no_close() {
    let (host, mut queue, _root) = fixture();
    let life = host.reserve("legacy", false).unwrap();
    {
        let mut state = host.state();
        let session = state.sessions.get_mut("legacy").unwrap();
        runtime::private_directory(&session.artifacts).unwrap();
        session.opened = true;
    }
    // An extension that announces another contract connects.
    host.on_extension(json!({
        "type": "hello",
        "enabled": true,
        "version": "0.0.4",
        "userAgent": "Chrome/157.0.0.0",
        "contract": 1,
    }));
    assert!(matches!(
        host.reserve("other", false),
        Err(Refusal::ExtensionUnavailable)
    ));
    // Closing still attempts the release, but that extension's acknowledgement confirms nothing.
    let closing = {
        let host = host.clone();
        tokio::spawn(async move { host.close("legacy", false).await })
    };
    let release = message(&mut queue).await;
    assert_eq!(release["type"], "release");
    answer(&host, &release);
    assert_eq!(closing.await.unwrap(), Err(Refusal::ExtensionUnavailable));
    assert!(host.state().sessions.contains_key("legacy"));
    assert!(life.stop.is_cancelled());
}

#[tokio::test]
async fn any_other_contract_seals_open_lives_and_a_later_supported_hello_revives_none() {
    for contract in [json!(1), json!(null), json!(3), json!("2"), json!(true)] {
        let (host, mut queue, _root) = fixture();
        let handle = host.create_owned("project").unwrap();
        let life = host
            .session_life("project", Some(&handle.generation))
            .unwrap();
        let _client = opened_client(&host, &handle, 1);
        let mut hello = json!({ "type": "hello", "enabled": true, "version": "0.0.5" });
        if !contract.is_null() {
            hello["contract"] = contract.clone();
        }
        host.on_extension(hello);
        // The bound client's target creation is refused before anything reaches the extension.
        let opened = host
            .session_request(
                "project",
                1,
                json!({ "type": "open", "group": "project", "url": "about:blank" }),
            )
            .await;
        assert!(opened.is_err(), "contract {contract}");
        assert!(queue.try_recv().is_err(), "contract {contract}");
        assert!(life.stop.is_cancelled(), "contract {contract}");
        // The supported extension connects later; the sealed life stays closing and drains.
        host.on_extension(
            json!({ "type": "hello", "enabled": true, "version": "0.0.5", "contract": 2 }),
        );
        assert!(host.state().sessions["project"].closing);
        assert!(
            host.session_request(
                "project",
                1,
                json!({ "type": "open", "group": "project", "url": "about:blank" })
            )
            .await
            .is_err()
        );
        let drained = {
            let host = host.clone();
            tokio::spawn(async move { host.drain_closing().await })
        };
        let release = message(&mut queue).await;
        assert_eq!(release["type"], "release");
        answer(&host, &release);
        drained.await.unwrap();
        assert!(!host.state().sessions.contains_key("project"));
    }
}

// A finished agent download is copied into its session, handed to `NDS.takeDownload` once, and
// only then is the browser's copy let go; a failed one answers its error.
#[tokio::test]
async fn an_agent_download_is_kept_in_its_session_before_the_browser_copy_goes() {
    let (host, mut queue, root) = fixture();
    host.state().downloads = true;
    host.reserve("files", false).unwrap();
    let browser = root.path().join("browser-folder");
    std::fs::create_dir_all(&browser).unwrap();
    let source = browser.join("report.pdf");
    std::fs::write(&source, b"%PDF report").unwrap();
    let urls = json!(["http://site/export", "http://cdn/report.pdf"]);
    let waiting = {
        let host = host.clone();
        tokio::spawn(async move {
            host.take_download(
                "files",
                &json!({ "url": "http://cdn/report.pdf", "waitMs": 5000 }),
            )
            .await
        })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    host.on_extension(json!({
        "type": "download", "group": "files", "id": 7, "urls": urls, "state": "complete",
        "path": source.to_str().unwrap(),
    }));
    let Ok(kept) = waiting.await.unwrap() else {
        panic!("refused")
    };
    let file = PathBuf::from(kept["file"].as_str().unwrap());
    assert!(file.starts_with(root.path().join("runtime/sessions/files/.downloads")));
    assert_eq!(std::fs::read(&file).unwrap(), b"%PDF report");
    let forget = message(&mut queue).await;
    assert_eq!(forget["type"], "forget");
    assert_eq!(forget["download"], 7);
    // Taken once: the same URL now waits for another download.
    let again = host
        .take_download(
            "files",
            &json!({ "url": "http://site/export", "waitMs": 0 }),
        )
        .await
        .unwrap_or_else(|_| panic!("refused"));
    assert_eq!(again, json!({ "pending": true, "copying": false }));
    host.on_extension(json!({
        "type": "download", "group": "files", "id": 8, "urls": ["http://site/gone"],
        "state": "interrupted", "error": "NETWORK_FAILED",
    }));
    let failed = host
        .take_download("files", &json!({ "url": "http://site/gone", "waitMs": 0 }))
        .await
        .unwrap_or_else(|_| panic!("refused"));
    assert_eq!(failed, json!({ "error": "interrupted" }));
    // The kept file moved out of the browser's folder; another session's download, a new file
    // there, never reaches this one, and nothing is let go for it.
    assert!(!source.exists());
    std::fs::write(&source, b"%PDF other").unwrap();
    host.on_extension(json!({
        "type": "download", "group": "elsewhere", "id": 9, "urls": ["http://site/other"],
        "state": "complete", "path": source.to_str().unwrap(),
    }));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(queue.try_recv().is_err());
    assert!(source.exists());
}

#[tokio::test]
async fn an_extension_that_cannot_name_download_files_answers_unsupported() {
    let (host, _queue, _root) = fixture();
    host.reserve("files", false).unwrap();
    let answer = host
        .take_download(
            "files",
            &json!({ "url": "http://site/export", "waitMs": 5000 }),
        )
        .await
        .unwrap_or_else(|_| panic!("refused"));
    assert_eq!(answer, json!({ "unsupported": true }));
}
