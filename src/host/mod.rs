//! The Chrome-spawned native messaging host.
//!
//! Chrome starts it for the pinned NDS extension and keeps it while the
//! extension's port is open. It owns all sessions; when the port closes every
//! executor stops, agent tabs are released by the extension and the private
//! sockets are removed.

mod downloads;
mod executor;
mod observation;
mod relay;

use crate::{
    CancellationToken, EXTENSION_IDS, IoError, OwnedSession, UNPACKED_EXTENSION_ID,
    protocol::{
        self, Document, FRAME_LIMIT, Header, MAX_SESSIONS, MAX_TABS, PAYLOAD_LIMIT, Refusal, Reply,
        Request,
    },
    runtime, socket, view,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU8, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{Semaphore, mpsc, oneshot, watch},
};

/// Chrome accepts at most 1 MiB per message from a host.
const TO_EXTENSION_LIMIT: usize = 1_048_576;
/// Chrome sends at most 64 MiB; large CDP results (screenshots) stay well below this.
const FROM_EXTENSION_LIMIT: usize = 32 * 1_048_576;
const EXTENSION_REPLY: Duration = Duration::from_secs(30);
/// A CLI session that runs nothing for this long closes with its tabs, so the tabs of agents that
/// forgot to close their session do not pile up in the owner's browser.
const IDLE_CLOSE: Duration = Duration::from_secs(30 * 60);
const CONTROL_CONNECTIONS: usize = 16;
const CONTROL_IO: Duration = Duration::from_secs(5);
const URL_LIMIT: usize = 2048;
/// The owner's recorder button runs one short execution; an agent's runs make it wait no longer.
const RECORD_MS: u64 = 10_000;
const TITLE_LIMIT: usize = 256;
const CDP_UNCERTAIN: u8 = 1;
const CDP_RELEASED: u8 = 2;

/// Local installation paths; never operator credentials.
pub struct Config {
    pub runtime: PathBuf,
    pub bun: PathBuf,
    pub executor: PathBuf,
    /// The activity journal's root: one directory per project (docs/observability.md).
    pub activity: PathBuf,
    /// The root of the session areas (`runtime::sessions_directory`).
    pub sessions: PathBuf,
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
    Reply {
        send: oneshot::Sender<Result<Value, Failure>>,
        work: Option<PendingWork>,
        deadline: Instant,
    },
    /// A client's CDP command. Its reply is queued from the extension reader,
    /// so responses and events reach the client in the order Chrome sent them.
    Forward(relay::Forward),
}

pub(crate) struct Host {
    config: Config,
    /// Manifest of the installed unpacked build this host can ask to reload.
    installed: Option<PathBuf>,
    cdp_socket: PathBuf,
    outbound: mpsc::Sender<Vec<u8>>,
    pending: Mutex<HashMap<u64, Waiter>>,
    next_request: AtomicU64,
    state: Mutex<State>,
}

/// The one extension contract this host speaks: every cdp and close request names its group,
/// and the worker admits it only for that group's current attachment of the tab.
const CONTRACT: u64 = 2;

#[derive(Default)]
struct State {
    connected: bool,
    enabled: bool,
    /// The contract the connected extension announced; only [`CONTRACT`] is admitted.
    contract: Option<u64>,
    extension: String,
    browser: String,
    user_agent: String,
    sessions: HashMap<String, Session>,
    tabs: HashMap<i64, Tab>,
    /// The connected extension names agent downloads' files (see [`downloads`]).
    downloads: bool,
    /// The owner's observation profile (see [`observation`]).
    observation: observation::Observation,
    /// The owner's private sites, of which the journal keeps no content (`observation::sites`).
    private_sites: Vec<String>,
    /// Child CDP sessions (frames, workers) and the agent tab that owns them.
    children: HashMap<String, i64>,
}

struct Session {
    token: String,
    artifacts: PathBuf,
    client: Option<relay::Client>,
    life: Arc<SessionLife>,
    owned: bool,
    opened: bool,
    closing: bool,
    running: bool,
    /// When the session was reserved or last started or finished an execution.
    used: Instant,
    /// Raw CDP sessions the current client opened (`newCDPSession`); they end
    /// with the client, the session or their tab.
    aliases: HashMap<String, relay::Alias>,
    /// Whether the current client asked for download events; it ends with the client.
    downloads: Option<relay::Downloads>,
    /// Finished downloads the executor has not taken yet.
    files: downloads::Files,
    /// The session's activity journal, opened by its first record (docs/observability.md).
    journal: Option<Arc<Mutex<crate::activity::Writer>>>,
}

struct Tab {
    project: String,
    info: Value,
    target: String,
    document: Option<String>,
}

/// The executor stays owned here even when a request future is dropped.
/// Closing cancels first, then acquires this same operation lock and reaps it.
struct SessionLife {
    generation: String,
    stop: CancellationToken,
    executor: tokio::sync::Mutex<Option<executor::Executor>>,
    close: tokio::sync::Mutex<()>,
    uncertain: std::sync::atomic::AtomicBool,
    pending: watch::Sender<usize>,
    cdp_state: AtomicU8,
    cdp_pending: watch::Sender<usize>,
    /// An executor of this life has started, so the next one to start is a replacement.
    started: std::sync::atomic::AtomicBool,
}

impl SessionLife {
    fn new() -> Result<Self, Refusal> {
        Ok(Self {
            generation: token()?,
            stop: CancellationToken::new(),
            executor: tokio::sync::Mutex::new(None),
            close: tokio::sync::Mutex::new(()),
            uncertain: std::sync::atomic::AtomicBool::new(false),
            pending: watch::channel(0).0,
            cdp_state: AtomicU8::new(0),
            cdp_pending: watch::channel(0).0,
            started: std::sync::atomic::AtomicBool::new(false),
        })
    }
}

/// A submitted browser action stays owned through its actual reply (or loss).
/// Canceling its waiter cannot remove a late action from the drain barrier.
pub(crate) struct PendingWork {
    life: Arc<SessionLife>,
    kind: WorkKind,
    settled: bool,
}

#[derive(Clone, Copy)]
enum WorkKind {
    Mutation,
    Cdp,
}

impl PendingWork {
    fn new(life: Arc<SessionLife>) -> Self {
        Self::with_kind(life, WorkKind::Mutation)
    }
    fn with_kind(life: Arc<SessionLife>, kind: WorkKind) -> Self {
        let work = Self {
            life,
            kind,
            settled: false,
        };
        work.counter().send_modify(|count| *count += 1);
        work
    }
    fn counter(&self) -> &watch::Sender<usize> {
        match self.kind {
            WorkKind::Mutation => &self.life.pending,
            WorkKind::Cdp => &self.life.cdp_pending,
        }
    }
    fn mark_uncertain(&self) {
        match self.kind {
            WorkKind::Mutation => self.life.uncertain.store(true, Ordering::Release),
            WorkKind::Cdp => {
                // A late dropped waiter cannot revive authority that an exact
                // strict release already ended. It never changes mutation state.
                let _ = self.life.cdp_state.compare_exchange(
                    0,
                    CDP_UNCERTAIN,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                );
            }
        }
    }
    pub(crate) fn settle(&mut self) {
        self.settled = true;
    }
    fn released(&mut self) {
        debug_assert!(matches!(self.kind, WorkKind::Cdp));
        // Transport authority ended, not a successful CDP command/website undo.
        self.settled = true;
    }
}
impl Drop for PendingWork {
    fn drop(&mut self) {
        if !self.settled {
            self.mark_uncertain();
        }
        self.counter().send_modify(|count| *count -= 1);
    }
}

