//! A phone's browser in the place of the desktop extension (docs/mobile.md).
//!
//! The host speaks one framed protocol to its browser link: requests (`claim`, `open`, `close`,
//! `release`, `cdp`, `tabs`) answered by `result`, and `event`, `attached` and `detached` reports.
//! This link answers them over the browser's own DevTools connection, reached through ADB:
//! every agent tab is a page target attached in flatten mode, its session's events are reported
//! as the tab's, and the sessions it opens for frames and workers as the tab's child sessions.
//!
//! A phone browser has no tab groups, so an agent's tabs are the tabs it opened and the pages
//! they opened; the owner's other tabs are never attached. The owner's switch is the link
//! itself: it runs while the owner runs `nds-browser-use phone serve`.

use super::adb;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::{mpsc, oneshot},
};
use tokio_tungstenite::{
    WebSocketStream,
    tungstenite::{Message, protocol::WebSocketConfig},
};

/// A phone's full-page screenshot stays well below this.
const MESSAGE_LIMIT: usize = 64 * 1_048_576;
/// The host sends at most 1 MiB per message.
const HOST_LIMIT: usize = 2 * 1_048_576;
/// The host reads at most 32 MiB per message and ends on a larger one.
const TO_HOST_LIMIT: usize = 32 * 1_048_576;
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Agent tabs of all groups together, and the child sessions of all tabs.
const MAX_TABS: usize = 256;
const MAX_CHILDREN: usize = 4096;
/// Events no agent uses that flood the link on busy pages, as in the desktop extension.
const NOISY: [&str; 2] = ["Network.dataReceived", "Network.resourceChangedPriority"];
const REASON_LIMIT: usize = 200;
/// A notification is cleared by snoozing it for ten years; Android has no shell command that
/// cancels one.
const CLEARED_MS: u64 = 10 * 365 * 24 * 60 * 60 * 1000;
/// While the browser captures a screenshot, the page's scrollbars and caret stay out of it.
const SHOT_STYLE: &str = "nds-screenshot-style";
const SHOT_HIDE: &str = r#"(() => { if (document.getElementById("nds-screenshot-style")) return; const style = document.createElement("style"); style.id = "nds-screenshot-style"; style.textContent = "html { scrollbar-width: none !important } ::-webkit-scrollbar { display: none !important } * { caret-color: transparent !important }"; (document.head ?? document.documentElement).append(style); })()"#;

/// What the phone's DevTools socket says about its browser (`/json/version`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Browser {
    /// `Chrome/141.0.7390.122`, or the product of another Chromium browser.
    pub product: String,
    /// The Android package, when the browser names it.
    pub package: Option<String>,
    pub user_agent: String,
    /// The path of the browser's DevTools WebSocket.
    path: String,
}

/// Asks the browser behind `socket` for its version over HTTP.
pub async fn version(server: &adb::Server, serial: &str, socket: &str) -> std::io::Result<Browser> {
    let stream = server.open(serial, socket).await?;
    let body = tokio::time::timeout(Duration::from_secs(5), get(stream, "/json/version"))
        .await
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::TimedOut))??;
    parse_version(&body).ok_or_else(|| std::io::ErrorKind::InvalidData.into())
}

/// One HTTP GET to the DevTools server. Chrome admits only a `localhost` or IP Host header.
async fn get<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    path: &str,
) -> std::io::Result<Vec<u8>> {
    let request = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = stream.read(&mut buffer).await?;
        response.extend_from_slice(&buffer[..read]);
        if response.len() > 65_536 {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        if let Some(end) = response.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&response[..end]).to_ascii_lowercase();
            if !head.starts_with("http/1.1 200") {
                return Err(std::io::ErrorKind::InvalidData.into());
            }
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok());
            let body = end + 4;
            match length {
                Some(length) if response.len() >= body + length => {
                    return Ok(response[body..body + length].to_vec());
                }
                None if read == 0 => return Ok(response[body..].to_vec()),
                _ => {}
            }
        }
        if read == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
    }
}

fn parse_version(body: &[u8]) -> Option<Browser> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let url = value["webSocketDebuggerUrl"].as_str()?;
    let path = &url[url.find("/devtools/")?..];
    let valid = path.len() <= 256
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"/-_.".contains(&byte));
    let text = |field: &str, limit: usize| {
        value[field]
            .as_str()
            .map(|text| text.chars().take(limit).collect::<String>())
    };
    valid.then(|| Browser {
        product: text("Browser", 64).unwrap_or_default(),
        package: text("Android-Package", 128),
        user_agent: text("User-Agent", 512).unwrap_or_default(),
        path: path.to_owned(),
    })
}

/// Opens the browser's DevTools WebSocket through ADB.
pub async fn connect(
    server: &adb::Server,
    serial: &str,
    socket: &str,
    browser: &Browser,
) -> std::io::Result<WebSocketStream<tokio::net::TcpStream>> {
    let stream = server.open(serial, socket).await?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(MESSAGE_LIMIT))
        .max_frame_size(Some(MESSAGE_LIMIT));
    let url = format!("ws://localhost{}", browser.path);
    let (socket, _) = tokio_tungstenite::client_async_with_config(url, stream, Some(config))
        .await
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::ConnectionRefused))?;
    Ok(socket)
}

