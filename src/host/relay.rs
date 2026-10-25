//! Session-scoped CDP endpoint for the executor's Playwright connection.
//!
//! `chrome.debugger` exposes tab targets only, so the host answers the
//! browser-level calls Playwright needs and limits every target to the
//! session's own tab group. Commands it cannot honour fail visibly.

use super::{EXTENSION_REPLY, Failure, Host, MAX_TABS, Waiter, tab_session};
use crate::CancellationToken;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::{
    net::{UnixListener, UnixStream},
    sync::{OwnedSemaphorePermit, Semaphore, mpsc},
};
use tokio_tungstenite::tungstenite::{
    Message,
    handshake::server::{ErrorResponse, Request, Response},
    http::StatusCode,
    protocol::WebSocketConfig,
};

const CONNECTIONS: usize = 16;
const QUEUE: usize = 4096;
const IN_FLIGHT: usize = 256;
/// Client commands go to Chrome through a 1 MiB native messaging limit.
const COMMAND_LIMIT: usize = 1_048_576;
/// Results such as full-page screenshots return through the 32 MiB extension limit.
const MESSAGE_LIMIT: usize = 32 * 1_048_576;
const BROWSER_TARGET: &str = "nds-browser";

static NEXT_CLIENT: AtomicU64 = AtomicU64::new(1);

pub(crate) struct Client {
    pub id: u64,
    pub auto_attach: bool,
    outbound: mpsc::Sender<String>,
    closed: CancellationToken,
}

impl Client {
    pub fn send(&self, message: &Value) -> bool {
        self.outbound.try_send(message.to_string()).is_ok()
    }
}

/// A client command awaiting Chrome's reply; holds one in-flight slot.
pub(crate) struct Forward {
    pub project: String,
    pub client: u64,
    pub id: Value,
    pub session: String,
    pub deadline: Instant,
    _permit: OwnedSemaphorePermit,
}

impl Drop for Client {
    /// Revocation, session close or a full queue ends the connection.
    fn drop(&mut self) {
        self.closed.cancel();
    }
}

pub(crate) async fn serve(host: Arc<Host>, listener: UnixListener) {
    let permits = Arc::new(Semaphore::new(CONNECTIONS));
    while let Ok((stream, _)) = listener.accept().await {
        let Ok(permit) = permits.clone().try_acquire_owned() else {
            continue;
        };
        let host = host.clone();
        tokio::spawn(async move {
            let _permit = permit;
            connection(host, stream).await;
        });
    }
}

#[expect(
    clippy::result_large_err,
    reason = "tungstenite fixes the handshake callback signature"
)]
async fn connection(host: Arc<Host>, stream: UnixStream) {
    let mut token = None;
    let accept = |request: &Request, response: Response| {
        // Browsers always send Origin; the private socket only serves executors.
        if request.headers().contains_key("origin") {
            return Err(rejection(StatusCode::FORBIDDEN));
        }
        token = request
            .uri()
            .path()
            .strip_prefix("/session/")
            .map(str::to_owned);
        Ok(response)
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(COMMAND_LIMIT))
        .max_frame_size(Some(COMMAND_LIMIT));
    let Ok(socket) =
        tokio_tungstenite::accept_hdr_async_with_config(stream, accept, Some(config)).await
    else {
        return;
    };
    let Some(token) = token else { return };
    let (outbound, mut queue) = mpsc::channel::<String>(QUEUE);
    let closed = CancellationToken::new();
    let id = NEXT_CLIENT.fetch_add(1, Ordering::Relaxed);
    let Some(project) = host.bind(
        &token,
        Client {
            id,
            auto_attach: false,
            outbound: outbound.clone(),
            closed: closed.clone(),
        },
    ) else {
        return;
    };
    let (mut sink, mut source) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(message) = queue.recv().await {
            if message.len() > MESSAGE_LIMIT || sink.send(Message::text(message)).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });
    let in_flight = Arc::new(Semaphore::new(IN_FLIGHT));
    loop {
        let message = tokio::select! {
            () = closed.cancelled() => break,
            message = source.next() => message,
        };
        let Some(Ok(Message::Text(text))) = message else {
            break;
        };
        let Ok(command) = serde_json::from_str::<Value>(text.as_str()) else {
            break;
        };
        let Ok(permit) = in_flight.clone().acquire_owned().await else {
            break;
        };
        if command["sessionId"].is_string() {
            // Target commands are queued here, in arrival order.
            host.forward(&project, id, command, permit).await;
            continue;
        }
        let (host, project, outbound) = (host.clone(), project.clone(), outbound.clone());
        tokio::spawn(async move {
            let _permit = permit;
            let reply = host.browser(&project, id, command).await;
            let _ = outbound.send(reply.to_string()).await;
        });
    }
    host.unbind(&project, id);
    drop(outbound);
    writer.abort();
}