/// Whether Chrome started this host for one of the pinned NDS extension builds.
pub fn admitted(origin: &str) -> bool {
    EXTENSION_IDS
        .iter()
        .any(|id| origin == format!("chrome-extension://{id}/"))
}

/// The host Chrome starts for the desktop extension: it speaks native messaging on stdin/stdout.
pub async fn run(origin: &str, config: Config) -> Result<(), HostError> {
    if !admitted(origin) {
        return Err(HostError::Origin);
    }
    let installed = installed_manifest(origin);
    serve(config, installed, tokio::io::stdin(), tokio::io::stdout()).await
}

/// The host over any browser link that speaks the extension's framed protocol: the desktop
/// extension through Chrome's native messaging, or a phone's browser through `crate::mobile`.
pub async fn serve<R, W>(
    config: Config,
    installed: Option<PathBuf>,
    mut input: R,
    mut output: W,
) -> Result<(), HostError>
where
    R: AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    if !config.bun.is_absolute() || !config.executor.is_absolute() {
        return Err(IoError::InvalidConfiguration.into());
    }
    runtime::private_directory(&config.runtime)?;
    let control = bind(&runtime::control_socket(&config.runtime)?)?;
    let cdp_socket = runtime::cdp_socket(&config.runtime)?;
    let cdp = bind(&cdp_socket)?;
    // Owning both sockets proves no other host is alive here, so session areas left by a
    // host that died without its shutdown belong to no session and are removed.
    let sessions = config.sessions.clone();
    match std::fs::remove_dir_all(&sessions) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(IoError::Unavailable.into()),
    }
    runtime::private_tree(&sessions)?;
    let (outbound, mut queue) = mpsc::channel::<Vec<u8>>(256);
    let writer = tokio::spawn(async move {
        while let Some(frame) = queue.recv().await {
            if output.write_all(&frame).await.is_err() || output.flush().await.is_err() {
                break;
            }
        }
    });
    let host = Arc::new(Host {
        installed,
        config,
        cdp_socket,
        outbound,
        pending: Mutex::default(),
        next_request: AtomicU64::new(1),
        state: Mutex::default(),
    });
    tracing::info!(event.name = "browser.host.started", outcome = "ready");
    // The activity journal keeps one week within its size bound (docs/observability.md).
    let journal = host.config.activity.clone();
    tokio::task::spawn_blocking(move || {
        crate::activity::prune(
            &journal,
            std::time::SystemTime::now(),
            crate::activity::TOTAL_BYTES,
        );
    });
    let control_task = tokio::spawn(host.clone().serve_control(control));
    let relay_task = tokio::spawn(relay::serve(host.clone(), cdp));
    let sweep_task = tokio::spawn(host.clone().sweep());
    let ended = loop {
        match read_message(&mut input).await {
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
    let _ = control_task.await;
    let _ = relay_task.await;
    let _ = sweep_task.await;
    let drained = host.shutdown().await;
    writer.abort();
    let _ = writer.await;
    drained.map_err(|_| HostError::Io(IoError::Unavailable))?;
    tracing::info!(event.name = "browser.host.stopped", outcome = "stopped", error.type = ended);
    Ok(())
}

fn bind(path: &Path) -> Result<socket::Listener, HostError> {
    if socket::answers(path) {
        return Err(HostError::Busy);
    }
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(IoError::Unavailable.into()),
    }
    let listener = socket::bind(path).map_err(|_| IoError::Unavailable)?;
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

/// `just install` places `bin/` and `extension/` under one prefix; only the
/// unpacked build reloads from disk, the store build updates through the store.
fn installed_manifest(origin: &str) -> Option<PathBuf> {
    if origin != format!("chrome-extension://{UNPACKED_EXTENSION_ID}/") {
        return None;
    }
    let exe = std::env::current_exe().ok()?;
    let manifest = exe
        .parent()?
        .parent()?
        .join("extension")
        .join("manifest.json");
    manifest.is_file().then_some(manifest)
}

fn installed_version(manifest: &Path) -> Option<String> {
    let bytes = std::fs::read(manifest)
        .ok()
        .filter(|bytes| bytes.len() <= 65_536)?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    let version = value["version"].as_str()?;
    (!version.is_empty()
        && version.len() <= 32
        && version
            .bytes()
            .all(|byte| byte.is_ascii_digit() || byte == b'.'))
    .then(|| version.to_owned())
}

/// The version the running extension should reload to, if any.
fn reload_target(running: &str, installed: Option<String>) -> Option<String> {
    installed.filter(|installed| !running.is_empty() && installed != running)
}

/// The owner's recorder answer for the popup from the execution that ran `recorder.<action>()`:
/// `{ recording, id?, events? }`, or `{ error, message? }` with the refusal's code or the
/// executor's own reason (the recorder needs the full observation profile, for one).
fn owner_recording(reply: &Reply) -> Value {
    match reply {
        Reply::Executed(outcome) if outcome.failure.is_none() => {
            let value = outcome
                .output
                .rfind("[return value] ")
                .and_then(|at| {
                    serde_json::from_str::<Value>(&outcome.output[at + "[return value] ".len()..])
                        .ok()
                })
                .unwrap_or(Value::Null);
            let stopped = value["reason"].is_string();
            let mut answer = json!({ "recording": value["id"].is_string() && !stopped });
            if let Some(id) = value["id"].as_str() {
                answer["id"] = bounded(id, 32).into();
            }
            if let Some(events) = value["events"].as_u64() {
                answer["events"] = events.into();
            }
            answer
        }
        Reply::Executed(outcome) => {
            let reason = outcome
                .output
                .lines()
                .rev()
                .find_map(|line| line.strip_prefix("Error: "))
                .unwrap_or_default();
            json!({ "error": "script_error", "message": bounded(reason, 300) })
        }
        Reply::Refused { refusal } => json!({ "error": refusal.code() }),
        _ => json!({ "error": "invalid_response" }),
    }
}

/// The browser and version a user agent names: `Edge/<version>` for Edge, which names Chrome too,
/// else `Chrome/<version>` (also Brave's and Chromium's, which do not name themselves).
fn browser_name(user_agent: &str) -> String {
    let parts = || user_agent.split(' ');
    if let Some(version) = parts().find_map(|part| part.strip_prefix("Edg/")) {
        return format!("Edge/{version}");
    }
    parts()
        .find_map(|part| {
            part.strip_prefix("Headless")
                .or(Some(part))
                .filter(|part| part.starts_with("Chrome/"))
        })
        .unwrap_or("Chrome")
        .to_owned()
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

    /// The exact current generation/client must still admit this CDP command
    /// when it enters the bounded queue. No await separates that check, pending
    /// registration and enqueue; close fences all later submissions with State.
    pub(crate) fn submit_cdp(
        &self,
        mut message: Value,
        mut forward: relay::Forward,
    ) -> Result<u64, Failure> {
        if !matches!(forward.work.kind, WorkKind::Cdp) || message["type"] != "cdp" {
            forward.work.settle();
            return Err(Failure::Refused(Refusal::InvalidRequest));
        }
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        message["id"] = id.into();
        let framed = serde_json::to_vec(&message)
            .map_err(|_| Failure::Refused(Refusal::InvalidRequest))
            .and_then(|body| frame(&body).ok_or(Failure::Refused(Refusal::PayloadLimit)));
        let framed = match framed {
            Ok(framed) => framed,
            Err(error) => {
                forward.work.settle(); // Known not submitted.
                return Err(error);
            }
        };
        let state = self.state();
        let admitted = state.connected
            && state.enabled
            && state.contract == Some(CONTRACT)
            && state.sessions.get(&forward.project).is_some_and(|session| {
                !session.closing
                    && !session.life.stop.is_cancelled()
                    && Arc::ptr_eq(&session.life, &forward.work.life)
                    && session
                        .client
                        .as_ref()
                        .is_some_and(|client| client.id == forward.client)
            });
        if !admitted {
            forward.work.settle();
            return Err(Failure::Refused(Refusal::SessionNotFound));
        }
        let permit = match self.outbound.try_reserve() {
            Ok(permit) => permit,
            Err(error) => {
                forward.work.settle();
                return Err(Failure::Refused(match error {
                    mpsc::error::TrySendError::Full(_) => Refusal::Busy,
                    mpsc::error::TrySendError::Closed(_) => Refusal::ExtensionUnavailable,
                }));
            }
        };
        self.pending().insert(id, Waiter::Forward(forward));
        permit.send(framed);
        drop(state);
        Ok(id)
    }

    /// One bounded request to the extension with a correlated reply.
    pub(crate) fn session_work(&self, project: &str, client: u64) -> Result<PendingWork, Failure> {
        self.session_work_kind(project, client, WorkKind::Mutation)
    }

    pub(crate) fn session_cdp_work(
        &self,
        project: &str,
        client: u64,
    ) -> Result<PendingWork, Failure> {
        self.session_work_kind(project, client, WorkKind::Cdp)
    }

    fn session_work_kind(
        &self,
        project: &str,
        client: u64,
        kind: WorkKind,
    ) -> Result<PendingWork, Failure> {
        let state = self.state();
        // Every client action, target creation and close included, needs the connected,
        // enabled extension of the supported contract.
        Self::ready(&state).map_err(Failure::Refused)?;
        let session = state
            .sessions
            .get(project)
            .filter(|session| {
                !session.closing
                    && !session.life.stop.is_cancelled()
                    && session
                        .client
                        .as_ref()
                        .is_some_and(|current| current.id == client)
            })
            .ok_or(Failure::Refused(Refusal::SessionNotFound))?;
        Ok(PendingWork::with_kind(session.life.clone(), kind))
    }

    pub(crate) async fn session_request(
        &self,
        project: &str,
        client: u64,
        message: Value,
    ) -> Result<Value, Failure> {
        let work = self.session_work(project, client)?;
        self.request_with_work(message, Some(work)).await
    }

    async fn request_with_work(
        &self,
        message: Value,
        work: Option<PendingWork>,
    ) -> Result<Value, Failure> {
        let (reply, response) = oneshot::channel();
        let id = self
            .submit(
                message,
                Waiter::Reply {
                    send: reply,
                    work,
                    deadline: Instant::now() + EXTENSION_REPLY,
                },
            )
            .await?;
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
        self.refusable_work(message, None).await
    }

    async fn refusable_work(
        &self,
        message: Value,
        work: Option<PendingWork>,
    ) -> Result<Value, Refusal> {
        self.request_with_work(message, work)
            .await
            .map_err(|failure| match failure {
                Failure::Refused(refusal) => refusal,
                Failure::Cdp(_) => Refusal::TargetClosed,
            })
    }

    fn on_extension(self: &Arc<Self>, message: Value) {
        match message["type"].as_str() {
            Some("result") => self.on_result(&message),
            Some("event") => self.on_event(message),
            Some("attached") => self.on_attached(&message),
            Some("detached") => self.on_detached(&message),
            Some("download") => self.on_download(&message),
            Some("telemetry") => match crate::protocol::extension_event(&message) {
                Some(event) => match event.error {
                    None => tracing::info!(event.name = event.name, outcome = event.outcome),
                    Some(error) => {
                        tracing::warn!(event.name = event.name, outcome = event.outcome, error.type = error)
                    }
                },
                None => {
                    tracing::warn!(event.name = "browser.extension.telemetry", outcome = "rejected", error.type = "invalid_event")
                }
            },
            Some("hello") => {
                let mut state = self.state();
                state.connected = true;
                state.enabled = message["enabled"].as_bool() == Some(true);
                state.contract = message["contract"].as_u64();
                state.downloads = message["downloads"].as_bool() == Some(true);
                state.private_sites = observation::sites(&message["private"]);
                let profile = observation::Observation::parse(&message["observation"]);
                state.user_agent = bounded(message["userAgent"].as_str().unwrap_or_default(), 512);
                state.extension = bounded(message["version"].as_str().unwrap_or_default(), 32);
                state.browser = browser_name(&state.user_agent);
                if state.contract == Some(CONTRACT) {
                    tracing::info!(event.name = "browser.extension.connected", outcome = "ok");
                } else {
                    // An extension of another contract may still answer cleanup, but admits nothing,
                    // and the lives it met end here, so a later supported hello revives none.
                    Self::seal(&mut state);
                    tracing::warn!(event.name = "browser.extension.connected", outcome = "rejected", error.type = "contract");
                    // The owner sees it in the popup instead of an extension that silently does
                    // nothing.
                    let body = serde_json::to_vec(
                        &json!({ "type": "incompatible", "contract": CONTRACT }),
                    )
                    .unwrap_or_default();
                    if let Some(framed) = frame(&body) {
                        let _ = self.outbound.try_send(framed);
                    }
                }
                drop(state);
                self.observe(profile);
                self.update();
            }
            Some("private") => self.state().private_sites = observation::sites(&message["sites"]),
            Some("journal") => {
                let host = self.clone();
                tokio::spawn(async move { host.recent(&message).await });
            }
            Some("observation") => {
                self.observe(observation::Observation::parse(&message["profile"]))
            }
            Some("control") => self.on_control(message["enabled"].as_bool() == Some(true)),
            Some("record") => {
                let host = self.clone();
                tokio::spawn(async move { host.record(&message).await });
            }
            // The extension gave up adopting a new agent tab after its retries.
            Some("adoption") => {
                let class = match message["failure"].as_str() {
                    Some("tab") => "tab_missing",
                    Some("group") => "group_failed",
                    Some("attach") => "attach_failed",
                    _ => "invalid_frame",
                };
                tracing::warn!(event.name = "browser.target.attached", outcome = "error", error.type = class);
            }
            _ => {
                tracing::warn!(event.name = "browser.extension.message", outcome = "rejected", error.type = "invalid_frame")
            }
        }
    }

    /// The owner's recorder button in the extension's popup, for the agent group of the owner's
    /// tab: starts, stops or reads that session's recorder the way `recorder start|stop|status`
    /// does for an agent, as one of the session's executions. The answer names the recording and
    /// its event count, or why it did not run, such as an execution of the agent in progress.
    async fn record(&self, message: &Value) {
        let Some(action) = message["action"]
            .as_str()
            .filter(|action| matches!(*action, "start" | "stop" | "status"))
        else {
            return;
        };
        let project = message["group"].as_str().unwrap_or_default();
        let code = format!("return JSON.stringify(await recorder.{action}())");
        let reply = match self.execution_life(project, None) {
            Ok(life) => self.execute(project, &life, &code, RECORD_MS, None).await,
            Err(refusal) => Reply::Refused { refusal },
        };
        let mut answer = owner_recording(&reply);
        answer["type"] = "recorded".into();
        answer["request"] = message["request"].clone();
        let sent = serde_json::to_vec(&answer)
            .ok()
            .and_then(|body| frame(&body))
            .is_some_and(|framed| self.outbound.try_send(framed).is_ok());
        let outcome = if answer.get("error").is_none() {
            "ok"
        } else {
            "rejected"
        };
        tracing::info!(
            event.name = "browser.recorder.owner",
            outcome = if sent { outcome } else { "error" }
        );
    }

    /// Asks an unpacked extension to reload when its installed files are newer.
    fn update(&self) -> bool {
        let installed = self.installed.as_deref().and_then(installed_version);
        let Some(version) = reload_target(&self.state().extension, installed) else {
            return false;
        };
        let body = serde_json::to_vec(&json!({ "type": "reload", "version": version }))
            .unwrap_or_default();
        let sent = frame(&body).is_some_and(|framed| self.outbound.try_send(framed).is_ok());
        tracing::info!(
            event.name = "browser.extension.reload",
            outcome = if sent { "pending" } else { "error" }
        );
        sent
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
                Some("capacity") => Failure::Refused(Refusal::Capacity),
                _ => Failure::Cdp(cdp_error(error["message"].as_str().unwrap_or_default())),
            }),
        };
        match waiter {
            Waiter::Reply { send, mut work, .. } => {
                if let Some(work) = &mut work {
                    work.settle();
                }
                let _ = send.send(result);
            }
            Waiter::Forward(forward) => self.answer(forward, result),
        }
    }

    /// Delivers a forwarded command's reply to the client that sent it.
    pub(crate) fn answer(&self, mut forward: relay::Forward, result: Result<Value, Failure>) {
        forward.work.settle();
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
            self.expire_pending(Instant::now());
            // Reuse this owned host task for switch/overflow cleanup. No detached cleanup.
            self.drain_closing().await;
            self.tick_journals();
            self.close_idle(Instant::now()).await;
        }
    }

    /// Closes, with their tabs, the opened CLI sessions that ran nothing for `IDLE_CLOSE`. Owned
    /// sessions belong to the NDS component that composes them, which closes them itself.
    async fn close_idle(&self, now: Instant) {
        let idle: Vec<(String, Arc<SessionLife>)> = self
            .state()
            .sessions
            .iter()
            .filter(|(_, session)| {
                !session.owned
                    && session.opened
                    && !session.closing
                    && !session.running
                    && now.duration_since(session.used) >= IDLE_CLOSE
            })
            .map(|(project, session)| (project.clone(), session.life.clone()))
            .collect();
        for (project, life) in idle {
            let closed = self.close_generation(&project, &life, true, true).await;
            let outcome = if closed.is_ok() { "stopped" } else { "error" };
            tracing::info!(event.name = "browser.session.idle", outcome);
        }
    }

    fn expire_pending(&self, now: Instant) {
        let expired: Vec<Waiter> = {
            let mut pending = self.pending();
            let ids: Vec<u64> = pending
                .iter()
                .filter(|(_, waiter)| match waiter {
                    Waiter::Forward(forward) => forward.deadline <= now,
                    Waiter::Reply { deadline, .. } => *deadline <= now,
                })
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect()
        };
        for waiter in expired {
            match waiter {
                Waiter::Forward(forward) => {
                    forward.work.mark_uncertain();
                    self.answer(forward, Err(Failure::Refused(Refusal::Timeout)));
                }
                Waiter::Reply { send, .. } => {
                    let _ = send.send(Err(Failure::Refused(Refusal::Timeout)));
                }
            }
        }
    }

    fn release_cdp(&self, life: &Arc<SessionLife>) {
        // State already fenced submissions for this exact generation before
        // Chrome's strict release. Retire only its transport waiters; do not
        // manufacture a command result or touch a lifecycle mutation/other life.
        life.cdp_state.store(CDP_RELEASED, Ordering::Release);
        self.pending().retain(|_, waiter| {
            if let Waiter::Forward(forward) = waiter
                && matches!(forward.work.kind, WorkKind::Cdp)
                && Arc::ptr_eq(&forward.work.life, life)
            {
                forward.work.released();
                false
            } else {
                true
            }
        });
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
        if method == "Page.javascriptDialogOpening" {
            // Dialogs are journaled here, not by a Playwright listener, which would keep them open.
            let raw = json!({ "type": "dialog", "tab": tab, "kind": params["type"], "text": params["message"] });
            Self::journal(&mut state, &self.config.activity, &project, &[raw]);
        }
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
        // A frame of another site downloads through its own child session; Playwright finds the
        // page by the frame either way.
        if let Some(event) = relay::download_event(&mut state, &project, method, params) {
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

    /// The owner's switch immediately denies new work and cancels sessions.
    /// The owned sweep awaits resource cleanup; this notification is no drain ACK.
    fn on_control(&self, enabled: bool) {
        let mut state = self.state();
        state.enabled = enabled;
        if !enabled {
            Self::seal(&mut state);
        }
        let name = if enabled {
            "browser.control.enabled"
        } else {
            "browser.control.disabled"
        };
        tracing::info!(event.name = name, outcome = "ok");
    }

    /// Ends every current life: none acts again, and each is drained by its own strict release.
    /// A later switch or hello never revives one.
    fn seal(state: &mut State) {
        state.tabs.clear();
        state.children.clear();
        for session in state.sessions.values_mut() {
            session.closing = true;
            session.life.stop.cancel();
            session.client = None;
        }
    }

    async fn shutdown(&self) -> Result<(), Refusal> {
        {
            let mut state = self.state();
            state.connected = false;
            state.enabled = false;
            for session in state.sessions.values_mut() {
                session.closing = true;
                session.life.stop.cancel();
                session.client = None;
            }
        }
        self.pending().clear();
        let sessions: Vec<(String, Arc<SessionLife>)> = self
            .state()
            .sessions
            .iter()
            .map(|(project, session)| (project.clone(), session.life.clone()))
            .collect();
        let mut failure = None;
        for (project, life) in sessions {
            if let Err(error) = self.close_generation(&project, &life, false, false).await {
                failure.get_or_insert(error);
            }
        }
        if let Some(error) = failure {
            // Failed generations remain closed and owned. Do not remove their
            // shared artifact root, but still attempt every captured lifetime.
            return Err(error);
        }
        let _ = runtime::control_socket(&self.config.runtime).map(std::fs::remove_file);
        let _ = std::fs::remove_file(&self.cdp_socket);
        let _ = std::fs::remove_dir_all(&self.config.sessions);
        Ok(())
    }

    async fn drain_closing(&self) {
        let sessions: Vec<(String, Arc<SessionLife>)> = self
            .state()
            .sessions
            .iter()
            .filter(|(_, session)| session.closing)
            .map(|(project, session)| (project.clone(), session.life.clone()))
            .collect();
        for (project, life) in sessions {
            if life.stop.is_cancelled() {
                // Re-enabling the extension cannot revive this canceled lifetime.
                let _ = self.close_generation(&project, &life, false, true).await;
            } else {
                let _ = self.stop_interrupted(&project, &life).await;
            }
        }
    }

    async fn serve_control(self: Arc<Self>, listener: socket::Listener) {
        let permits = Arc::new(Semaphore::new(CONTROL_CONNECTIONS));
        while let Ok(stream) = socket::accept(&listener).await {
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

    async fn control(&self, stream: socket::Stream) {
        let (read, mut write) = tokio::io::split(stream);
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
        let execution = match &request {
            Some(Request::Execute {
                project,
                code,
                timeout_ms,
                expect,
            }) => Some((
                project.clone(),
                None,
                code.clone(),
                *timeout_ms,
                expect.clone(),
            )),
            Some(Request::ExecuteOwned {
                session,
                code,
                timeout_ms,
                expect,
            }) => Some((
                session.project.clone(),
                Some(session.generation.clone()),
                code.clone(),
                *timeout_ms,
                expect.clone(),
            )),
            _ => None,
        };
        let mut probe = [0u8; 1];
        let reply = if let Some((project, generation, code, timeout_ms, expect)) = execution {
            match self.execution_life(&project, generation.as_deref()) {
                Err(refusal) => Reply::Refused { refusal },
                Ok(life) => {
                    let completed = {
                        let execution = self.execute(&project, &life, &code, timeout_ms, expect);
                        tokio::pin!(execution);
                        tokio::select! {
                            reply = &mut execution => Ok(reply),
                            read = reader.read(&mut probe) => Err(read),
                        }
                    }; // Drop the request future before taking its operation lock.
                    match completed {
                        Ok(reply) => reply,
                        Err(read) => {
                            // Dropping the request releases the operation lock; the executor
                            // remains in that lock, owned until this awaited stop/reap.
                            let class = match read {
                                Ok(0) => "client_closed",
                                Ok(_) => "client_data",
                                Err(_) => "client_error",
                            };
                            let stopped = self.stop_interrupted(&project, &life).await;
                            tracing::info!(event.name = "browser.execute.cancelled", outcome = if stopped.is_ok() { "stopped" } else { "error" }, error.type = class);
                            return;
                        }
                    }
                }
            }
        } else {
            match request {
                Some(request) => self.handle(request).await,
                None => Reply::Refused {
                    refusal: Refusal::InvalidRequest,
                },
            }
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
        let written = tokio::time::timeout(CONTROL_IO, async {
            write.write_all(&header).await?;
            write.write_all(&payload).await?;
            write.flush().await
        })
        .await;
        // A reply the client never receives is visible, with a stable class only.
        let failure = match written {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(match error.kind() {
                std::io::ErrorKind::BrokenPipe => "broken_pipe",
                std::io::ErrorKind::ConnectionReset => "connection_reset",
                _ => "io",
            }),
            Err(_) => Some("timeout"),
        };
        if let Some(class) = failure {
            tracing::warn!(event.name = "browser.control.reply", outcome = "error", error.type = class);
            return;
        }
        // The client closes once it has read the reply. Closing first would race it: on macOS
        // the agent client cannot read buffered reply bytes after its peer has closed.
        let mut rest = [0u8; 1];
        let _ = tokio::time::timeout(CONTROL_IO, reader.read(&mut rest)).await;
    }

    async fn handle(&self, request: Request) -> Reply {
        let result = match request {
            Request::Status => {
                let state = self.state();
                Ok(Reply::Status(view::Status {
                    enabled: state.enabled,
                    observation: Some(state.observation.as_str().to_owned()),
                    browser: state.browser.clone(),
                    extension: state.extension.clone(),
                    sessions: state
                        .sessions
                        .values()
                        .filter(|session| !session.closing)
                        .count(),
                    host: Some(view::Build {
                        version: env!("CARGO_PKG_VERSION").to_owned(),
                        commit: option_env!("NDS_SOURCE_COMMIT")
                            .unwrap_or("unknown")
                            .to_owned(),
                    }),
                    compatible: (state.connected && state.contract != Some(CONTRACT))
                        .then_some(false),
                }))
            }
            Request::Update => {
                if !self.state().connected {
                    return Reply::Refused {
                        refusal: Refusal::ExtensionUnavailable,
                    };
                }
                Ok(Reply::Updated {
                    reload: self.update(),
                })
            }
            Request::Open { project } => self.open(&project).await.map(Reply::Session),
            Request::CreateOwned { project } => {
                self.create_owned(&project).map(Reply::OwnedSession)
            }
            Request::OpenOwned { session } => {
                match self.session_life(&session.project, Some(&session.generation)) {
                    Ok(life) => self
                        .open_generation(&session.project, &life)
                        .await
                        .map(Reply::Session),
                    Err(refusal) => Err(refusal),
                }
            }
            Request::CloseOwned {
                session,
                close_tabs,
            } => match self.session_life(&session.project, Some(&session.generation)) {
                Ok(life) => self
                    .close_generation(&session.project, &life, close_tabs, true)
                    .await
                    .map(|()| Reply::Closed),
                Err(refusal) => Err(refusal),
            },
            Request::Sessions => {
                let mut state = self.state();
                let projects: Vec<String> = state
                    .sessions
                    .iter()
                    .filter(|(_, session)| !session.closing)
                    .map(|(project, _)| project.clone())
                    .collect();
                let sessions = projects
                    .iter()
                    .map(|project| view_session(&mut state, project))
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
            Request::Execute { .. } | Request::ExecuteOwned { .. } => Err(Refusal::InvalidRequest),
        };
        result.unwrap_or_else(|refusal| Reply::Refused { refusal })
    }

    /// The session an execution runs in. The owner's switch and the extension come first: once
    /// control is off, the sweep may already have drained the session, and the agent learns why
    /// rather than that the session is gone.
    fn execution_life(
        &self,
        project: &str,
        generation: Option<&str>,
    ) -> Result<Arc<SessionLife>, Refusal> {
        Self::ready(&self.state())?;
        self.session_life(project, generation)
    }

    fn ready(state: &State) -> Result<(), Refusal> {
        if !state.connected || state.contract != Some(CONTRACT) {
            return Err(Refusal::ExtensionUnavailable);
        }
        if !state.enabled {
            return Err(Refusal::PermissionRequired);
        }
        Ok(())
    }

    fn session_life(
        &self,
        project: &str,
        generation: Option<&str>,
    ) -> Result<Arc<SessionLife>, Refusal> {
        let state = self.state();
        let session = state
            .sessions
            .get(project)
            .ok_or(Refusal::SessionNotFound)?;
        if generation.is_some_and(|value| !session.owned || value != session.life.generation) {
            return Err(Refusal::SessionNotFound);
        }
        Ok(session.life.clone())
    }

    fn reserve(&self, project: &str, owned: bool) -> Result<Arc<SessionLife>, Refusal> {
        if !protocol::valid_project(project) {
            return Err(Refusal::InvalidProject);
        }
        let mut state = self.state();
        Self::ready(&state)?;
        if state.sessions.contains_key(project) {
            return Err(Refusal::Busy);
        }
        if state.sessions.len() >= MAX_SESSIONS {
            tracing::warn!(event.name = "browser.session.opened", outcome = "rejected", error.type = Refusal::Capacity.code());
            return Err(Refusal::Capacity);
        }
        let life = Arc::new(SessionLife::new()?);
        state.sessions.insert(
            project.to_owned(),
            Session {
                token: token()?,
                artifacts: self.config.sessions.join(project),
                client: None,
                life: life.clone(),
                owned,
                opened: false,
                closing: false,
                running: false,
                used: Instant::now(),
                aliases: HashMap::new(),
                downloads: None,
                files: downloads::Files::default(),
                journal: None,
            },
        );
        Ok(life)
    }

    fn create_owned(&self, project: &str) -> Result<OwnedSession, Refusal> {
        let life = self.reserve(project, true)?;
        Ok(OwnedSession {
            project: project.into(),
            generation: life.generation.clone(),
        })
    }

    async fn open(&self, project: &str) -> Result<view::Session, Refusal> {
        let closing = {
            let mut state = self.state();
            Self::ready(&state)?;
            if let Some(session) = state.sessions.get(project) {
                if session.owned && (session.closing || !session.opened) {
                    return Err(Refusal::Busy);
                }
                if session.closing {
                    Some(session.life.clone())
                } else {
                    return Ok(view_session(&mut state, project));
                }
            } else {
                None
            }
        };
        if let Some(life) = closing {
            // Drain only the captured legacy generation. A replacement is never adopted.
            self.close_generation(project, &life, false, true).await?;
        }
        let life = self.reserve(project, false)?;
        self.open_generation(project, &life).await
    }

    async fn open_generation(
        &self,
        project: &str,
        life: &Arc<SessionLife>,
    ) -> Result<view::Session, Refusal> {
        let mut executor = tokio::time::timeout(EXTENSION_REPLY, life.executor.lock())
            .await
            .map_err(|_| Refusal::Timeout)?;
        let (endpoint, artifacts) = {
            let mut state = self.state();
            Self::ready(&state)?;
            let session = state
                .sessions
                .get_mut(project)
                .filter(|session| Arc::ptr_eq(&session.life, life))
                .ok_or(Refusal::SessionNotFound)?;
            if session.closing || life.stop.is_cancelled() {
                return Err(Refusal::PermissionRequired);
            }
            if session.opened {
                return Ok(view_session(&mut state, project));
            }
            runtime::private_directory(&session.artifacts)
                .map_err(|_| Refusal::ExecutorUnavailable)?;
            session.opened = true;
            (
                runtime::socket_url(&self.cdp_socket, &format!("/session/{}", session.token)),
                session.artifacts.clone(),
            )
        };
        // Retain the operation lock through the actual claim answer. Close cannot
        // release/reuse this project while a claim is still being processed.
        let claimed = self
            .refusable_work(
                json!({ "type": "claim", "group": project }),
                Some(PendingWork::new(life.clone())),
            )
            .await;
        if let Err(refusal) = claimed {
            if refusal == Refusal::Timeout || refusal == Refusal::ExtensionUnavailable {
                life.uncertain.store(true, Ordering::Release);
            }
            life.stop.cancel();
            if let Some(session) = self
                .state()
                .sessions
                .get_mut(project)
                .filter(|s| Arc::ptr_eq(&s.life, life))
            {
                session.closing = true;
            }
            tracing::warn!(event.name = "browser.session.opened", outcome = "rejected", error.type = refusal.code());
            return Err(refusal);
        }
        let claimed = claimed.unwrap();
        {
            let mut state = self.state();
            let current = state
                .sessions
                .get(project)
                .is_some_and(|s| Arc::ptr_eq(&s.life, life) && !s.closing);
            if !current || life.stop.is_cancelled() {
                return Err(Refusal::PermissionRequired);
            }
            for entry in claimed["tabs"].as_array().into_iter().flatten() {
                if let Some(tab) = entry["tab"].as_i64() {
                    self.register(&mut state, project, tab, entry["target"].clone());
                }
            }
        }
        if let Ok(started) = executor::Executor::start(&self.config, &endpoint, &artifacts) {
            *executor = Some(started);
            life.started.store(true, Ordering::Release);
        }
        tracing::info!(event.name = "browser.session.opened", outcome = "ok");
        Ok(view_session(&mut self.state(), project))
    }

    /// Gives a replacement executor fresh debugger sessions on the same tabs. The executor it
    /// replaces may have left domains enabled, requests intercepted, breakpoints set or bindings
    /// exposed, and Chrome reports a page's execution contexts only to a session that enables
    /// Runtime anew; only a new chrome.debugger session clears all of that. The group's tabs stay
    /// open and grouped: the extension detaches them and attaches them again.
    async fn refresh(&self, project: &str, life: &Arc<SessionLife>) -> Result<(), Refusal> {
        let started = Instant::now();
        let refreshed = self.reattach_group(project, life).await;
        let duration_ms = started.elapsed().as_millis() as u64;
        match &refreshed {
            Ok(()) => tracing::info!(
                event.name = "browser.session.refreshed",
                outcome = "ok",
                duration_ms
            ),
            Err(refusal) => {
                tracing::warn!(event.name = "browser.session.refreshed", outcome = "rejected", error.type = refusal.code(), duration_ms)
            }
        }
        refreshed
    }

    async fn reattach_group(&self, project: &str, life: &Arc<SessionLife>) -> Result<(), Refusal> {
        let released = self
            .refusable_work(
                json!({ "type": "release", "group": project, "close": false }),
                Some(PendingWork::new(life.clone())),
            )
            .await?;
        if released != json!({ "released": true }) || self.state().contract != Some(CONTRACT) {
            return Err(Refusal::ExtensionUnavailable);
        }
        {
            let mut state = self.state();
            // The life may have been closed or replaced while its release was answered; only the
            // current, open life claims its group again.
            if !Self::current(&state, project, life) {
                return Err(Refusal::PermissionRequired);
            }
            let tabs: Vec<i64> = state
                .tabs
                .iter()
                .filter(|(_, tab)| tab.project == project)
                .map(|(id, _)| *id)
                .collect();
            for tab in &tabs {
                state.tabs.remove(tab);
            }
            state.children.retain(|_, tab| !tabs.contains(tab));
            if let Some(session) = state
                .sessions
                .get_mut(project)
                .filter(|s| Arc::ptr_eq(&s.life, life))
            {
                session.aliases.clear();
                session.downloads = None;
            }
        }
        let claimed = self
            .refusable_work(
                json!({ "type": "claim", "group": project }),
                Some(PendingWork::new(life.clone())),
            )
            .await?;
        let mut state = self.state();
        // The same fence after the claim: a life closed meanwhile starts no executor, and its close
        // releases what the claim attached.
        if !Self::current(&state, project, life) {
            return Err(Refusal::PermissionRequired);
        }
        for entry in claimed["tabs"].as_array().into_iter().flatten() {
            if let Some(tab) = entry["tab"].as_i64() {
                self.register(&mut state, project, tab, entry["target"].clone());
            }
        }
        Ok(())
    }

    /// Whether `life` is still the project's open, uncancelled life.
    fn current(state: &State, project: &str, life: &Arc<SessionLife>) -> bool {
        state
            .sessions
            .get(project)
            .is_some_and(|s| Arc::ptr_eq(&s.life, life) && !s.closing)
            && !life.stop.is_cancelled()
    }

    async fn stop_executor(executor: &mut Option<executor::Executor>) -> Result<(), Refusal> {
        if let Some(current) = executor {
            current.stop().await?;
        }
        executor.take();
        Ok(())
    }

    async fn stop_interrupted(
        &self,
        project: &str,
        life: &Arc<SessionLife>,
    ) -> Result<(), Refusal> {
        let mut executor = tokio::time::timeout(EXTENSION_REPLY, life.executor.lock())
            .await
            .map_err(|_| Refusal::Timeout)?;
        Self::stop_executor(&mut executor).await?;
        let mut state = self.state();
        if let Some(session) = state
            .sessions
            .get_mut(project)
            .filter(|s| Arc::ptr_eq(&s.life, life))
            && !session.owned
            && !life.stop.is_cancelled()
        {
            session.closing = false;
        }
        Ok(())
    }

    async fn close(&self, project: &str, close_tabs: bool) -> Result<(), Refusal> {
        let life = self.session_life(project, None)?;
        self.close_generation(project, &life, close_tabs, true)
            .await
    }

    async fn close_generation(
        &self,
        project: &str,
        life: &Arc<SessionLife>,
        close_tabs: bool,
        release: bool,
    ) -> Result<(), Refusal> {
        let _close = tokio::time::timeout(EXTENSION_REPLY, life.close.lock())
            .await
            .map_err(|_| Refusal::Timeout)?;
        let (artifacts, opened) = {
            let mut state = self.state();
            let session = state
                .sessions
                .get_mut(project)
                .filter(|s| Arc::ptr_eq(&s.life, life))
                .ok_or(Refusal::SessionNotFound)?;
            session.closing = true;
            life.stop.cancel();
            session.client = None;
            session.aliases.clear();
            session.downloads = None;
            (session.artifacts.clone(), session.opened)
        };
        let mut executor = tokio::time::timeout(EXTENSION_REPLY, life.executor.lock())
            .await
            .map_err(|_| Refusal::Timeout)?;
        Self::stop_executor(&mut executor).await?;
        let mut pending = life.pending.subscribe();
        let drained = async {
            loop {
                if *pending.borrow_and_update() == 0 {
                    return Ok(());
                }
                pending
                    .changed()
                    .await
                    .map_err(|_| Refusal::ExecutorUnavailable)?;
            }
        };
        tokio::time::timeout(EXTENSION_REPLY, drained)
            .await
            .map_err(|_| Refusal::Timeout)??;
        // An unacknowledged old browser action forbids project replacement.
        if self.state().connected && life.uncertain.load(Ordering::Acquire) {
            return Err(Refusal::Timeout);
        }
        if self.state().connected
            && (!release || !opened)
            && (life.cdp_state.load(Ordering::Acquire) == CDP_UNCERTAIN
                || *life.cdp_pending.borrow() != 0)
        {
            return Err(Refusal::Timeout);
        }
        if release && opened {
            let released = self
                .refusable_work(
                    json!({ "type": "release", "group": project, "close": close_tabs }),
                    Some(PendingWork::new(life.clone())),
                )
                .await?;
            // Older {} ACKs, unverified or malformed releases, and an extension of another contract
            // prove nothing: the release was attempted, but the close is not confirmed.
            if released != json!({ "released": true }) || self.state().contract != Some(CONTRACT) {
                return Err(Refusal::ExtensionUnavailable);
            }
            self.release_cdp(life);
        }
        // Keep the closing generation registered until its artifact area is gone.
        if opened {
            std::fs::remove_dir_all(artifacts).map_err(|_| Refusal::ExecutorUnavailable)?;
        }
        {
            let mut state = self.state();
            if !state
                .sessions
                .get(project)
                .is_some_and(|s| Arc::ptr_eq(&s.life, life))
            {
                return Err(Refusal::SessionNotFound);
            }
            if let Some(journal) = state
                .sessions
                .remove(project)
                .and_then(|session| session.journal)
            {
                journal
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .flush();
            }
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
        }
        tracing::info!(event.name = "browser.session.closed", outcome = "ok");
        Ok(())
    }

    async fn execute(
        &self,
        project: &str,
        life: &Arc<SessionLife>,
        code: &str,
        timeout_ms: u64,
        expect: Option<Document>,
    ) -> Reply {
        let started = Instant::now();
        let result = self.run(project, life, code, timeout_ms, expect).await;
        let duration_ms = started.elapsed().as_millis() as u64;
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
        life: &Arc<SessionLife>,
        code: &str,
        timeout_ms: u64,
        expect: Option<Document>,
    ) -> Result<view::Outcome, Refusal> {
        if !protocol::valid_execution(timeout_ms) || code.trim().is_empty() {
            return Err(Refusal::InvalidRequest);
        }
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut executor = life.executor.try_lock().map_err(|_| Refusal::Busy)?;
        let (endpoint, artifacts) = {
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
                .filter(|s| Arc::ptr_eq(&s.life, life))
                .ok_or(Refusal::SessionNotFound)?;
            if session.closing || life.stop.is_cancelled() {
                return Err(Refusal::PermissionRequired);
            }
            if !session.opened {
                return Err(Refusal::SessionNotFound);
            }
            if session.running {
                return Err(Refusal::Busy);
            }
            session.running = true;
            session.used = Instant::now();
            (
                runtime::socket_url(&self.cdp_socket, &format!("/session/{}", session.token)),
                session.artifacts.clone(),
            )
        };
        let mut running = Running {
            host: self,
            project,
            life,
            finished: false,
        };
        if executor.is_none() {
            if life.started.load(Ordering::Acquire) {
                self.refresh(project, life).await?;
            }
            *executor = Some(executor::Executor::start(
                &self.config,
                &endpoint,
                &artifacts,
            )?);
            life.started.store(true, Ordering::Release);
        }
        let current = executor.as_mut().unwrap();
        let ready = tokio::select! {
            () = life.stop.cancelled() => Err(Refusal::PermissionRequired),
            result = current.ready(deadline) => result,
        };
        // Preserve the existing pending-start behavior: no script has run yet.
        if ready == Err(Refusal::Timeout) && !life.stop.is_cancelled() {
            running.finished = true;
            return Err(Refusal::Timeout);
        }
        let result = match ready {
            Err(refusal) => Err(refusal),
            Ok(()) => tokio::select! {
                () = life.stop.cancelled() => Err(Refusal::PermissionRequired),
                result = current.run(code, deadline) => result,
            },
        };
        match result {
            Ok((failure, output, truncated)) => {
                let tabs = tokio::select! {
                    () = life.stop.cancelled() => {
                        Self::stop_executor(&mut executor).await?;
                        running.finished = true;
                        return Err(Refusal::PermissionRequired);
                    }
                    tabs = self.tabs(project) => tabs,
                };
                running.finished = true;
                Ok(view::Outcome {
                    failure,
                    output,
                    truncated,
                    tabs,
                })
            }
            Err(refusal) => {
                Self::stop_executor(&mut executor).await?;
                running.finished = true;
                Err(refusal)
            }
        }
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
    life: &'a Arc<SessionLife>,
    finished: bool,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        if let Some(session) = self
            .host
            .state()
            .sessions
            .get_mut(self.project)
            .filter(|s| Arc::ptr_eq(&s.life, self.life))
        {
            session.running = false;
            session.used = Instant::now();
            if !self.finished {
                session.closing = true;
            }
        }
    }
}

fn view_session(state: &mut State, project: &str) -> view::Session {
    view::Session {
        project: project.to_owned(),
        tabs: state
            .tabs
            .values()
            .filter(|tab| tab.project == project)
            .count(),
        executor: state.sessions.get_mut(project).is_some_and(|session| {
            session
                .life
                .executor
                .try_lock()
                .ok()
                .and_then(|mut executor| executor.as_mut().map(executor::Executor::is_ready))
                == Some(true)
        }),
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
        session.closing = true;
        session.life.stop.cancel();
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
mod owned_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_sites_are_lowercase_host_names() {
        let long = "a".repeat(300);
        assert_eq!(
            observation::sites(&json!([
                "Mail.Example.com",
                "example.com",
                "example.com",
                "bad host",
                ".x",
                "x.",
                long,
                7
            ])),
            ["example.com", "mail.example.com"]
        );
        assert!(observation::sites(&json!(null)).is_empty());
    }

    #[test]
    fn browsers_are_named_from_their_user_agents() {
        let chrome = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
        assert_eq!(browser_name(chrome), "Chrome/157.0.0.0");
        assert_eq!(
            browser_name(&format!("{chrome} Edg/157.0.3400.1")),
            "Edge/157.0.3400.1"
        );
        assert_eq!(
            browser_name("Mozilla/5.0 HeadlessChrome/156.0.0.0 Safari/537.36"),
            "Chrome/156.0.0.0"
        );
        assert_eq!(browser_name(""), "Chrome");
    }

    #[test]
    fn the_owner_recorder_answer_names_the_recording_or_why_it_did_not_run() {
        let executed = |output: &str, failure| {
            Reply::Executed(view::Outcome {
                failure,
                output: output.to_owned(),
                truncated: false,
                tabs: Vec::new(),
            })
        };
        let started = executed(r#"[return value] {"id":"mvt1","path":"/run/x"}"#, None);
        assert_eq!(
            owner_recording(&started),
            json!({ "recording": true, "id": "mvt1" })
        );
        let status = executed(
            r#"[return value] {"id":"mvt1","events":4,"path":"/run/x"}"#,
            None,
        );
        assert_eq!(
            owner_recording(&status),
            json!({ "recording": true, "id": "mvt1", "events": 4 })
        );
        let stopped = executed(
            r#"[return value] {"id":"mvt1","path":"/run/x","reason":"stopped","events":4,"frames":2}"#,
            None,
        );
        assert_eq!(
            owner_recording(&stopped),
            json!({ "recording": false, "id": "mvt1", "events": 4 })
        );
        assert_eq!(
            owner_recording(&executed("[return value] null", None)),
            json!({ "recording": false })
        );
        let refused = executed(
            "Error: The recorder keeps what a person does in agent tabs, which only the full observation profile collects",
            Some(view::ScriptFailure::ScriptError),
        );
        assert_eq!(owner_recording(&refused)["error"], "script_error");
        assert!(
            owner_recording(&refused)["message"]
                .as_str()
                .unwrap()
                .contains("full observation profile")
        );
        let busy = Reply::Refused {
            refusal: Refusal::Busy,
        };
        assert_eq!(owner_recording(&busy), json!({ "error": "busy" }));
    }

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
    fn only_a_different_installed_version_triggers_a_reload() {
        assert_eq!(
            reload_target("0.0.1", Some("0.0.2".into())),
            Some("0.0.2".into())
        );
        assert_eq!(reload_target("0.0.2", Some("0.0.2".into())), None);
        assert_eq!(reload_target("", Some("0.0.2".into())), None);
        assert_eq!(reload_target("0.0.1", None), None);
    }

    #[test]
    fn installed_versions_are_bounded_and_numeric() {
        let root = tempfile::tempdir().unwrap();
        let manifest = root.path().join("manifest.json");
        std::fs::write(&manifest, br#"{"version":"0.0.3"}"#).unwrap();
        assert_eq!(installed_version(&manifest), Some("0.0.3".into()));
        std::fs::write(&manifest, br#"{"version":"0.0.3; rm"}"#).unwrap();
        assert_eq!(installed_version(&manifest), None);
        assert_eq!(installed_version(&root.path().join("absent.json")), None);
    }

    #[test]
    fn bounded_text_respects_character_boundaries() {
        assert_eq!(bounded("ёжик", 2), "ёж");
        assert_eq!(bounded("abc", 10), "abc");
    }
}
