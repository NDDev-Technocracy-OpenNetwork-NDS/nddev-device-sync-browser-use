//! `nds-browser-use`: the agent CLI and, when Chrome starts it, the native host.
#![cfg_attr(not(any(unix, windows)), allow(unused))]

#[cfg(any(unix, windows))]
use nddev_device_sync_browser_use::{
    BrowserUse, BrowserUseClient, CancellationToken, Error, NativeIo, host, install,
    protocol::Document,
};
use std::process::ExitCode;
#[cfg(any(unix, windows))]
use std::{path::PathBuf, time::Duration};

const USAGE: &str = "usage:
  nds-browser-use skill
  nds-browser-use status
  nds-browser-use update
  nds-browser-use session new <project>
  nds-browser-use session list
  nds-browser-use session close <project> [--keep-tabs]
  nds-browser-use -s <project> (-e <code> | -f <file>) [--timeout <ms>] [--expect <target>:<document>] [--json]
  nds-browser-use install --bun <path> --executor <path> (--browser <chrome|chrome-beta|chrome-for-testing|chromium> | --host-dir <path>)";
/// How agents use the tool, printed by `nds-browser-use skill`.
const AGENT_GUIDE: &str = include_str!("../../docs/agent-guide.md");
const ARGUMENT_LIMIT: usize = 16;
const CODE_LIMIT: usize = 60_000;

#[cfg(not(any(unix, windows)))]
fn main() -> ExitCode {
    eprintln!("nds-browser-use is not supported on this platform");
    ExitCode::from(2)
}

#[cfg(any(unix, windows))]
#[tokio::main]
async fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.len() > ARGUMENT_LIMIT {
        return usage();
    }
    let host_mode = arguments
        .first()
        .is_some_and(|first| first.starts_with("chrome-extension://"));
    // stdout carries native messaging in host mode; local telemetry uses stderr. The host emits
    // browser.* for every client request, so a client writes its own stream only inside an
    // explicit SDK debug window (NDS_LOG_MODE=debug); agents read a client's stderr.
    let debug =
        nddev_device_sync_telemetry::DebugWindow::from_settings(|name| std::env::var(name).ok());
    let _telemetry = match (host_mode, debug) {
        (true, _) => Some(Telemetry::install(true, None)),
        (false, Ok(Some(window))) => Some(Telemetry::install(false, Some(window))),
        (false, Ok(None)) => None,
        (false, Err(_)) => {
            eprintln!(
                "Error (invalid_configuration): NDS_LOG_MODE and NDS_DEBUG_* do not name a valid debug window"
            );
            return ExitCode::from(2);
        }
    };
    if host_mode {
        // A foreign caller is refused before any local configuration is read.
        if !host::admitted(&arguments[0]) {
            tracing::error!(event.name = "browser.host.failed", outcome = "error", error.type = host_error(&host::HostError::Origin));
            return ExitCode::from(2);
        }
        return match install::load() {
            Ok(config) => match host::run(&arguments[0], config).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    tracing::error!(event.name = "browser.host.failed", outcome = "error", error.type = host_error(&error));
                    ExitCode::from(2)
                }
            },
            Err(error) => {
                tracing::error!(event.name = "browser.host.failed", outcome = "error", error.type = error.code());
                ExitCode::from(2)
            }
        };
    }
    let words: Vec<&str> = arguments.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["install", rest @ ..] => install_host(rest),
        ["skill"] => {
            print!("{AGENT_GUIDE}");
            ExitCode::SUCCESS
        }
        [] => usage(),
        _ => client(&words).await,
    }
}

#[cfg(any(unix, windows))]
fn host_error(error: &host::HostError) -> &'static str {
    match error {
        host::HostError::Origin => "origin_rejected",
        host::HostError::Busy => "busy",
        host::HostError::Io(error) => error.code(),
    }
}

