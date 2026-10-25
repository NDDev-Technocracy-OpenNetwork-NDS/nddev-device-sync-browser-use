//! The Chrome-spawned native messaging host.
//!
//! Chrome starts it for the pinned NDS extension and keeps it while the
//! extension's port is open. It owns all sessions; when the port closes every
//! executor stops, agent tabs are released by the extension and the private
//! sockets are removed.

mod executor;
mod relay;

use crate::{
    EXTENSION_IDS, IoError,
    protocol::{
        self, Document, FRAME_LIMIT, Header, MAX_SESSIONS, MAX_TABS, PAYLOAD_LIMIT, Refusal, Reply,
        Request,
    },
    runtime, view,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::{Semaphore, mpsc, oneshot},
};

/// Chrome accepts at most 1 MiB per message from a host.
const TO_EXTENSION_LIMIT: usize = 1_048_576;
/// Chrome sends at most 64 MiB; large CDP results (screenshots) stay well below this.
const FROM_EXTENSION_LIMIT: usize = 32 * 1_048_576;
const EXTENSION_REPLY: Duration = Duration::from_secs(30);
const CONTROL_CONNECTIONS: usize = 16;
const CONTROL_IO: Duration = Duration::from_secs(5);
const URL_LIMIT: usize = 2048;
const TITLE_LIMIT: usize = 256;

/// Local installation paths; never operator credentials.
pub struct Config {
    pub runtime: PathBuf,
    pub bun: PathBuf,
    pub executor: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("the caller is not the pinned NDS extension")]
    Origin,
    #[error("another browser-use host owns the runtime directory")]
    Busy,
    #[error(transparent)]
    Io(#[from] IoError),
}

pub(crate) enum Failure {
    Refused(Refusal),
    /// A CDP error object from Chrome, returned verbatim to the session client.
    Cdp(Value),
}

/// Who receives the extension's answer to one request.
pub(crate) enum Waiter {
    Reply(oneshot::Sender<Result<Value, Failure>>),
    /// A client's CDP command. Its reply is queued from the extension reader,
    /// so responses and events reach the client in the order Chrome sent them.
    Forward(relay::Forward),
}

pub(crate) struct Host {
    config: Config,
    cdp_socket: PathBuf,
    outbound: mpsc::Sender<Vec<u8>>,
    pending: Mutex<HashMap<u64, Waiter>>,
    next_request: AtomicU64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    connected: bool,
    enabled: bool,
    browser: String,
    user_agent: String,
    sessions: HashMap<String, Session>,
    tabs: HashMap<i64, Tab>,
    /// Child CDP sessions (frames, workers) and the agent tab that owns them.
    children: HashMap<String, i64>,
}

struct Session {
    token: String,
    artifacts: PathBuf,
    client: Option<relay::Client>,
    executor: Option<executor::Executor>,
    running: bool,
    /// Raw CDP sessions the current client opened (`newCDPSession`); they end
    /// with the client, the session or their tab.
    aliases: HashMap<String, relay::Alias>,
}

struct Tab {
    project: String,
    info: Value,
    target: String,
    document: Option<String>,
}

