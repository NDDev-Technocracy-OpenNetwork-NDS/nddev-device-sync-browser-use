//! One Bun process per session running agent Playwright code.
//!
//! The process has the invoking user's authority (ADR 0015); it is reached
//! only through this host. Dropping an executor kills it, so a timeout,
//! disconnect or revocation cannot leave agent code running. It starts with
//! its session and runs no code until it reports ready; a start that outlasts
//! one execution's deadline goes on for the next, within its own limit.

use super::Config;
use crate::{
    protocol::{OUTPUT_LIMIT, Refusal},
    view::ScriptFailure,
};
use futures_util::FutureExt;
use serde::Deserialize;
use std::{
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

/// A reply line carries at most the bounded output plus JSON escaping.
const LINE_LIMIT: u64 = 6 * OUTPUT_LIMIT as u64 + 4096;
const READY_LIMIT: usize = 64;
/// How long a start may take, however many executions wait for it.
const START: Duration = Duration::from_secs(60);

pub(crate) struct Executor {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
    start: Start,
    /// The ready line as far as it has been read.
    line: Vec<u8>,
}

#[derive(Clone, Copy)]
enum Start {
    Starting(Instant),
    Ready,
    Failed,
}

#[derive(Deserialize)]
struct Ready {
    ready: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Completed {
    id: u64,
    ok: bool,
    #[serde(default)]
    error: Option<String>,
    output: String,
    truncated: bool,
}

impl Executor {
    /// Starts the process without waiting for it to get ready.
    pub fn start(config: &Config, endpoint: &str, artifacts: &Path) -> Result<Self, Refusal> {
        let mut command = Command::new(&config.bun);
        command
            .arg(&config.executor)
            .arg(endpoint)
            .arg(artifacts)
            .env_clear()
            .env("TMPDIR", artifacts)
            .env("TEMP", artifacts)
            .env("TMP", artifacts)
            .env("NO_COLOR", "1")
            .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0")
            .current_dir(artifacts)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Executor diagnostics can contain page data; they are not logged.
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // Windows sockets and Bun need the system root and the user profile there.
        for name in ["HOME", "SystemRoot", "USERPROFILE"] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        let mut child = command.spawn().map_err(|_| Refusal::ExecutorUnavailable)?;
        let input = child.stdin.take().ok_or(Refusal::ExecutorUnavailable)?;
        let output = BufReader::new(child.stdout.take().ok_or(Refusal::ExecutorUnavailable)?);
        Ok(Self {
            child,
            input,
            output,
            next: 0,
            start: Start::Starting(Instant::now()),
            line: Vec::new(),
        })
    }

    /// Waits until the process is ready. A wait that reaches `deadline` is a timeout that keeps
    /// the start going; one that reaches the start's own limit makes the executor unavailable.
    pub async fn ready(&mut self, deadline: Instant) -> Result<(), Refusal> {
        let limit = match self.start {
            Start::Ready => return Ok(()),
            Start::Failed => return Err(Refusal::ExecutorUnavailable),
            Start::Starting(started) => started + START,
        };
        let read = ready_line(&mut self.output, &mut self.line);
        let result = started(read, deadline, limit).await;
        self.settle(&result);
        result
    }

    /// Whether the process has reported ready, reading only what it has already written.
    pub fn is_ready(&mut self) -> bool {
        if let Start::Starting(_) = self.start
            && let Some(result) = ready_line(&mut self.output, &mut self.line).now_or_never()
        {
            self.settle(&result);
        }
        matches!(self.start, Start::Ready)
    }

    fn settle(&mut self, result: &Result<(), Refusal>) {
        match result {
            Ok(()) => self.start = Start::Ready,
            Err(Refusal::Timeout) => return,
            Err(_) => self.start = Start::Failed,
        }
        self.line = Vec::new();
    }

    /// Kills the process and waits until it has exited.
    pub async fn stop(mut self) {
        let _ = self.child.kill().await;
    }

    pub async fn run(
        &mut self,
        code: &str,
        deadline: Instant,
    ) -> Result<(Option<ScriptFailure>, String, bool), Refusal> {
        if !matches!(self.start, Start::Ready) {
            return Err(Refusal::ExecutorUnavailable);
        }
        self.next += 1;
        let mut line = serde_json::to_vec(&serde_json::json!({ "id": self.next, "code": code }))
            .map_err(|_| Refusal::InvalidRequest)?;
        line.push(b'\n');
        within(deadline, async {
            self.input
                .write_all(&line)
                .await
                .map_err(|_| Refusal::ExecutorUnavailable)?;
            self.input
                .flush()
                .await
                .map_err(|_| Refusal::ExecutorUnavailable)
        })
        .await?;
        loop {
            let line = within(deadline, read_line(&mut self.output)).await?;
            let completed: Completed =
                serde_json::from_slice(&line).map_err(|_| Refusal::ExecutorUnavailable)?;
            if completed.id != self.next {
                continue;
            }
            let failure = match (completed.ok, completed.error.as_deref()) {
                (true, _) => None,
                (false, Some("target_closed")) => Some(ScriptFailure::TargetClosed),
                (false, Some("browser_disconnected")) => Some(ScriptFailure::BrowserDisconnected),
                (false, Some("invalid_request")) => return Err(Refusal::InvalidRequest),
                (false, _) => Some(ScriptFailure::ScriptError),
            };
            return Ok((failure, completed.output, completed.truncated));
        }
    }
}

async fn within<T>(
    deadline: Instant,
    work: impl Future<Output = Result<T, Refusal>>,
) -> Result<T, Refusal> {
    tokio::time::timeout_at(deadline.into(), work)
        .await
        .unwrap_or(Err(Refusal::Timeout))
}

/// Waits for a start until the caller's deadline or the start's limit, whichever comes first.
async fn started(
    ready: impl Future<Output = Result<(), Refusal>>,
    deadline: Instant,
    limit: Instant,
) -> Result<(), Refusal> {
    match tokio::time::timeout_at(deadline.min(limit).into(), ready).await {
        Ok(result) => result,
        Err(_) if limit <= deadline => Err(Refusal::ExecutorUnavailable),
        Err(_) => Err(Refusal::Timeout),
    }
}

/// Reads the ready line into `line`. An interrupted read keeps what it took, so the next one
/// continues it.
async fn ready_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
) -> Result<(), Refusal> {
    let room = READY_LIMIT.saturating_sub(line.len()) as u64;
    reader
        .take(room)
        .read_until(b'\n', line)
        .await
        .map_err(|_| Refusal::ExecutorUnavailable)?;
    match line.split_last() {
        Some((b'\n', ready)) => match serde_json::from_slice::<Ready>(ready) {
            Ok(Ready { ready: true }) => Ok(()),
            _ => Err(Refusal::ExecutorUnavailable),
        },
        // The executor exited before it was ready, or wrote more than a ready line.
        _ => Err(Refusal::ExecutorUnavailable),
    }
}

async fn read_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<u8>, Refusal> {
    let mut line = Vec::new();
    let read = reader
        .take(LINE_LIMIT)
        .read_until(b'\n', &mut line)
        .await
        .map_err(|_| Refusal::ExecutorUnavailable)?;
    if read == 0 || line.pop() != Some(b'\n') {
        // The executor exited (browser disconnect, revocation) or overran its line bound.
        return Err(Refusal::ExecutorUnavailable);
    }
    Ok(line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn lines_are_bounded_and_eof_is_not_success() {
        let mut complete: &[u8] = b"{\"ready\":true}\n";
        assert_eq!(read_line(&mut complete).await.unwrap(), b"{\"ready\":true}");
        let mut closed: &[u8] = b"";
        assert_eq!(
            read_line(&mut closed).await,
            Err(Refusal::ExecutorUnavailable)
        );
        let mut partial: &[u8] = b"{\"id\":1";
        assert_eq!(
            read_line(&mut partial).await,
            Err(Refusal::ExecutorUnavailable)
        );
    }

    #[tokio::test]
    async fn an_expired_deadline_is_a_timeout() {
        let pending = std::future::pending::<Result<(), Refusal>>();
        assert_eq!(within(Instant::now(), pending).await, Err(Refusal::Timeout));
    }

    #[tokio::test]
    async fn a_start_outlasting_a_deadline_continues_and_its_own_limit_ends_it() {
        let now = Instant::now();
        let later = now + Duration::from_secs(60);
        let pending = || std::future::pending::<Result<(), Refusal>>();
        assert_eq!(started(pending(), now, later).await, Err(Refusal::Timeout));
        assert_eq!(
            started(pending(), later, now).await,
            Err(Refusal::ExecutorUnavailable)
        );
    }

    #[tokio::test]
    async fn an_interrupted_ready_line_continues_where_it_stopped() {
        let (mut writer, reader) = tokio::io::duplex(64);
        let mut reader = BufReader::new(reader);
        let mut line = Vec::new();
        writer.write_all(b"{\"ready\"").await.unwrap();
        let soon = Instant::now() + Duration::from_millis(50);
        let interrupted = within(soon, ready_line(&mut reader, &mut line)).await;
        assert_eq!(interrupted, Err(Refusal::Timeout));
        writer.write_all(b":true}\n").await.unwrap();
        assert_eq!(ready_line(&mut reader, &mut line).await, Ok(()));

        for written in [&b"{\"ready\":false}\n"[..], b"", &[b'x'; 80]] {
            let (mut writer, reader) = tokio::io::duplex(128);
            writer.write_all(written).await.unwrap();
            drop(writer);
            let mut line = Vec::new();
            let result = ready_line(&mut BufReader::new(reader), &mut line).await;
            assert_eq!(result, Err(Refusal::ExecutorUnavailable));
        }
    }
}