fn rejection(status: StatusCode) -> ErrorResponse {
    let mut response = ErrorResponse::new(None);
    *response.status_mut() = status;
    response
}

impl Host {
    /// Attaches the executor connection to the session that owns `token`.
    fn bind(&self, token: &str, client: Client) -> Option<String> {
        let mut state = self.state();
        if !state.enabled {
            return None;
        }
        let (project, session) = state
            .sessions
            .iter_mut()
            .find(|(_, session)| session.token == token)?;
        if session.client.is_some() {
            return None;
        }
        session.client = Some(client);
        Some(project.clone())
    }

    fn unbind(&self, project: &str, id: u64) {
        let mut state = self.state();
        if let Some(session) = state.sessions.get_mut(project).filter(|session| {
            session
                .client
                .as_ref()
                .is_some_and(|client| client.id == id)
        }) {
            session.client = None;
        }
    }

    async fn browser(&self, project: &str, client: u64, command: Value) -> Value {
        let method = command["method"].as_str().unwrap_or_default();
        let params = command.get("params").cloned().unwrap_or_else(|| json!({}));
        let result = self.browser_command(project, client, method, params).await;
        reply(command["id"].clone(), None, result)
    }

    /// Routes a target command to its agent tab; the reply arrives through
    /// [`Host::answer`] in the extension's order.
    async fn forward(
        &self,
        project: &str,
        client: u64,
        command: Value,
        permit: OwnedSemaphorePermit,
    ) {
        let session = command["sessionId"].as_str().unwrap_or_default().to_owned();
        let forward = Forward {
            project: project.to_owned(),
            client,
            id: command["id"].clone(),
            session: session.clone(),
            deadline: Instant::now() + EXTENSION_REPLY,
            _permit: permit,
        };
        let method = command["method"].as_str().unwrap_or_default();
        let params = command.get("params").cloned().unwrap_or_else(|| json!({}));
        let message = match self.route(project, &session, method, params) {
            Ok(message) => message,
            Err(failure) => return self.answer(forward, Err(failure)),
        };
        let (id, session) = (forward.id.clone(), forward.session.clone());
        if let Err(failure) = self.submit(message, Waiter::Forward(forward)).await {
            // A failed submission drops its waiter; answer the client directly.
            self.reply_to(project, client, reply(id, Some(session), Err(failure)));
        }
    }