#[cfg(any(unix, windows))]
async fn client(words: &[&str]) -> ExitCode {
    let client = match BrowserUseClient::for_current_user(
        NativeIo::new(1).expect("one slot is valid").local_handle(),
    ) {
        Ok(client) => client,
        Err(error) => return failed(&error),
    };
    let cancellation = CancellationToken::new();
    let result = match words {
        ["status"] => client
            .status(cancellation)
            .await
            .map(|status| print(&status)),
        ["update"] => client
            .update(cancellation)
            .await
            .map(|reload| print(&serde_json::json!({ "reload": reload }))),
        ["session", "new", project] => client
            .open(project, cancellation)
            .await
            .map(|session| print(&session)),
        ["session", "list"] => client
            .sessions(cancellation)
            .await
            .map(|sessions| print(&sessions)),
        // Closing a session closes its tabs unless the agent keeps them for the owner;
        // `--close-tabs` stays accepted for scripts written before that was the default.
        ["session", "close", project] | ["session", "close", project, "--close-tabs"] => client
            .close(project, true, cancellation)
            .await
            .map(|()| print(&serde_json::json!({ "closed": project }))),
        ["session", "close", project, "--keep-tabs"] => client
            .close(project, false, cancellation)
            .await
            .map(|()| print(&serde_json::json!({ "closed": project }))),
        ["-s", project, rest @ ..] => {
            let Some(execution) = Execution::parse(rest) else {
                return usage();
            };
            return match client
                .execute(
                    project,
                    &execution.code,
                    execution.timeout,
                    execution.expect,
                    cancellation,
                )
                .await
            {
                Ok(outcome) if execution.json => {
                    print(&outcome);
                    if outcome.failure.is_none() {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::from(1)
                    }
                }
                // Agents read plain text: the result on stdout, a failed script's on stderr.
                Ok(outcome) if outcome.failure.is_none() => {
                    println!("{}", outcome.output);
                    ExitCode::SUCCESS
                }
                Ok(outcome) => {
                    eprintln!("{}", outcome.output);
                    ExitCode::from(1)
                }
                Err(error) if execution.json => failed(&error),
                Err(error) => {
                    eprintln!("Error ({}): {error}", code(&error));
                    ExitCode::from(2)
                }
            };
        }
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => failed(&error),
    }
}

#[cfg(any(unix, windows))]
struct Execution {
    code: String,
    timeout: Duration,
    expect: Option<Document>,
    /// The protocol answer as JSON, for scripts and NDS; agents read the text form.
    json: bool,
}

#[cfg(any(unix, windows))]
impl Execution {
    fn parse(mut words: &[&str]) -> Option<Self> {
        let (mut code, mut timeout, mut expect, mut json) =
            (None, Duration::from_secs(10), None, false);
        loop {
            let (flag, value, rest) = match words {
                [] => break,
                ["--json", rest @ ..] => {
                    json = true;
                    words = rest;
                    continue;
                }
                [flag, value, rest @ ..] => (*flag, *value, rest),
                _ => return None,
            };
            match flag {
                "-e" => code = Some(value.to_owned()),
                "-f" => code = Some(read_code(value)?),
                "--timeout" => timeout = Duration::from_millis(value.parse().ok()?),
                "--expect" => {
                    let (target, document) = value.split_once(':')?;
                    expect = Some(Document {
                        target: target.into(),
                        document: document.into(),
                    });
                }
                _ => return None,
            }
            words = rest;
        }
        let code = code.filter(|code| code.len() <= CODE_LIMIT)?;
        Some(Self {
            code,
            timeout,
            expect,
            json,
        })
    }
}

#[cfg(any(unix, windows))]
fn read_code(path: &str) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    (metadata.len() <= CODE_LIMIT as u64)
        .then(|| std::fs::read_to_string(path).ok())
        .flatten()
}