pub async fn run(origin: &str, config: Config) -> Result<(), HostError> {
    let admitted = EXTENSION_IDS
        .iter()
        .any(|id| origin == format!("chrome-extension://{id}/"));
    if !admitted {
        return Err(HostError::Origin);
    }
    if !config.bun.is_absolute() || !config.executor.is_absolute() {
        return Err(IoError::InvalidConfiguration.into());
    }
    runtime::private_directory(&config.runtime)?;
    runtime::private_directory(&config.runtime.join("sessions"))?;
    let control = bind(&runtime::control_socket(&config.runtime)?)?;
    let cdp_socket = runtime::cdp_socket(&config.runtime)?;
    let cdp = bind(&cdp_socket)?;
    let (outbound, mut queue) = mpsc::channel::<Vec<u8>>(256);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = queue.recv().await {
            if stdout.write_all(&frame).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    let host = Arc::new(Host {
        config,
        cdp_socket,
        outbound,
        pending: Mutex::default(),
        next_request: AtomicU64::new(1),
        state: Mutex::default(),
    });
    tracing::info!(event.name = "browser.host.started", outcome = "ready");
    let control_task = tokio::spawn(host.clone().serve_control(control));
    let relay_task = tokio::spawn(relay::serve(host.clone(), cdp));
    let sweep_task = tokio::spawn(host.clone().sweep());
    let mut stdin = tokio::io::stdin();
    let ended = loop {
        match read_message(&mut stdin).await {
            Ok(Some(body)) => match serde_json::from_slice(&body) {
                Ok(message) => host.on_extension(message),
                Err(_) => break "invalid_frame",
            },
            Ok(None) => break "extension_closed",
            Err(_) => break "invalid_frame",
        }
    };
    control_task.abort();
    relay_task.abort();
    sweep_task.abort();
    host.shutdown();
    writer.abort();
    tracing::info!(event.name = "browser.host.stopped", outcome = "stopped", error.type = ended);
    Ok(())
}

fn bind(path: &Path) -> Result<UnixListener, HostError> {
    if std::os::unix::net::UnixStream::connect(path).is_ok() {
        return Err(HostError::Busy);
    }
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(IoError::Unavailable.into()),
    }
    let listener = UnixListener::bind(path).map_err(|_| IoError::Unavailable)?;
    runtime::owner_only(path)?;
    Ok(listener)
}

async fn read_message<R: AsyncRead + Unpin>(reader: &mut R) -> std::io::Result<Option<Vec<u8>>> {
    let mut length = [0; 4];
    match reader.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let length = u32::from_ne_bytes(length) as usize;
    if length > FROM_EXTENSION_LIMIT {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok(Some(body))
}

/// Native messaging framing: a native-endian u32 length, then UTF-8 JSON.
fn frame(body: &[u8]) -> Option<Vec<u8>> {
    if body.len() > TO_EXTENSION_LIMIT {
        return None;
    }
    let mut framed = Vec::with_capacity(body.len() + 4);
    framed.extend_from_slice(&(body.len() as u32).to_ne_bytes());
    framed.extend_from_slice(body);
    Some(framed)
}

fn tab_session(tab: i64) -> String {
    format!("nds-tab-{tab}")
}

fn token() -> Result<String, Refusal> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| Refusal::ExecutorUnavailable)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn bounded(text: &str, limit: usize) -> String {
    match text.char_indices().nth(limit) {
        Some((index, _)) => text[..index].to_owned(),
        None => text.to_owned(),
    }
}

impl Host {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn pending(&self) -> MutexGuard<'_, HashMap<u64, Waiter>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Queues one message to the extension. Callers that submit in sequence
    /// keep their order, which CDP requires within a session.
    pub(crate) async fn submit(&self, mut message: Value, waiter: Waiter) -> Result<u64, Failure> {
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        message["id"] = id.into();
        let body =
            serde_json::to_vec(&message).map_err(|_| Failure::Refused(Refusal::InvalidRequest))?;
        let framed = frame(&body).ok_or(Failure::Refused(Refusal::PayloadLimit))?;
        self.pending().insert(id, waiter);
        if self.outbound.send(framed).await.is_err() {
            self.pending().remove(&id);
            return Err(Failure::Refused(Refusal::ExtensionUnavailable));
        }
        Ok(id)
    }