/// Where owner notifications go: the phone's shell, through the same ADB server.
pub struct Notices {
    pub server: adb::Server,
    pub serial: String,
}

/// Why a link ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    /// The browser closed its DevTools connection: it quit, or the phone went away.
    Browser,
    /// The host closed its side.
    Host,
    /// The owner stopped the link.
    Stopped,
}

/// Serves the host over one browser connection until either side ends.
pub async fn run<S, H>(
    socket: WebSocketStream<S>,
    browser: &Browser,
    observation: &str,
    notices: Option<Notices>,
    host: H,
    stop: impl Future<Output = ()>,
) -> Ended
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    H: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (mut sink, mut source) = socket.split();
    let (to_browser, mut browser_queue) = mpsc::unbounded_channel::<String>();
    let (to_host, mut host_queue) = mpsc::unbounded_channel::<Vec<u8>>();
    let (mut host_read, mut host_write) = tokio::io::split(host);
    let browser_writer = tokio::spawn(async move {
        while let Some(text) = browser_queue.recv().await {
            if sink.send(Message::text(text)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    // Frames are read whole in their own task: a read interrupted by a browser message would
    // lose its place in the stream.
    let (frames_in, mut frames) = mpsc::channel::<Value>(256);
    let host_reader = tokio::spawn(async move {
        while let Some(message) = read_frame(&mut host_read).await {
            if frames_in.send(message).await.is_err() {
                break;
            }
        }
    });
    let host_writer = tokio::spawn(async move {
        while let Some(frame) = host_queue.recv().await {
            if host_write.write_all(&frame).await.is_err() || host_write.flush().await.is_err() {
                break;
            }
        }
    });
    let link = Arc::new(Link {
        browser: to_browser,
        host: to_host,
        notices,
        next_call: AtomicU64::new(1),
        state: Mutex::default(),
    });
    // Popups of agent tabs are adopted from the browser's target reports.
    link.quiet(
        None,
        "Target.setDiscoverTargets",
        json!({ "discover": true }),
    );
    link.report(json!({
        "type": "hello",
        "protocol": "1.3",
        "version": env!("CARGO_PKG_VERSION"),
        "contract": 2,
        "userAgent": browser.user_agent,
        "enabled": true,
        // The phone keeps downloads in its own storage; the executor fetches the file again.
        "downloads": false,
        "observation": observation,
    }));
    let mut stop = std::pin::pin!(stop);
    let ended = loop {
        tokio::select! {
            message = source.next() => match message {
                Some(Ok(Message::Text(text))) => link.on_browser(text.as_str()),
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Frame(_))) => {}
                _ => break Ended::Browser,
            },
            frame = frames.recv() => match frame {
                Some(message) => link.on_host(message),
                None => break Ended::Host,
            },
            () = &mut stop => break Ended::Stopped,
        }
    };
    // Ending both directions closes the host's side, which then shuts down in order.
    host_reader.abort();
    browser_writer.abort();
    host_writer.abort();
    // Waiting tasks learn that the browser is gone.
    link.state().calls.clear();
    ended
}

async fn read_frame<R: AsyncRead + Unpin>(reader: &mut R) -> Option<Value> {
    let mut length = [0u8; 4];
    reader.read_exact(&mut length).await.ok()?;
    let length = u32::from_ne_bytes(length) as usize;
    if length > HOST_LIMIT {
        return None;
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await.ok()?;
    serde_json::from_slice(&body).ok()
}

struct Link {
    browser: mpsc::UnboundedSender<String>,
    host: mpsc::UnboundedSender<Vec<u8>>,
    notices: Option<Notices>,
    next_call: AtomicU64,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    calls: HashMap<u64, Call>,
    next_tab: i64,
    tabs: HashMap<i64, Tab>,
    sessions: HashMap<String, Owner>,
    /// The owner notification each tab shows, by its tag.
    notices: HashMap<i64, String>,
    next_notice: u64,
}

struct Tab {
    group: String,
    target: String,
    /// The tab's flatten session while the link holds it.
    session: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Owner {
    Root(i64),
    Child(i64),
}

impl Owner {
    fn tab(self) -> i64 {
        match self {
            Self::Root(tab) | Self::Child(tab) => tab,
        }
    }
}

/// Who receives the browser's answer to one command.
enum Call {
    /// The host's request of this id.
    Host(u64),
    /// A side command whose answer nobody needs.
    Quiet,
    Task(oneshot::Sender<Result<Value, Value>>),
}

/// The answer to one host request.
enum Answer {
    Done(Value),
    /// A refusal the host knows by its code.
    Refused(&'static str),
    /// A CDP error object from the browser.
    Cdp(Value),
}

impl From<Value> for Answer {
    fn from(error: Value) -> Self {
        Self::Cdp(error)
    }
}

impl Link {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Sends one message to the host; one larger than the host reads is not sent.
    fn report(&self, message: Value) -> bool {
        let Ok(body) = serde_json::to_vec(&message) else {
            return false;
        };
        if body.len() > TO_HOST_LIMIT {
            return false;
        }
        let mut framed = Vec::with_capacity(body.len() + 4);
        framed.extend_from_slice(&(body.len() as u32).to_ne_bytes());
        framed.extend_from_slice(&body);
        self.host.send(framed).is_ok()
    }

    fn answer(&self, id: u64, answer: Answer) {
        let message = match answer {
            Answer::Done(result) => json!({ "type": "result", "id": id, "result": result }),
            Answer::Refused(code) => {
                json!({ "type": "result", "id": id, "error": { "code": code, "message": code } })
            }
            Answer::Cdp(error) => json!({
                "type": "result",
                "id": id,
                "error": { "code": "cdp_error", "message": error.to_string() },
            }),
        };
        if !self.report(message) {
            // A result the host cannot read, such as a huge screenshot, fails as a CDP error.
            let error = json!({ "code": -32000, "message": "The result is larger than 32 MiB" });
            self.report(json!({
                "type": "result",
                "id": id,
                "error": { "code": "cdp_error", "message": error.to_string() },
            }));
        }
    }

    /// Sends one command; commands sent in sequence reach the browser in that order.
    fn command(
        &self,
        state: &mut State,
        session: Option<&str>,
        method: &str,
        params: Value,
        call: Call,
    ) {
        let id = self.next_call.fetch_add(1, Ordering::Relaxed);
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        state.calls.insert(id, call);
        if self.browser.send(message.to_string()).is_err() {
            state.calls.remove(&id);
        }
    }

    fn quiet(&self, session: Option<&str>, method: &str, params: Value) {
        let mut state = self.state();
        self.command(&mut state, session, method, params, Call::Quiet);
    }

    async fn call(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, Value> {
        let (send, receive) = oneshot::channel();
        {
            let mut state = self.state();
            self.command(&mut state, session, method, params, Call::Task(send));
        }
        match tokio::time::timeout(CALL_TIMEOUT, receive).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(json!({ "code": -32000, "message": "Target closed" })),
            Err(_) => Err(json!({ "code": -32000, "message": "The browser did not answer" })),
        }
    }

    fn on_host(self: &Arc<Self>, message: Value) {
        let Some(id) = message["id"].as_u64() else {
            // `reload` names no id: a phone link is never reloaded from disk.
            return;
        };
        match message["type"].as_str() {
            Some("cdp") => self.cdp(id, &message),
            Some("claim" | "release" | "open" | "close" | "tabs") => {
                let link = self.clone();
                tokio::spawn(async move {
                    let answer = link.request(&message).await;
                    link.answer(id, answer);
                });
            }
            // The phone keeps no agent download for the host to remove.
            Some("forget") => self.answer(id, Answer::Done(json!({}))),
            _ => self.answer(id, Answer::Refused("invalid_request")),
        }
    }

    async fn request(&self, message: &Value) -> Answer {
        let group = message["group"].as_str().unwrap_or_default();
        let result = match message["type"].as_str() {
            Some("claim") => self.claim(group).await,
            Some("release") => {
                self.release(group, message["close"].as_bool() == Some(true))
                    .await
            }
            Some("open") => {
                self.open(group, message["url"].as_str().unwrap_or("about:blank"))
                    .await
            }
            Some("close") => {
                self.close(group, message["tab"].as_i64().unwrap_or(-1))
                    .await
            }
            _ => {
                self.tabs(
                    message["tabs"]
                        .as_array()
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                )
                .await
            }
        };
        match result {
            Ok(value) => Answer::Done(value),
            Err(answer) => answer,
        }
    }

    /// A CDP command for a held tab, or one of its child sessions. It is sent right here, so the
    /// host's commands reach the browser in the order the host sent them.
    fn cdp(self: &Arc<Self>, id: u64, message: &Value) {
        let tab = message["tab"].as_i64().unwrap_or(-1);
        let group = message["group"].as_str().unwrap_or_default();
        let method = message["method"].as_str().unwrap_or_default();
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let mut state = self.state();
        let Some(root) = state
            .tabs
            .get(&tab)
            .filter(|entry| entry.group == group)
            .and_then(|entry| entry.session.clone())
        else {
            drop(state);
            return self.answer(id, Answer::Refused("target_closed"));
        };
        let child = message["session"].as_str();
        if child.is_some_and(|child| state.sessions.get(child) != Some(&Owner::Child(tab))) {
            drop(state);
            return self.answer(id, Answer::Refused("target_closed"));
        }
        let session = child.unwrap_or(&root).to_owned();
        match method {
            "NDS.notifyOwner" | "NDS.clearOwner" => {
                drop(state);
                let link = self.clone();
                let group = group.to_owned();
                let notify = method == "NDS.notifyOwner";
                tokio::spawn(async move {
                    let answer = if notify {
                        link.notify_owner(tab, &group, &params).await
                    } else {
                        link.clear_owner(tab).await;
                        Answer::Done(json!({}))
                    };
                    link.answer(id, answer);
                });
            }
            // Chrome reports execution contexts only when Runtime goes from disabled to enabled;
            // a later client of the tab would otherwise never learn them.
            "Runtime.enable" => {
                self.command(
                    &mut state,
                    Some(&session),
                    "Runtime.disable",
                    json!({}),
                    Call::Quiet,
                );
                self.command(&mut state, Some(&session), method, params, Call::Host(id));
            }
            "Page.captureScreenshot" if child.is_none() => {
                let hide = json!({ "expression": SHOT_HIDE });
                let show = json!({ "expression": format!("document.getElementById({SHOT_STYLE:?})?.remove()") });
                self.command(
                    &mut state,
                    Some(&session),
                    "Runtime.evaluate",
                    hide,
                    Call::Quiet,
                );
                self.command(&mut state, Some(&session), method, params, Call::Host(id));
                self.command(
                    &mut state,
                    Some(&session),
                    "Runtime.evaluate",
                    show,
                    Call::Quiet,
                );
            }
            _ => self.command(&mut state, Some(&session), method, params, Call::Host(id)),
        }
    }

    /// The group's tabs, each attached by this claim if the link does not hold it yet.
    async fn claim(&self, group: &str) -> Result<Value, Answer> {
        let mut tabs: Vec<i64> = {
            let state = self.state();
            state
                .tabs
                .iter()
                .filter(|(_, tab)| tab.group == group)
                .map(|(id, _)| *id)
                .collect()
        };
        tabs.sort_unstable();
        let mut claimed = Vec::new();
        for tab in tabs {
            match self.attach(tab).await {
                Ok(target) => claimed.push(json!({ "tab": tab, "target": target })),
                // A tab that closed meanwhile is not part of the claim.
                Err(_) if !self.state().tabs.contains_key(&tab) => {}
                Err(answer) => return Err(answer),
            }
        }
        Ok(json!({ "tabs": claimed }))
    }

    /// Ends the link's hold on the group's tabs: closes them, or detaches and keeps them in the
    /// group for its next claim.
    async fn release(&self, group: &str, close: bool) -> Result<Value, Answer> {
        let tabs: Vec<(i64, String, Option<String>)> = {
            let mut state = self.state();
            let held: Vec<i64> = state
                .tabs
                .iter()
                .filter(|(_, tab)| tab.group == group)
                .map(|(id, _)| *id)
                .collect();
            held.into_iter()
                .filter_map(|id| {
                    let session = Self::forget_session(&mut state, id);
                    let target = if close {
                        state.tabs.remove(&id)?.target
                    } else {
                        state.tabs.get(&id)?.target.clone()
                    };
                    Some((id, target, session))
                })
                .collect()
        };
        for (tab, target, session) in tabs {
            self.clear_owner(tab).await;
            if close {
                // A target that closed meanwhile is released as well.
                let _ = self
                    .call(None, "Target.closeTarget", json!({ "targetId": target }))
                    .await;
            } else if let Some(session) = session {
                let _ = self
                    .call(
                        None,
                        "Target.detachFromTarget",
                        json!({ "sessionId": session }),
                    )
                    .await;
            }
        }
        Ok(json!({ "released": true }))
    }

    /// Removes a tab's sessions from the link, so their end is not reported as a loss.
    fn forget_session(state: &mut State, tab: i64) -> Option<String> {
        state.sessions.retain(|_, owner| owner.tab() != tab);
        state.tabs.get_mut(&tab)?.session.take()
    }

    async fn open(&self, group: &str, url: &str) -> Result<Value, Answer> {
        if self.state().tabs.len() >= MAX_TABS {
            return Err(Answer::Refused("capacity"));
        }
        let created = self
            .call(None, "Target.createTarget", json!({ "url": url }))
            .await?;
        let target = created["targetId"]
            .as_str()
            .ok_or(Answer::Refused("target_closed"))?
            .to_owned();
        let tab = self.add_tab(group, &target);
        match self.attach(tab).await {
            Ok(info) => Ok(json!({ "tab": tab, "target": info })),
            Err(answer) => {
                self.state().tabs.remove(&tab);
                let _ = self
                    .call(None, "Target.closeTarget", json!({ "targetId": target }))
                    .await;
                Err(answer)
            }
        }
    }

    fn add_tab(&self, group: &str, target: &str) -> i64 {
        let mut state = self.state();
        state.next_tab += 1;
        let tab = state.next_tab;
        let entry = Tab {
            group: group.to_owned(),
            target: target.to_owned(),
            session: None,
        };
        state.tabs.insert(tab, entry);
        tab
    }

    async fn close(&self, group: &str, tab: i64) -> Result<Value, Answer> {
        let target = self
            .state()
            .tabs
            .get(&tab)
            .filter(|entry| entry.group == group && entry.session.is_some())
            .map(|entry| entry.target.clone())
            .ok_or(Answer::Refused("target_closed"))?;
        // The browser's report that the target is gone tells the host the tab detached.
        self.call(None, "Target.closeTarget", json!({ "targetId": target }))
            .await?;
        Ok(json!({}))
    }

    /// Attaches a tab in flatten mode unless the link holds it, and answers its target info.
    async fn attach(&self, tab: i64) -> Result<Value, Answer> {
        let (target, held) = {
            let state = self.state();
            let entry = state
                .tabs
                .get(&tab)
                .ok_or(Answer::Refused("target_closed"))?;
            (entry.target.clone(), entry.session.is_some())
        };
        if !held {
            let attached = self
                .call(
                    None,
                    "Target.attachToTarget",
                    json!({ "targetId": target, "flatten": true }),
                )
                .await?;
            let session = attached["sessionId"]
                .as_str()
                .ok_or(Answer::Refused("target_closed"))?
                .to_owned();
            let kept = {
                let mut state = self.state();
                match state.tabs.get_mut(&tab) {
                    Some(entry) if entry.session.is_none() => {
                        entry.session = Some(session.clone());
                        state.sessions.insert(session.clone(), Owner::Root(tab));
                        true
                    }
                    _ => false,
                }
            };
            if !kept {
                // The tab closed or another claim attached it during this attach.
                self.quiet(
                    None,
                    "Target.detachFromTarget",
                    json!({ "sessionId": session }),
                );
                return Err(Answer::Refused("target_closed"));
            }
        }
        let info = self
            .call(None, "Target.getTargetInfo", json!({ "targetId": target }))
            .await?;
        Ok(info["targetInfo"].clone())
    }

    async fn tabs(&self, ids: &[Value]) -> Result<Value, Answer> {
        let mut tabs = Vec::new();
        for id in ids.iter().filter_map(Value::as_i64) {
            let held = {
                let state = self.state();
                state
                    .tabs
                    .get(&id)
                    .and_then(|tab| Some((tab.target.clone(), tab.session.clone()?)))
            };
            let Some((target, session)) = held else {
                continue;
            };
            let Ok(info) = self
                .call(None, "Target.getTargetInfo", json!({ "targetId": target }))
                .await
            else {
                continue;
            };
            // The current main-frame loader identifies the document agents see now.
            let tree = self
                .call(Some(&session), "Page.getFrameTree", json!({}))
                .await
                .unwrap_or_default();
            tabs.push(json!({
                "tab": id,
                "url": info["targetInfo"]["url"],
                "title": info["targetInfo"]["title"],
                "document": tree["frameTree"]["frame"]["loaderId"],
            }));
        }
        Ok(json!({ "tabs": tabs }))
    }

    fn on_browser(self: &Arc<Self>, text: &str) {
        let Ok(message) = serde_json::from_str::<Value>(text) else {
            return;
        };
        if let Some(id) = message["id"].as_u64() {
            let Some(call) = self.state().calls.remove(&id) else {
                return;
            };
            let result = match message.get("error") {
                Some(error) => Err(error.clone()),
                None => Ok(message.get("result").cloned().unwrap_or_else(|| json!({}))),
            };
            match (call, result) {
                (Call::Host(host), Ok(result)) => self.answer(host, Answer::Done(result)),
                (Call::Host(host), Err(error)) => self.answer(host, Answer::Cdp(error)),
                (Call::Quiet, _) => {}
                (Call::Task(send), result) => {
                    let _ = send.send(result);
                }
            }
            return;
        }
        let method = message["method"].as_str().unwrap_or_default();
        let params = &message["params"];
        match message["sessionId"].as_str() {
            Some(session) => self.on_session_event(session, method, params),
            None => self.on_target_event(method, params),
        }
    }

    /// An event of a tab's session or one of its child sessions.
    fn on_session_event(&self, session: &str, method: &str, params: &Value) {
        let mut state = self.state();
        let Some(owner) = state.sessions.get(session).copied() else {
            return;
        };
        let tab = owner.tab();
        match (method, params["sessionId"].as_str()) {
            ("Target.attachedToTarget", Some(child)) if state.sessions.len() < MAX_CHILDREN => {
                state.sessions.insert(child.to_owned(), Owner::Child(tab));
            }
            ("Target.detachedFromTarget", Some(child))
                if state.sessions.get(child) == Some(&Owner::Child(tab)) =>
            {
                state.sessions.remove(child);
            }
            _ => {}
        }
        drop(state);
        if NOISY.contains(&method) {
            return;
        }
        let mut event = json!({ "type": "event", "tab": tab, "method": method, "params": params });
        if owner == Owner::Child(tab) {
            event["session"] = session.into();
        }
        self.report(event);
    }

    /// The browser's own target reports: a held tab's session or target ended, or an agent tab
    /// opened a page.
    fn on_target_event(self: &Arc<Self>, method: &str, params: &Value) {
        match method {
            "Target.detachedFromTarget" => {
                let Some(session) = params["sessionId"].as_str() else {
                    return;
                };
                let mut state = self.state();
                let Some(Owner::Root(tab)) = state.sessions.get(session).copied() else {
                    return;
                };
                Self::forget_session(&mut state, tab);
                drop(state);
                self.report(json!({ "type": "detached", "tab": tab, "reason": "target_closed" }));
            }
            "Target.targetDestroyed" => {
                let Some(target) = params["targetId"].as_str() else {
                    return;
                };
                let mut state = self.state();
                let Some(tab) = state
                    .tabs
                    .iter()
                    .find(|(_, entry)| entry.target == target)
                    .map(|(id, _)| *id)
                else {
                    return;
                };
                let held = Self::forget_session(&mut state, tab).is_some();
                state.tabs.remove(&tab);
                let notice = state.notices.remove(&tab);
                drop(state);
                if let Some(tag) = notice {
                    let link = self.clone();
                    tokio::spawn(async move { link.cancel_notice(&tag).await });
                }
                if held {
                    self.report(
                        json!({ "type": "detached", "tab": tab, "reason": "target_closed" }),
                    );
                }
            }
            "Target.targetCreated" => {
                let info = &params["targetInfo"];
                let (Some(target), Some(opener)) =
                    (info["targetId"].as_str(), info["openerId"].as_str())
                else {
                    return;
                };
                if info["type"] != "page" {
                    return;
                }
                let group = {
                    let state = self.state();
                    if state.tabs.len() >= MAX_TABS
                        || state.tabs.values().any(|entry| entry.target == target)
                    {
                        return;
                    }
                    let Some(group) = state
                        .tabs
                        .values()
                        .find(|entry| entry.target == opener && entry.session.is_some())
                        .map(|entry| entry.group.clone())
                    else {
                        return;
                    };
                    group
                };
                let tab = self.add_tab(&group, target);
                let link = self.clone();
                tokio::spawn(async move {
                    if let Ok(target) = link.attach(tab).await {
                        link.report(json!({ "type": "attached", "tab": tab, "group": group, "target": target }));
                    } else if link.state().tabs.contains_key(&tab) {
                        link.report(json!({ "type": "adoption", "tab": tab, "failure": "attach" }));
                    }
                });
            }
            _ => {}
        }
    }

    /// A check in an agent tab that only a person passes: the phone shows a notification naming
    /// the agent and the site, and the tab is brought to the front of the browser, so the owner
    /// finds it there.
    async fn notify_owner(&self, tab: i64, group: &str, params: &Value) -> Answer {
        let Some(notices) = &self.notices else {
            return Answer::Cdp(
                json!({ "code": -32000, "message": "Owner notifications are not available" }),
            );
        };
        let target = self
            .state()
            .tabs
            .get(&tab)
            .map(|entry| entry.target.clone());
        let Some(target) = target else {
            return Answer::Refused("target_closed");
        };
        let info = self
            .call(None, "Target.getTargetInfo", json!({ "targetId": target }))
            .await
            .unwrap_or_default();
        let site = info["targetInfo"]["url"]
            .as_str()
            .and_then(|url| url.split("://").nth(1))
            .and_then(|rest| rest.split(['/', '?', '#']).next())
            .unwrap_or_default()
            .to_owned();
        let reason = params["reason"]
            .as_str()
            .map(str::trim)
            .filter(|reason| !reason.is_empty())
            .unwrap_or("A check in its tab needs a person.");
        let reason: String = reason.chars().take(REASON_LIMIT).collect();
        let text = if site.is_empty() {
            reason
        } else {
            format!("{reason} ({site})")
        };
        let tag = {
            let mut state = self.state();
            state.next_notice += 1;
            // Every notice has its own tag: Android holds an update of a snoozed one back.
            format!("nds-owner-{tab}-{}", state.next_notice)
        };
        let command = format!(
            "cmd notification post -S bigtext -t {} {} {}",
            quoted(&format!("NDS agent {group} needs you")),
            quoted(&tag),
            quoted(&text),
        );
        if notices
            .server
            .shell(&notices.serial, &command)
            .await
            .is_err()
        {
            return Answer::Cdp(
                json!({ "code": -32000, "message": "The phone refused the notification" }),
            );
        }
        let previous = self.state().notices.insert(tab, tag.clone());
        if let Some(previous) = previous {
            self.cancel_notice(&previous).await;
        }
        let _ = self
            .call(None, "Target.activateTarget", json!({ "targetId": target }))
            .await;
        Answer::Done(json!({ "notification": tag }))
    }

    async fn clear_owner(&self, tab: i64) {
        let notice = self.state().notices.remove(&tab);
        if let Some(tag) = notice {
            self.cancel_notice(&tag).await;
        }
    }

    async fn cancel_notice(&self, tag: &str) {
        let Some(notices) = &self.notices else {
            return;
        };
        // The shell posts as com.android.shell with id 2020 and its own uid, 2000.
        let key = format!("0|com.android.shell|2020|{tag}|2000");
        let command = format!(
            "cmd notification snooze --for {CLEARED_MS} {}",
            quoted(&key)
        );
        let _ = notices.server.shell(&notices.serial, &command).await;
    }
}

/// One argument for the phone's shell: single-quoted, without control characters.
fn quoted(text: &str) -> String {
    let clean: String = text.chars().filter(|c| !c.is_control()).collect();
    format!("'{}'", clean.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_and_shell_arguments_are_read_and_written_safely() {
        let browser = parse_version(
            br#"{"Browser":"Chrome/141.0.7390.122","Android-Package":"com.android.chrome","User-Agent":"Mozilla/5.0 (Linux; Android 10; K) Chrome/141.0.0.0 Mobile Safari/537.36","webSocketDebuggerUrl":"ws://localhost/devtools/browser/0b1c"}"#,
        )
        .unwrap();
        assert_eq!(browser.product, "Chrome/141.0.7390.122");
        assert_eq!(browser.package.as_deref(), Some("com.android.chrome"));
        assert_eq!(browser.path, "/devtools/browser/0b1c");
        assert!(
            parse_version(br#"{"webSocketDebuggerUrl":"ws://localhost/devtools/a b"}"#).is_none()
        );
        assert!(parse_version(br#"{"webSocketDebuggerUrl":"ws://evil/"}"#).is_none());
        assert_eq!(quoted("it's\n$(reboot)"), r"'it'\''s$(reboot)'");
    }

    /// A fake browser: answers commands as Chrome does and reports targets and sessions.
    struct Fake {
        commands: mpsc::UnboundedReceiver<Value>,
        events: mpsc::UnboundedSender<Value>,
    }

    impl Fake {
        async fn next(&mut self, method: &str) -> Value {
            loop {
                let command = tokio::time::timeout(Duration::from_secs(5), self.commands.recv())
                    .await
                    .unwrap()
                    .unwrap();
                if command["method"] == method {
                    return command;
                }
                // Side commands (discovery, Runtime.disable, the screenshot style) succeed.
                self.reply(&command, json!({}));
            }
        }
        fn reply(&self, command: &Value, result: Value) {
            let mut reply = json!({ "id": command["id"], "result": result });
            if let Some(session) = command.get("sessionId") {
                reply["sessionId"] = session.clone();
            }
            self.events.send(reply).unwrap();
        }
        fn event(&self, message: Value) {
            self.events.send(message).unwrap();
        }
    }

    struct Host {
        read: tokio::io::ReadHalf<tokio::io::DuplexStream>,
        write: tokio::io::WriteHalf<tokio::io::DuplexStream>,
        next: u64,
    }

    impl Host {
        async fn send(&mut self, mut message: Value) -> u64 {
            self.next += 1;
            message["id"] = self.next.into();
            let body = serde_json::to_vec(&message).unwrap();
            self.write
                .write_all(&(body.len() as u32).to_ne_bytes())
                .await
                .unwrap();
            self.write.write_all(&body).await.unwrap();
            self.next
        }
        async fn receive(&mut self) -> Value {
            tokio::time::timeout(Duration::from_secs(5), read_frame(&mut self.read))
                .await
                .unwrap()
                .unwrap()
        }
    }

    async fn linked() -> (Fake, Host, tokio::task::JoinHandle<Ended>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (commands_in, commands) = mpsc::unbounded_channel();
        let (events, mut events_out) = mpsc::unbounded_channel::<Value>();
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let (mut sink, mut source) = socket.split();
            tokio::spawn(async move {
                while let Some(message) = events_out.recv().await {
                    if sink.send(Message::text(message.to_string())).await.is_err() {
                        return;
                    }
                }
            });
            while let Some(Ok(Message::Text(text))) = source.next().await {
                let _ = commands_in.send(serde_json::from_str::<Value>(text.as_str()).unwrap());
            }
        });
        let stream = tokio::net::TcpStream::connect(address).await.unwrap();
        let (socket, _) =
            tokio_tungstenite::client_async("ws://localhost/devtools/browser/x", stream)
                .await
                .unwrap();
        let browser = parse_version(
            br#"{"Browser":"Chrome/141.0.7390.122","User-Agent":"UA Chrome/141.0.0.0 Mobile","webSocketDebuggerUrl":"ws://localhost/devtools/browser/x"}"#,
        )
        .unwrap();
        let (host_side, link_side) = tokio::io::duplex(1 << 20);
        let (read, write) = tokio::io::split(host_side);
        let link = tokio::spawn(async move {
            run(
                socket,
                &browser,
                "full",
                None,
                link_side,
                std::future::pending(),
            )
            .await
        });
        (
            Fake { commands, events },
            Host {
                read,
                write,
                next: 0,
            },
            link,
        )
    }

    #[tokio::test]
    async fn agent_tabs_are_opened_attached_relayed_and_released_like_extension_tabs() {
        let (mut browser, mut host, link) = linked().await;
        let hello = host.receive().await;
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["contract"], 2);
        assert_eq!(hello["downloads"], false);
        assert_eq!(hello["observation"], "full");

        // A tab the agent opens: created, attached in flatten mode and described.
        let opened = host
            .send(json!({ "type": "open", "group": "nds", "url": "https://example.com/" }))
            .await;
        let create = browser.next("Target.createTarget").await;
        browser.reply(&create, json!({ "targetId": "T1" }));
        let attach = browser.next("Target.attachToTarget").await;
        assert_eq!(
            attach["params"],
            json!({ "targetId": "T1", "flatten": true })
        );
        browser.reply(&attach, json!({ "sessionId": "S1" }));
        let info = browser.next("Target.getTargetInfo").await;
        browser.reply(&info, json!({ "targetInfo": { "targetId": "T1", "type": "page", "url": "https://example.com/" } }));
        let result = host.receive().await;
        assert_eq!(result["id"], opened);
        assert_eq!(result["result"]["tab"], 1);
        assert_eq!(result["result"]["target"]["targetId"], "T1");

        // Its commands go to its session, in order; Runtime.enable goes from disabled.
        let enable = host
            .send(json!({ "type": "cdp", "group": "nds", "tab": 1, "method": "Runtime.enable", "params": {} }))
            .await;
        let disable = browser.commands.recv().await.unwrap();
        assert_eq!(
            (disable["method"].as_str(), disable["sessionId"].as_str()),
            (Some("Runtime.disable"), Some("S1"))
        );
        browser.reply(&disable, json!({}));
        let command = browser.next("Runtime.enable").await;
        assert_eq!(command["sessionId"], "S1");
        browser.reply(&command, json!({}));
        assert_eq!(
            host.receive().await,
            json!({ "type": "result", "id": enable, "result": {} })
        );

        // Another group's request never reaches the tab.
        let foreign = host
            .send(json!({ "type": "cdp", "group": "other", "tab": 1, "method": "Page.reload" }))
            .await;
        let refused = host.receive().await;
        assert_eq!(
            (refused["id"].as_u64(), refused["error"]["code"].as_str()),
            (Some(foreign), Some("target_closed"))
        );

        // Events of the session are the tab's; a child session's carry its id; noise is dropped.
        browser.event(json!({ "sessionId": "S1", "method": "Network.dataReceived", "params": {} }));
        browser.event(json!({ "sessionId": "S1", "method": "Target.attachedToTarget", "params": { "sessionId": "C1", "targetInfo": { "type": "iframe" } } }));
        browser.event(json!({ "sessionId": "C1", "method": "Runtime.consoleAPICalled", "params": { "type": "log" } }));
        let attached = host.receive().await;
        assert_eq!(
            (attached["tab"].as_i64(), attached["method"].as_str()),
            (Some(1), Some("Target.attachedToTarget"))
        );
        assert!(attached.get("session").is_none());
        let child = host.receive().await;
        assert_eq!(
            (child["session"].as_str(), child["method"].as_str()),
            (Some("C1"), Some("Runtime.consoleAPICalled"))
        );
        // CDP errors keep Chrome's error object.
        let missing = host
            .send(json!({ "type": "cdp", "group": "nds", "tab": 1, "session": "C1", "method": "Nope.nope" }))
            .await;
        let command = browser.next("Nope.nope").await;
        assert_eq!(command["sessionId"], "C1");
        browser.event(json!({ "id": command["id"], "sessionId": "C1", "error": { "code": -32601, "message": "'Nope.nope' wasn't found" } }));
        let error = host.receive().await;
        assert_eq!(error["id"], missing);
        assert_eq!(error["error"]["code"], "cdp_error");
        let object: Value =
            serde_json::from_str(error["error"]["message"].as_str().unwrap()).unwrap();
        assert_eq!(object["code"], -32601);

        // A page the agent tab opens joins its group.
        browser.event(json!({ "method": "Target.targetCreated", "params": { "targetInfo": { "targetId": "T2", "type": "page", "openerId": "T1" } } }));
        browser.event(json!({ "method": "Target.targetCreated", "params": { "targetInfo": { "targetId": "T9", "type": "page" } } }));
        let attach = browser.next("Target.attachToTarget").await;
        assert_eq!(attach["params"]["targetId"], "T2");
        browser.reply(&attach, json!({ "sessionId": "S2" }));
        let info = browser.next("Target.getTargetInfo").await;
        browser.reply(
            &info,
            json!({ "targetInfo": { "targetId": "T2", "type": "page", "openerId": "T1" } }),
        );
        let adopted = host.receive().await;
        assert_eq!(
            adopted,
            json!({ "type": "attached", "tab": 2, "group": "nds", "target": { "targetId": "T2", "type": "page", "openerId": "T1" } })
        );

        // A closed popup is reported as detached.
        browser.event(json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": "S2", "targetId": "T2" } }));
        browser
            .event(json!({ "method": "Target.targetDestroyed", "params": { "targetId": "T2" } }));
        assert_eq!(
            host.receive().await,
            json!({ "type": "detached", "tab": 2, "reason": "target_closed" })
        );

        // A release that keeps tabs detaches them; the next claim attaches them again.
        let released = host
            .send(json!({ "type": "release", "group": "nds", "close": false }))
            .await;
        let detach = browser.next("Target.detachFromTarget").await;
        assert_eq!(detach["params"]["sessionId"], "S1");
        browser.reply(&detach, json!({}));
        browser.event(json!({ "method": "Target.detachedFromTarget", "params": { "sessionId": "S1", "targetId": "T1" } }));
        assert_eq!(
            host.receive().await,
            json!({ "type": "result", "id": released, "result": { "released": true } })
        );
        let claimed = host.send(json!({ "type": "claim", "group": "nds" })).await;
        let attach = browser.next("Target.attachToTarget").await;
        browser.reply(&attach, json!({ "sessionId": "S3" }));
        let info = browser.next("Target.getTargetInfo").await;
        browser.reply(
            &info,
            json!({ "targetInfo": { "targetId": "T1", "type": "page" } }),
        );
        let claim = host.receive().await;
        assert_eq!(claim["id"], claimed);
        assert_eq!(
            claim["result"]["tabs"],
            json!([{ "tab": 1, "target": { "targetId": "T1", "type": "page" } }])
        );

        // Closing the tab reports it detached once the browser destroyed it.
        let close = host
            .send(json!({ "type": "close", "group": "nds", "tab": 1 }))
            .await;
        let command = browser.next("Target.closeTarget").await;
        browser.reply(&command, json!({ "success": true }));
        assert_eq!(
            host.receive().await,
            json!({ "type": "result", "id": close, "result": {} })
        );
        browser
            .event(json!({ "method": "Target.targetDestroyed", "params": { "targetId": "T1" } }));
        assert_eq!(
            host.receive().await,
            json!({ "type": "detached", "tab": 1, "reason": "target_closed" })
        );

        // The link ends with the host.
        drop(host);
        assert_eq!(link.await.unwrap(), Ended::Host);
    }
}