#[cfg(any(unix, windows))]
fn install_host(words: &[&str]) -> ExitCode {
    let (mut bun, mut executor, mut directory) = (None, None, None);
    #[cfg(windows)]
    let mut browser = None;
    let mut rest = words;
    while let [flag, value, tail @ ..] = rest {
        match *flag {
            "--bun" => bun = Some(PathBuf::from(value)),
            "--executor" => executor = Some(PathBuf::from(value)),
            // Windows browsers find hosts only through the registry key of a named browser.
            "--host-dir" if cfg!(unix) => directory = Some(Ok(PathBuf::from(value))),
            "--browser" => match install::Browser::parse(value) {
                Some(chosen) => {
                    #[cfg(windows)]
                    {
                        browser = Some(chosen);
                    }
                    directory = Some(install::host_directory(chosen));
                }
                None => return usage(),
            },
            _ => return usage(),
        }
        rest = tail;
    }
    let (Some(bun), Some(executor), Some(directory), []) = (bun, executor, directory, rest) else {
        return usage();
    };
    let installed = directory.and_then(|directory| {
        let host = std::env::current_exe()
            .map_err(|_| nddev_device_sync_browser_use::IoError::Unavailable)?;
        let installation = install::install(&host, &directory, &bun, &executor)?;
        #[cfg(windows)]
        install::register(
            browser.ok_or(nddev_device_sync_browser_use::IoError::InvalidConfiguration)?,
            &installation.manifest,
        )?;
        Ok(installation)
    });
    match installed {
        Ok(installation) => {
            print(&serde_json::json!({
                "manifest": installation.manifest,
                "config": installation.config,
                "extension_ids": nddev_device_sync_browser_use::EXTENSION_IDS,
            }));
            ExitCode::SUCCESS
        }
        Err(error) => failed(&Error::Io(error)),
    }
}

#[cfg(any(unix, windows))]
fn print<T: serde::Serialize>(value: &T) {
    if let Ok(text) = serde_json::to_string(value) {
        println!("{text}");
    }
}

#[cfg(any(unix, windows))]
fn failed(error: &Error) -> ExitCode {
    print(&serde_json::json!({ "error": code(error), "message": error.to_string() }));
    ExitCode::from(2)
}

#[cfg(any(unix, windows))]
fn code(error: &Error) -> &'static str {
    match error {
        Error::Io(error) => error.code(),
        Error::Refused(refusal) => refusal.code(),
        Error::InvalidResponse => "invalid_response",
        Error::UnsupportedPlatform => "unsupported_platform",
    }
}

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}

/// Schema-validated local events. Export follows agent composition (ADR 0015).
#[cfg(any(unix, windows))]
struct Telemetry {
    logger: Option<nddev_device_sync_telemetry::Logger>,
    provider: opentelemetry_sdk::trace::SdkTracerProvider,
}

#[cfg(any(unix, windows))]
impl Telemetry {
    fn install(host_mode: bool, debug: Option<nddev_device_sync_telemetry::DebugWindow>) -> Self {
        use opentelemetry::trace::TracerProvider;
        let provider = opentelemetry_sdk::trace::SdkTracerProvider::builder().build();
        let config = nddev_device_sync_telemetry::Config {
            service: "nddev-device-sync-browser-use".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            repository: "NDDev-Technocracy-OpenNetwork-NDS/nddev-device-sync-browser-use".into(),
            commit: option_env!("NDS_SOURCE_COMMIT").unwrap_or("unknown").into(),
            channel: "alpha".into(),
            standards: "unreleased".into(),
            environment: if host_mode { "host" } else { "client" }.into(),
            target_prefixes: vec![
                "nddev_device_sync_browser_use".into(),
                "nds_browser_use".into(),
            ],
            default_module: "browser-use".into(),
            debug,
        };
        let logger = nddev_device_sync_telemetry::install_with_tracer_to(
            config,
            provider.tracer("nds-telemetry"),
            nddev_device_sync_telemetry::LocalOutput::Stderr,
        )
        .ok();
        Self { logger, provider }
    }
}

#[cfg(any(unix, windows))]
impl Drop for Telemetry {
    fn drop(&mut self) {
        if let Some(logger) = self.logger.as_mut() {
            logger.shutdown();
        }
        let _ = self.provider.shutdown();
    }
}
