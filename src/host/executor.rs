//! One Bun process per session running agent Playwright code.
//!
//! The process has the invoking user's authority (ADR 0015); it is reached
//! only through this host. Dropping an executor kills it, so a timeout,
//! disconnect or revocation cannot leave agent code running.

use super::Config;
use crate::{
    protocol::{OUTPUT_LIMIT, Refusal},
    view::ScriptFailure,
};
use serde::Deserialize;
use std::{path::Path, process::Stdio, time::Instant};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

/// A reply line carries at most the bounded output plus JSON escaping.
const LINE_LIMIT: u64 = 6 * OUTPUT_LIMIT as u64 + 4096;

pub(crate) struct Executor {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next: u64,
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
    pub async fn spawn(
        config: &Config,
        endpoint: &str,
        artifacts: &Path,
        deadline: Instant,
    ) -> Result<Self, Refusal> {
        let mut command = Command::new(&config.bun);
        command
            .arg(&config.executor)
            .arg(endpoint)
            .arg(artifacts)
            .env_clear()
            .env("TMPDIR", artifacts)
            .env("NO_COLOR", "1")
            .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0")
            .current_dir(artifacts)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // Executor diagnostics can contain page data; they are not logged.
            .stderr(Stdio::null())
            .kill_on_drop(true);
        if let Some(home) = std::env::var_os("HOME") {
            command.env("HOME", home);
        }
        let mut child = command.spawn().map_err(|_| Refusal::ExecutorUnavailable)?;
        let input = child.stdin.take().ok_or(Refusal::ExecutorUnavailable)?;
        let mut output = BufReader::new(child.stdout.take().ok_or(Refusal::ExecutorUnavailable)?);
        let line = within(deadline, read_line(&mut output)).await?;
        match serde_json::from_slice::<Ready>(&line) {
            Ok(Ready { ready: true }) => Ok(Self {
                _child: child,
                input,
                output,
                next: 0,
            }),
            _ => Err(Refusal::ExecutorUnavailable),
        }
    }

    pub async fn run(
        &mut self,
        code: &str,
        deadline: Instant,
    ) -> Result<(Option<ScriptFailure>, String, bool), Refusal> {
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
}