    async fn browser_command(
        &self,
        project: &str,
        client: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, Failure> {
        match method {
            "Browser.getVersion" => {
                let state = self.state();
                Ok(json!({
                    "protocolVersion": "1.3",
                    "product": state.browser,
                    "revision": "",
                    "userAgent": state.user_agent,
                    "jsVersion": "",
                }))
            }
            // Downloads keep the browser's own policy; Playwright download
            // events are not produced for agent tabs.
            "Browser.setDownloadBehavior" | "Target.setDiscoverTargets" => Ok(json!({})),
            "Target.setAutoAttach" => {
                let mut state = self.state();
                let events: Vec<Value> = state
                    .tabs
                    .iter()
                    .filter(|(_, tab)| tab.project == project)
                    .map(|(id, tab)| attached_event(*id, &tab.info))
                    .collect();
                let session = state
                    .sessions
                    .get_mut(project)
                    .ok_or(Failure::Refused(crate::protocol::Refusal::SessionNotFound))?;
                if let Some(current) = session
                    .client
                    .as_mut()
                    .filter(|current| current.id == client)
                {
                    current.auto_attach = true;
                    for event in &events {
                        current.send(event);
                    }
                }
                Ok(json!({}))
            }
            "Target.getTargets" => {
                let state = self.state();
                let infos: Vec<Value> = state
                    .tabs
                    .values()
                    .filter(|tab| tab.project == project)
                    .map(|tab| tab.info.clone())
                    .collect();
                Ok(json!({ "targetInfos": infos }))
            }
            "Target.getTargetInfo" if params.get("targetId").is_none() => Ok(json!({
                "targetInfo": { "targetId": BROWSER_TARGET, "type": "browser", "title": "", "url": "", "attached": true, "canAccessOpener": false }
            })),
            "Target.getBrowserContexts" => Ok(json!({ "browserContextIds": [] })),
            "Target.createTarget" => {
                {
                    let state = self.state();
                    if state
                        .tabs
                        .values()
                        .filter(|tab| tab.project == project)
                        .count()
                        >= MAX_TABS
                    {
                        return Err(Failure::Refused(crate::protocol::Refusal::Capacity));
                    }
                }
                let url = params["url"]
                    .as_str()
                    .filter(|url| !url.is_empty())
                    .unwrap_or("about:blank");
                let opened = self
                    .request(json!({ "type": "open", "group": project, "url": url }))
                    .await?;
                let tab = opened["tab"]
                    .as_i64()
                    .ok_or(Failure::Refused(crate::protocol::Refusal::TargetClosed))?;
                let target = opened["target"]["targetId"].clone();
                let mut state = self.state();
                if !self.register(&mut state, project, tab, opened["target"].clone()) {
                    return Err(Failure::Refused(crate::protocol::Refusal::Capacity));
                }
                Ok(json!({ "targetId": target }))
            }
            "Target.closeTarget" => {
                let tab =
                    self.owned_target(project, params["targetId"].as_str().unwrap_or_default())?;
                self.request(json!({ "type": "close", "tab": tab })).await?;
                Ok(json!({ "success": true }))
            }
            _ => Err(Failure::Cdp(json!({
                "code": -32601,
                "message": format!("'{method}' is not available to NDS agent sessions"),
            }))),
        }
    }

    fn route(
        &self,
        project: &str,
        session: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, Failure> {
        let (tab, child) = {
            let state = self.state();
            let (tab, child) = match state
                .tabs
                .iter()
                .find(|(id, _)| tab_session(**id) == session)
            {
                Some((id, _)) => (*id, None),
                None => match state.children.get(session) {
                    Some(tab) => (*tab, Some(session.to_owned())),
                    None => return Err(not_found()),
                },
            };
            if state
                .tabs
                .get(&tab)
                .is_none_or(|entry| entry.project != project)
            {
                return Err(not_found());
            }
            (tab, child)
        };
        let mut message = json!({ "type": "cdp", "tab": tab, "method": method, "params": params });
        if let Some(child) = child {
            message["session"] = child.into();
        }
        Ok(message)
    }

    fn owned_target(&self, project: &str, target: &str) -> Result<i64, Failure> {
        let state = self.state();
        state
            .tabs
            .iter()
            .find(|(_, tab)| tab.project == project && tab.target == target)
            .map(|(id, _)| *id)
            .ok_or_else(|| {
                Failure::Cdp(json!({ "code": -32602, "message": "No target with given id found" }))
            })
    }
}

/// A CDP response for one client command.
pub(super) fn reply(id: Value, session: Option<String>, result: Result<Value, Failure>) -> Value {
    let mut reply = match result {
        Ok(result) => json!({ "id": id, "result": result }),
        Err(Failure::Cdp(error)) => json!({ "id": id, "error": error }),
        Err(Failure::Refused(refusal)) => {
            let message = if refusal == crate::protocol::Refusal::TargetClosed {
                "Target closed".to_owned()
            } else {
                refusal.to_string()
            };
            json!({ "id": id, "error": { "code": -32000, "message": message } })
        }
    };
    if let Some(session) = session {
        reply["sessionId"] = session.into();
    }
    reply
}

pub(super) fn attached_event(tab: i64, info: &Value) -> Value {
    json!({
        "method": "Target.attachedToTarget",
        "params": { "sessionId": tab_session(tab), "targetInfo": info, "waitingForDebugger": false },
    })
}

fn not_found() -> Failure {
    Failure::Cdp(json!({ "code": -32001, "message": "Session with given id not found." }))
}
