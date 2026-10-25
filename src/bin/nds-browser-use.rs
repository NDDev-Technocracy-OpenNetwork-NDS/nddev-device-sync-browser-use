//! `nds-browser-use`: the agent CLI and, when Chrome starts it, the native host.
#![cfg_attr(not(target_os = "linux"), allow(unused))]

#[cfg(target_os = "linux")]
use nddev_device_sync_browser_use::{
    BrowserUse, BrowserUseClient, CancellationToken, Error, NativeIo, host, install,
    protocol::Document,
};
use std::process::ExitCode;
#[cfg(target_os = "linux")]
use std::{path::PathBuf, time::Duration};

const USAGE: &str = "usage:
  nds-browser-use status
  nds-browser-use session new <project>
  nds-browser-use session list
  nds-browser-use session close <project> [--close-tabs]
  nds-browser-use -s <project> (-e <code> | -f <file>) [--timeout <ms>] [--expect <target>:<document>]
  nds-browser-use install --bun <path> --executor <path> (--browser <chrome|chrome-beta|chrome-for-testing|chromium> | --host-dir <path>) [--extension-id <web-store-id>]...";
const ARGUMENT_LIMIT: usize = 16;
const CODE_LIMIT: usize = 60_000;

#[cfg(not(target_os = "linux"))]
fn main() -> ExitCode {
    eprintln!("nds-browser-use is not supported on this platform");
    ExitCode::from(2)
}

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    if arguments.len() > ARGUMENT_LIMIT {
        return usage();
    }
    let host_mode = arguments
        .first()
        .is_some_and(|first| first.starts_with("chrome-extension://"));
    // stdout carries native messaging in host mode; local telemetry uses stderr.
    let _telemetry = Telemetry::install(host_mode);
    if host_mode {
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
        [] => usage(),
        _ => client(&words).await,
    }
}

#[cfg(target_os = "linux")]
fn host_error(error: &host::HostError) -> &'static str {
    match error {
        host::HostError::Origin => "origin_rejected",
        host::HostError::Busy => "busy",
        host::HostError::Io(error) => error.code(),
    }
}

#[cfg(target_os = "linux")]
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
        ["session", "new", project] => client
            .open(project, cancellation)
            .await
            .map(|session| print(&session)),
        ["session", "list"] => client
            .sessions(cancellation)
            .await
            .map(|sessions| print(&sessions)),
        ["session", "close", project] => client
            .close(project, false, cancellation)
            .await
            .map(|()| print(&serde_json::json!({ "closed": project }))),
        ["session", "close", project, "--close-tabs"] => client
            .close(project, true, cancellation)
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
                Ok(outcome) => {
                    print(&outcome);
                    if outcome.failure.is_none() {
                        ExitCode::SUCCESS
                    } else {
                        ExitCode::from(1)
                    }
                }
                Err(error) => failed(&error),
            };
        }
        _ => return usage(),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => failed(&error),
    }
}

#[cfg(target_os = "linux")]
struct Execution {
    code: String,
    timeout: Duration,
    expect: Option<Document>,
}

#[cfg(target_os = "linux")]
impl Execution {
    fn parse(mut words: &[&str]) -> Option<Self> {
        let (mut code, mut timeout, mut expect) = (None, Duration::from_secs(10), None);
        while let [flag, value, rest @ ..] = words {
            match *flag {
                "-e" => code = Some((*value).to_owned()),
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
        let code = code.filter(|code| words.is_empty() && code.len() <= CODE_LIMIT)?;
        Some(Self {
            code,
            timeout,
            expect,
        })
    }
}

#[cfg(target_os = "linux")]
fn read_code(path: &str) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    (metadata.len() <= CODE_LIMIT as u64)
        .then(|| std::fs::read_to_string(path).ok())
        .flatten()
}

#[cfg(target_os = "linux")]
fn install_host(words: &[&str]) -> ExitCode {
    let (mut bun, mut executor, mut directory, mut extensions) = (None, None, None, Vec::new());
    let mut rest = words;
    while let [flag, value, tail @ ..] = rest {
        match *flag {
            "--bun" => bun = Some(PathBuf::from(value)),
            "--executor" => executor = Some(PathBuf::from(value)),
            "--host-dir" => directory = Some(Ok(PathBuf::from(value))),
            "--extension-id" => extensions.push((*value).to_owned()),
            "--browser" => match install::Browser::parse(value) {
                Some(browser) => directory = Some(install::host_directory(browser)),
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
        install::install(&host, &directory, &bun, &executor, &extensions)
    });
    match installed {
        Ok(installation) => {
            print(&serde_json::json!({
                "manifest": installation.manifest,
                "config": installation.config,
                "extension_id": nddev_device_sync_browser_use::EXTENSION_ID,
            }));
            ExitCode::SUCCESS
        }
        Err(error) => failed(&Error::Io(error)),
    }
}

#[cfg(target_os = "linux")]
fn print<T: serde::Serialize>(value: &T) {
    if let Ok(text) = serde_json::to_string(value) {
        println!("{text}");
    }
}

#[cfg(target_os = "linux")]
fn failed(error: &Error) -> ExitCode {
    let code = match error {
        Error::Io(error) => error.code(),
        Error::Refused(refusal) => refusal.code(),
        Error::InvalidResponse => "invalid_response",
        Error::UnsupportedPlatform => "unsupported_platform",
    };
    print(&serde_json::json!({ "error": code, "message": error.to_string() }));
    ExitCode::from(2)
}

fn usage() -> ExitCode {
    eprintln!("{USAGE}");
    ExitCode::from(2)
}

/// Schema-validated local events. Export follows agent composition (ADR 0015).
#[cfg(target_os = "linux")]
struct Telemetry {
    logger: Option<nddev_device_sync_telemetry::Logger>,
    provider: opentelemetry_sdk::trace::SdkTracerProvider,
}

#[cfg(target_os = "linux")]
impl Telemetry {
    fn install(host_mode: bool) -> Self {
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
            debug: None,
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

#[cfg(target_os = "linux")]
impl Drop for Telemetry {
    fn drop(&mut self) {
        if let Some(logger) = self.logger.as_mut() {
            logger.shutdown();
        }
        let _ = self.provider.shutdown();
    }
}