    /// One bounded request to the extension with a correlated reply.
    pub(crate) async fn request(&self, message: Value) -> Result<Value, Failure> {
        let (reply, response) = oneshot::channel();
        let id = self.submit(message, Waiter::Reply(reply)).await?;
        match tokio::time::timeout(EXTENSION_REPLY, response).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Failure::Refused(Refusal::ExtensionUnavailable)),
            Err(_) => {
                self.pending().remove(&id);
                Err(Failure::Refused(Refusal::Timeout))
            }
        }
    }

    async fn refusable(&self, message: Value) -> Result<Value, Refusal> {
        self.request(message)
            .await
            .map_err(|failure| match failure {
                Failure::Refused(refusal) => refusal,
                Failure::Cdp(_) => Refusal::TargetClosed,
            })
    }

    fn on_extension(&self, message: Value) {
        match message["type"].as_str() {
            Some("result") => self.on_result(&message),
            Some("event") => self.on_event(message),
            Some("attached") => self.on_attached(&message),
            Some("detached") => self.on_detached(&message),
            Some("hello") => {
                let mut state = self.state();
                state.connected = true;
                state.enabled = message["enabled"].as_bool() == Some(true);
                state.user_agent = bounded(message["userAgent"].as_str().unwrap_or_default(), 512);
                state.browser = state
                    .user_agent
                    .split(' ')
                    .find_map(|part| {
                        part.strip_prefix("Headless")
                            .or(Some(part))
                            .filter(|part| part.starts_with("Chrome/"))
                    })
                    .unwrap_or("Chrome")
                    .to_owned();
                tracing::info!(event.name = "browser.extension.connected", outcome = "ok");
            }
            Some("control") => self.on_control(message["enabled"].as_bool() == Some(true)),
            _ => {
                tracing::warn!(event.name = "browser.extension.message", outcome = "rejected", error.type = "invalid_frame")
            }
        }
    }

    fn on_result(&self, message: &Value) {
        let Some(waiter) = message["id"]
            .as_u64()
            .and_then(|id| self.pending().remove(&id))
        else {
            return;
        };
        let result = match message.get("error") {
            None => Ok(message.get("result").cloned().unwrap_or_else(|| json!({}))),
            Some(error) => Err(match error["code"].as_str() {
                Some("permission_required") => Failure::Refused(Refusal::PermissionRequired),
                Some("target_closed") => Failure::Refused(Refusal::TargetClosed),
                _ => Failure::Cdp(cdp_error(error["message"].as_str().unwrap_or_default())),
            }),
        };
        match waiter {
            Waiter::Reply(reply) => {
                let _ = reply.send(result);
            }
            Waiter::Forward(forward) => self.answer(forward, result),
        }
    }

    /// Delivers a forwarded command's reply to the client that sent it.
    pub(crate) fn answer(&self, forward: relay::Forward, result: Result<Value, Failure>) {
        let reply = relay::reply(forward.id.clone(), Some(forward.session.clone()), result);
        self.reply_to(&forward.project, forward.client, reply);
    }

    /// Queues a message for one specific client connection, if it is still current.
    pub(crate) fn reply_to(&self, project: &str, client: u64, message: Value) {
        let mut state = self.state();
        let current = state
            .sessions
            .get(project)
            .and_then(|session| session.client.as_ref())
            .is_some_and(|current| current.id == client);
        if current {
            deliver(&mut state, project, message);
        }
    }

    /// Replies that Chrome never answered fail visibly instead of waiting forever.
    async fn sweep(self: Arc<Self>) {
        let mut interval = tokio::time::interval(Duration::from_secs(5));
        loop {
            interval.tick().await;
            let now = Instant::now();
            let expired: Vec<relay::Forward> = {
                let mut pending = self.pending();
                let ids: Vec<u64> = pending
                    .iter()
                    .filter(|(_, waiter)| matches!(waiter, Waiter::Forward(forward) if forward.deadline <= now))
                    .map(|(id, _)| *id)
                    .collect();
                ids.into_iter()
                    .filter_map(|id| match pending.remove(&id) {
                        Some(Waiter::Forward(forward)) => Some(forward),
                        _ => None,
                    })
                    .collect()
            };
            for forward in expired {
                self.answer(forward, Err(Failure::Refused(Refusal::Timeout)));
            }
        }
    }

    fn on_event(&self, message: Value) {
        let Some(tab) = message["tab"].as_i64() else {
            return;
        };
        let child = message["session"].as_str().map(str::to_owned);
        let method = message["method"].as_str().unwrap_or_default();
        let params = &message["params"];
        let mut state = self.state();
        let Some(entry) = state.tabs.get_mut(&tab) else {
            return;
        };
        if child.is_none()
            && method == "Page.frameNavigated"
            && params["frame"]["parentId"].is_null()
        {
            entry.document = params["frame"]["loaderId"].as_str().map(str::to_owned);
        }
        let project = entry.project.clone();
        match (method, params["sessionId"].as_str()) {
            ("Target.attachedToTarget", Some(id)) if state.children.len() < 4096 => {
                state.children.insert(id.to_owned(), tab);
            }
            ("Target.detachedFromTarget", Some(id)) => {
                state.children.remove(id);
            }
            _ => {}
        }
        // Raw CDP sessions on this tab receive its top-level events as well.
        let aliases: Vec<String> = match (&child, state.sessions.get(&project)) {
            (None, Some(session)) => relay::tab_aliases(session, tab),
            _ => Vec::new(),
        };
        for alias in aliases {
            let event = json!({ "method": method, "params": params, "sessionId": alias });
            deliver(&mut state, &project, event);
        }
        let session = child.unwrap_or_else(|| tab_session(tab));
        let event = json!({ "method": method, "params": params, "sessionId": session });
        deliver(&mut state, &project, event);
    }

    fn on_attached(&self, message: &Value) {
        let (Some(tab), Some(project)) = (message["tab"].as_i64(), message["group"].as_str())
        else {
            return;
        };
        let mut state = self.state();
        // Chrome's own targetInfo carries the real openerId for popups.
        if !self.register(&mut state, project, tab, message["target"].clone()) {
            return;
        }
        tracing::info!(event.name = "browser.target.attached", outcome = "ok");
    }

    /// Records an agent tab and announces it once to an auto-attaching client.
    fn register(&self, state: &mut State, project: &str, tab: i64, info: Value) -> bool {
        let Some(target) = info["targetId"].as_str().map(str::to_owned) else {
            return false;
        };
        if state.tabs.contains_key(&tab) {
            return true;
        }
        let owned = state
            .tabs
            .values()
            .filter(|entry| entry.project == project)
            .count();
        if owned >= MAX_TABS {
            tracing::warn!(event.name = "browser.target.attached", outcome = "rejected", error.type = "capacity");
            return false;
        }
        let event = relay::attached_event(tab, &info);
        state.tabs.insert(
            tab,
            Tab {
                project: project.to_owned(),
                info,
                target,
                document: None,
            },
        );
        if state
            .sessions
            .get(project)
            .and_then(|session| session.client.as_ref())
            .is_some_and(|client| client.auto_attach)
        {
            deliver(state, project, event);
        }
        true
    }

    fn on_detached(&self, message: &Value) {
        let Some(tab) = message["tab"].as_i64() else {
            return;
        };
        let reason = match message["reason"].as_str() {
            Some("canceled_by_user") => "canceled_by_user",
            Some("revoked") => "revoked",
            _ => "target_closed",
        };
        let mut state = self.state();
        let Some(entry) = state.tabs.remove(&tab) else {
            return;
        };
        state.children.retain(|_, owner| *owner != tab);
        for event in relay::close_aliases(&mut state, &entry.project, tab, &entry.target) {
            deliver(&mut state, &entry.project, event);
        }
        let event = json!({
            "method": "Target.detachedFromTarget",
            "params": { "sessionId": tab_session(tab), "targetId": entry.target },
        });
        deliver(&mut state, &entry.project, event);
        tracing::info!(event.name = "browser.target.detached", outcome = "stopped", error.type = reason);
    }

    /// The owner's switch. Disabling ends every session: clients disconnect,
    /// executors stop and agents must open a new session after re-enabling.
    fn on_control(&self, enabled: bool) {
        let mut state = self.state();
        state.enabled = enabled;
        if !enabled {
            state.tabs.clear();
            state.children.clear();
            for (_, session) in state.sessions.drain() {
                let _ = std::fs::remove_dir_all(&session.artifacts);
            }
        }
        let name = if enabled {
            "browser.control.enabled"
        } else {
            "browser.control.disabled"
        };
        tracing::info!(event.name = name, outcome = "ok");
    }

    fn shutdown(&self) {
        let mut state = self.state();
        state.sessions.clear();
        state.tabs.clear();
        drop(state);
        self.pending().clear();
        let _ = runtime::control_socket(&self.config.runtime).map(std::fs::remove_file);
        let _ = std::fs::remove_file(&self.cdp_socket);
        let _ = std::fs::remove_dir_all(self.config.runtime.join("sessions"));
    }

    async fn serve_control(self: Arc<Self>, listener: UnixListener) {
        let permits = Arc::new(Semaphore::new(CONTROL_CONNECTIONS));
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(permit) = permits.clone().try_acquire_owned() else {
                tracing::warn!(
                    event.name = "browser.control.rejected",
                    outcome = "rejected",
                    resource = "connections",
                    rejected_count = 1u64
                );
                continue;
            };
            let host = self.clone();
            tokio::spawn(async move {
                let _permit = permit;
                host.control(stream).await;
            });
        }
    }

    async fn control(&self, stream: UnixStream) {
        let (read, mut write) = stream.into_split();
        let mut reader = BufReader::new(read);
        let mut line = Vec::new();
        let request = match tokio::time::timeout(
            CONTROL_IO,
            (&mut reader)
                .take(FRAME_LIMIT as u64)
                .read_until(b'\n', &mut line),
        )
        .await
        {
            Ok(Ok(_)) if line.pop() == Some(b'\n') => serde_json::from_slice::<Request>(&line).ok(),
            _ => None,
        };
        let reply = match request {
            None => Reply::Refused {
                refusal: Refusal::InvalidRequest,
            },
            Some(Request::Execute {
                project,
                code,
                timeout_ms,
                expect,
            }) => {
                // A client that disconnects cancels the run; dropping the
                // execution future kills its executor before any later action.
                let mut probe = [0u8; 1];
                tokio::select! {
                    reply = self.execute(&project, &code, timeout_ms, expect) => reply,
                    _ = reader.read(&mut probe) => return,
                }
            }
            Some(request) => self.handle(request).await,
        };
        let payload = serde_json::to_vec(&reply)
            .ok()
            .filter(|payload| payload.len() <= PAYLOAD_LIMIT)
            .unwrap_or_else(|| br#"{"result":"refused","refusal":"payload_limit"}"#.to_vec());
        let mut header = serde_json::to_vec(&Header {
            bytes: payload.len(),
        })
        .unwrap_or_default();
        header.push(b'\n');
        let _ = tokio::time::timeout(CONTROL_IO, async {
            write.write_all(&header).await?;
            write.write_all(&payload).await?;
            write.flush().await
        })
        .await;
    }

    async fn handle(&self, request: Request) -> Reply {
        let result = match request {
            Request::Status => {
                let state = self.state();
                Ok(Reply::Status(view::Status {
                    enabled: state.enabled,
                    browser: state.browser.clone(),
                    sessions: state.sessions.len(),
                }))
            }
            Request::Open { project } => self.open(&project).await.map(Reply::Session),
            Request::Sessions => {
                let state = self.state();
                let sessions = state
                    .sessions
                    .keys()
                    .map(|project| view_session(&state, project))
                    .collect();
                Ok(Reply::Sessions { sessions })
            }
            Request::Close {
                project,
                close_tabs,
            } => self
                .close(&project, close_tabs)
                .await
                .map(|()| Reply::Closed),
            Request::Execute { .. } => Err(Refusal::InvalidRequest),
        };
        result.unwrap_or_else(|refusal| Reply::Refused { refusal })
    }

    fn ready(state: &State) -> Result<(), Refusal> {
        if !state.connected {
            return Err(Refusal::ExtensionUnavailable);
        }
        if !state.enabled {
            return Err(Refusal::PermissionRequired);
        }
        Ok(())
    }

    async fn open(&self, project: &str) -> Result<view::Session, Refusal> {
        if !protocol::valid_project(project) {
            return Err(Refusal::InvalidProject);
        }
        let artifacts = self.config.runtime.join("sessions").join(project);
        {
            let mut state = self.state();
            Self::ready(&state)?;
            if state.sessions.contains_key(project) {
                return Ok(view_session(&state, project));
            }
            if state.sessions.len() >= MAX_SESSIONS {
                tracing::warn!(event.name = "browser.session.opened", outcome = "rejected", error.type = Refusal::Capacity.code());
                return Err(Refusal::Capacity);
            }
            runtime::private_directory(&artifacts).map_err(|_| Refusal::ExecutorUnavailable)?;
            let session = Session {
                token: token()?,
                artifacts,
                client: None,
                executor: None,
                running: false,
                aliases: HashMap::new(),
            };
            state.sessions.insert(project.to_owned(), session);
        }
        // Reclaim the project's existing agent group, for example after a host restart.
        match self
            .refusable(json!({ "type": "claim", "group": project }))
            .await
        {
            Ok(claimed) => {
                let mut state = self.state();
                for entry in claimed["tabs"].as_array().into_iter().flatten() {
                    if let Some(tab) = entry["tab"].as_i64() {
                        self.register(&mut state, project, tab, entry["target"].clone());
                    }
                }
                tracing::info!(event.name = "browser.session.opened", outcome = "ok");
                Ok(view_session(&state, project))
            }
            Err(refusal) => {
                if let Some(session) = self.state().sessions.remove(project) {
                    let _ = std::fs::remove_dir_all(session.artifacts);
                }
                tracing::warn!(event.name = "browser.session.opened", outcome = "rejected", error.type = refusal.code());
                Err(refusal)
            }
        }
    }

    async fn close(&self, project: &str, close_tabs: bool) -> Result<(), Refusal> {
        let session = {
            let mut state = self.state();
            let session = state
                .sessions
                .remove(project)
                .ok_or(Refusal::SessionNotFound)?;
            let tabs: Vec<i64> = state
                .tabs
                .iter()
                .filter(|(_, tab)| tab.project == project)
                .map(|(id, _)| *id)
                .collect();
            for tab in tabs {
                state.tabs.remove(&tab);
                state.children.retain(|_, owner| *owner != tab);
            }
            session
        };
        let _ = std::fs::remove_dir_all(&session.artifacts);
        drop(session);
        let released = self
            .refusable(json!({ "type": "release", "group": project, "close": close_tabs }))
            .await;
        tracing::info!(event.name = "browser.session.closed", outcome = "ok");
        released.map(|_| ())
    }

    async fn execute(
        &self,
        project: &str,
        code: &str,
        timeout_ms: u64,
        expect: Option<Document>,
    ) -> Reply {
        let start = Instant::now();
        let result = self.run(project, code, timeout_ms, expect).await;
        let duration_ms = start.elapsed().as_millis() as u64;
        match &result {
            Ok(outcome) => match outcome.failure {
                None => tracing::info!(
                    event.name = "browser.execute.completed",
                    outcome = "ok",
                    duration_ms
                ),
                Some(failure) => {
                    tracing::info!(event.name = "browser.execute.completed", outcome = "error", error.type = failure.code(), duration_ms)
                }
            },
            Err(refusal) => {
                tracing::warn!(event.name = "browser.execute.completed", outcome = "rejected", error.type = refusal.code(), duration_ms)
            }
        }
        match result {
            Ok(outcome) => Reply::Executed(outcome),
            Err(refusal) => Reply::Refused { refusal },
        }
    }

    async fn run(
        &self,
        project: &str,
        code: &str,
        timeout_ms: u64,
        expect: Option<Document>,
    ) -> Result<view::Outcome, Refusal> {
        if !protocol::valid_execution(timeout_ms) || code.trim().is_empty() {
            return Err(Refusal::InvalidRequest);
        }
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let (current, token, artifacts) = {
            let mut state = self.state();
            Self::ready(&state)?;
            if let Some(expect) = &expect {
                let tab = state
                    .tabs
                    .values()
                    .find(|tab| tab.project == project && tab.target == expect.target)
                    .ok_or(Refusal::TargetClosed)?;
                if tab.document.as_deref() != Some(expect.document.as_str()) {
                    return Err(Refusal::StaleDocument);
                }
            }
            let session = state
                .sessions
                .get_mut(project)
                .ok_or(Refusal::SessionNotFound)?;
            if session.running {
                return Err(Refusal::Busy);
            }
            session.running = true;
            (
                session.executor.take(),
                session.token.clone(),
                session.artifacts.clone(),
            )
        };
        let _running = Running {
            host: self,
            project,
        };
        let mut executor = match current {
            Some(executor) => executor,
            None => {
                let endpoint = format!("ws+unix://{}:/session/{token}", self.cdp_socket.display());
                executor::Executor::spawn(&self.config, &endpoint, &artifacts, deadline).await?
            }
        };
        // A timeout drops the executor here, which kills it: no action continues.
        let (failure, output, truncated) = match executor.run(code, deadline).await {
            Ok(completed) => completed,
            // Revocation disconnects the executor mid-run; report the cause.
            Err(Refusal::ExecutorUnavailable) if !self.state().enabled => {
                return Err(Refusal::PermissionRequired);
            }
            Err(refusal) => return Err(refusal),
        };
        let tabs = self.tabs(project).await;
        if let Some(session) = self
            .state()
            .sessions
            .get_mut(project)
            .filter(|session| session.token == token)
        {
            session.executor = Some(executor);
        }
        Ok(view::Outcome {
            failure,
            output,
            truncated,
            tabs,
        })
    }

    /// Current agent tabs; Chrome's live answer also refreshes each document.
    async fn tabs(&self, project: &str) -> Vec<view::Tab> {
        let ids: Vec<i64> = {
            let state = self.state();
            let mut ids: Vec<i64> = state
                .tabs
                .iter()
                .filter(|(_, tab)| tab.project == project)
                .map(|(id, _)| *id)
                .collect();
            ids.sort_unstable();
            ids
        };
        let live = self
            .refusable(json!({ "type": "tabs", "tabs": ids }))
            .await
            .unwrap_or_default();
        let mut state = self.state();
        ids.iter()
            .filter_map(|id| {
                let entry = live["tabs"]
                    .as_array()
                    .and_then(|tabs| tabs.iter().find(|entry| entry["tab"].as_i64() == Some(*id)));
                let tab = state.tabs.get_mut(id)?;
                if let Some(document) = entry.and_then(|entry| entry["document"].as_str()) {
                    tab.document = Some(document.to_owned());
                }
                Some(view::Tab {
                    target: tab.target.clone(),
                    document: tab.document.clone(),
                    url: bounded(
                        entry
                            .and_then(|entry| entry["url"].as_str())
                            .unwrap_or_default(),
                        URL_LIMIT,
                    ),
                    title: bounded(
                        entry
                            .and_then(|entry| entry["title"].as_str())
                            .unwrap_or_default(),
                        TITLE_LIMIT,
                    ),
                })
            })
            .collect()
    }
}

/// Clears the session's running flag however the execution ends.
struct Running<'a> {
    host: &'a Host,
    project: &'a str,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        if let Some(session) = self.host.state().sessions.get_mut(self.project) {
            session.running = false;
        }
    }
}

fn view_session(state: &State, project: &str) -> view::Session {
    view::Session {
        project: project.to_owned(),
        tabs: state
            .tabs
            .values()
            .filter(|tab| tab.project == project)
            .count(),
        executor: state
            .sessions
            .get(project)
            .is_some_and(|session| session.executor.is_some()),
    }
}

/// Sends an event to the project's client; a client that cannot keep up is
/// disconnected rather than silently missing events.
fn deliver(state: &mut State, project: &str, event: Value) {
    let Some(session) = state.sessions.get_mut(project) else {
        return;
    };
    if session
        .client
        .as_ref()
        .is_some_and(|client| !client.send(&event))
    {
        session.client = None;
        session.executor = None;
        tracing::warn!(event.name = "browser.client.dropped", outcome = "error", error.type = "queue_full", dropped_count = 1u64);
    }
}

fn cdp_error(message: &str) -> Value {
    serde_json::from_str::<Value>(message)
        .ok()
        .filter(|error| error["code"].is_i64() && error["message"].is_string())
        .unwrap_or_else(|| json!({ "code": -32000, "message": bounded(message, 1024) }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_messages_round_trip_and_reject_oversized_frames() {
        let framed = frame(br#"{"type":"hello"}"#).unwrap();
        let mut reader = framed.as_slice();
        assert_eq!(
            read_message(&mut reader).await.unwrap().unwrap(),
            br#"{"type":"hello"}"#
        );
        assert!(read_message(&mut reader).await.unwrap().is_none());
        assert!(frame(&vec![b' '; TO_EXTENSION_LIMIT + 1]).is_none());
        let mut oversized = ((FROM_EXTENSION_LIMIT + 1) as u32).to_ne_bytes().to_vec();
        oversized.extend_from_slice(b"{}");
        assert!(read_message(&mut oversized.as_slice()).await.is_err());
    }

    #[test]
    fn chrome_errors_keep_their_protocol_shape() {
        assert_eq!(
            cdp_error(r#"{"code":-32601,"message":"'X' wasn't found"}"#)["code"],
            -32601
        );
        let wrapped = cdp_error("No tab with given id 7.");
        assert_eq!(wrapped["code"], -32000);
        assert_eq!(wrapped["message"], "No tab with given id 7.");
    }

    #[test]
    fn bounded_text_respects_character_boundaries() {
        assert_eq!(bounded("ёжик", 2), "ёж");
        assert_eq!(bounded("abc", 10), "abc");
    }
}
