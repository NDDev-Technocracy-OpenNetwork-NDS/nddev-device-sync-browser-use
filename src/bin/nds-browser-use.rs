//! `nds-browser-use`: the agent CLI and, when Chrome starts it, the native host.
#![cfg_attr(not(any(unix, windows)), allow(unused))]

#[cfg(any(unix, windows))]
use nddev_device_sync_browser_use::{
    BrowserUse, BrowserUseClient, CancellationToken, Error, NativeIo, activity, artifact, device,
    host, install, mobile,
    protocol::{self, Document},
};
use std::process::ExitCode;
#[cfg(any(unix, windows))]
use std::{path::PathBuf, time::Duration};

const USAGE: &str = "usage:
  nds-browser-use skill
  nds-browser-use devices
  nds-browser-use [--device <name>] status
  nds-browser-use [--device <name>] update
  nds-browser-use [--device <name>] session new <project>
  nds-browser-use [--device <name>] session list
  nds-browser-use [--device <name>] session close <project> [--keep-tabs]
  nds-browser-use [--device <name>] -s <project> (-e <code> | -f <file> | -f -) [--timeout <ms, at most 25000>] [--expect <target>:<document>] [--json]
  nds-browser-use [--device <name>] -s <project> artifact (list | <path> [--output <file>])
  nds-browser-use [--device <name>] -s <project> recorder (start | stop | status)
  nds-browser-use [--device <name>] -s <project> recorder events [<id>...] [--recording <id>] [--type <type>] [--errors] [--exclude <regex>] [--full]
  nds-browser-use [--device <name>] -s <project> recorder frame <id> [--offset <ms>] [--recording <id>]
  nds-browser-use [--device <name>] -s <project> activity [--all] [--type <type>] [--errors] [--grep <text>] [--exec <id>] [--last <n, at most 10000>] [--full]
  nds-browser-use [--device <name>] -s <project> activity body <sha256>
  nds-browser-use install --bun <path> --executor <path> (--browser <chrome|chrome-beta|chrome-dev|chrome-canary|chrome-for-testing|chromium|edge|edge-beta|edge-dev|brave> | --host-dir <path>)
  nds-browser-use phones
  nds-browser-use phone serve <serial> [--socket <name>] [--observation <full|standard|off>]
  nds-browser-use --phone <serial> <any session command above>
NDS_BROWSER_DEVICE names the default device; NDS_BROWSER_PHONE the default phone.";
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
    let native = arguments
        .first()
        .is_some_and(|first| first.starts_with("chrome-extension://"));
    // A phone's host runs in the owner's terminal and reports like the one Chrome starts.
    let host_mode = native || arguments.get(..2) == Some(&["phone".into(), "serve".into()]);
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
    if native {
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
    // A device runs the command with its own CLI; the guide, the device list and installing stay
    // here.
    let chosen = std::env::var(DEVICE_VARIABLE)
        .ok()
        .filter(|name| !name.is_empty());
    let (device, words) = match words.as_slice() {
        ["--device", name, rest @ ..] => (Some((*name).to_owned()), rest.to_vec()),
        _ => (chosen, words),
    };
    // A phone's host and its clients use the phone's own runtime directory.
    let chosen_phone = std::env::var(PHONE_VARIABLE)
        .ok()
        .filter(|serial| !serial.is_empty());
    let (phone, words) = match words.as_slice() {
        _ if device.is_some() => (None, words),
        ["--phone", serial, rest @ ..] => (Some((*serial).to_owned()), rest.to_vec()),
        ["phone", "serve", serial, ..] => (Some((*serial).to_owned()), words),
        _ => (chosen_phone, words),
    };
    if let Some(serial) = &phone
        && nddev_device_sync_browser_use::choose_phone(serial).is_err()
    {
        return refused("invalid_request", "the phone serial is invalid");
    }
    match words.as_slice() {
        ["install", ..] if device.is_some() || phone.is_some() => usage(),
        ["phones"] if device.is_none() => phones().await,
        ["phone", "serve", serial, rest @ ..] if device.is_none() => {
            phone_serve(serial, rest).await
        }
        ["install", rest @ ..] => install_host(rest),
        ["skill"] => {
            print!("{AGENT_GUIDE}");
            ExitCode::SUCCESS
        }
        ["devices"] => devices().await,
        [] => usage(),
        _ if device.is_some() => remote(device.as_deref().unwrap_or_default(), &words).await,
        ["-s", project, "artifact", rest @ ..] => artifact_command(project, rest),
        ["-s", project, "activity", rest @ ..] => activity_command(project, rest),
        [
            "-s",
            project,
            "recorder",
            which @ ("events" | "frame"),
            rest @ ..,
        ] => recorder_command(project, *which == "frame", rest),
        _ => client(&words).await,
    }
}

#[cfg(any(unix, windows))]
const DEVICE_VARIABLE: &str = "NDS_BROWSER_DEVICE";
#[cfg(any(unix, windows))]
const PHONE_VARIABLE: &str = "NDS_BROWSER_PHONE";

/// The phones the ADB server knows and the browsers each exposes DevTools for.
#[cfg(any(unix, windows))]
async fn phones() -> ExitCode {
    match mobile::phones(&mobile::adb::Server::from_env()).await {
        Ok(phones) => {
            print(&serde_json::json!({ "phones": phones }));
            ExitCode::SUCCESS
        }
        Err(_) => refused(
            "unavailable",
            "no ADB server answers; start one with `adb start-server`",
        ),
    }
}

/// Runs the host for a phone's browser in the foreground, until the browser or the phone goes
/// away or the owner stops it.
#[cfg(any(unix, windows))]
async fn phone_serve(serial: &str, words: &[&str]) -> ExitCode {
    let mut socket = None;
    let mut observation = "full";
    let mut rest = words;
    loop {
        match rest {
            [] => break,
            ["--socket", name, tail @ ..] => {
                socket = Some((*name).to_owned());
                rest = tail;
            }
            [
                "--observation",
                profile @ ("full" | "standard" | "off"),
                tail @ ..,
            ] => {
                observation = profile;
                rest = tail;
            }
            _ => return usage(),
        }
    }
    let server = mobile::adb::Server::from_env();
    let socket = match socket {
        Some(socket) => socket,
        None => {
            let phones = mobile::phones(&server).await.unwrap_or_default();
            let browsers = phones
                .iter()
                .find(|phone| phone.serial == serial)
                .map(|phone| phone.browsers.as_slice())
                .unwrap_or_default();
            match mobile::default_socket(browsers) {
                Some(socket) => socket.to_owned(),
                None => {
                    return refused(
                        "unavailable",
                        "no browser on this phone exposes DevTools; see `nds-browser-use phones`",
                    );
                }
            }
        }
    };
    let config = match install::load() {
        Ok(config) => config,
        Err(error) => {
            tracing::error!(event.name = "browser.host.failed", outcome = "error", error.type = error.code());
            return ExitCode::from(2);
        }
    };
    tracing::info!(event.name = "browser.phone.connecting", outcome = "pending");
    // Ctrl-C ends the link, and the host then closes its sessions as when Chrome ends.
    let stop = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    match mobile::serve(config, server, serial, &socket, observation, stop).await {
        Ok(ended) => {
            let reason = match ended {
                mobile::link::Ended::Browser => "browser_closed",
                mobile::link::Ended::Host => "host_stopped",
                mobile::link::Ended::Stopped => "owner_stopped",
            };
            tracing::info!(event.name = "browser.phone.stopped", outcome = "stopped", error.type = reason);
            ExitCode::SUCCESS
        }
        Err(mobile::ServeError::Browser) => {
            tracing::error!(event.name = "browser.phone.failed", outcome = "error", error.type = "browser_unreachable");
            ExitCode::from(2)
        }
        Err(mobile::ServeError::Host(error)) => {
            tracing::error!(event.name = "browser.host.failed", outcome = "error", error.type = host_error(&error));
            ExitCode::from(2)
        }
    }
}
/// How long `devices` waits for each device's status.
#[cfg(any(unix, windows))]
const DEVICE_STATUS_TIMEOUT: Duration = Duration::from_secs(20);

// A refusal of this CLI in the protocol's form: JSON on stdout and exit code 2.
#[cfg(any(unix, windows))]
fn refused(code: &str, message: &str) -> ExitCode {
    print(&serde_json::json!({ "error": code, "message": message }));
    ExitCode::from(2)
}

#[cfg(any(unix, windows))]
fn transport(name: &str) -> Result<device::Transport, ExitCode> {
    let devices = device::Devices::load().map_err(|error| {
        refused(
            error.code(),
            "devices.json in the nds-browser-use configuration directory is not a valid private device list",
        )
    })?;
    devices
        .get(name)
        .cloned()
        .ok_or_else(|| refused("device_unknown", "no device of that name is configured"))
}

// The device's CLI with these arguments, without the default device, so it never sends the
// command on again.
#[cfg(any(unix, windows))]
fn spawn(transport: &device::Transport, args: &[&str]) -> tokio::process::Command {
    let (program, argv) = transport.invocation(args);
    let mut command = tokio::process::Command::new(program);
    command
        .args(argv)
        .env_remove(DEVICE_VARIABLE)
        .kill_on_drop(true);
    command
}

/// Runs a command with the CLI of a configured device. Code goes to it on stdin; output, errors
/// and the exit code come back as that CLI gives them. An artifact asked into a file is written
/// here.
#[cfg(any(unix, windows))]
async fn remote(name: &str, words: &[&str]) -> ExitCode {
    use std::process::Stdio;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let transport = match transport(name) {
        Ok(transport) => transport,
        Err(code) => return code,
    };
    let mut args: Vec<String> = words.iter().map(|word| (*word).to_owned()).collect();
    let mut input = None;
    let mut output = None;
    // An execution read as text refuses as one: `Error (code): message` on stderr.
    let mut text = false;
    match words {
        ["-s", project, "artifact", path, "--output", file] => {
            args = ["-s", project, "artifact", path].map(String::from).to_vec();
            output = Some(PathBuf::from(file));
        }
        ["-s", _, "artifact" | "recorder" | "activity", ..] => {}
        ["-s", project, rest @ ..] => {
            let Some(execution) = Execution::parse(rest) else {
                return usage();
            };
            args = execution.forwarded(project);
            text = !execution.json;
            input = Some(execution.code);
        }
        _ => {}
    }
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut command = spawn(&transport, &refs);
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if output.is_some() {
            Stdio::piped()
        } else {
            Stdio::inherit()
        })
        .stderr(Stdio::inherit());
    let unreachable = |message: &str| {
        if text {
            eprintln!("Error (device_unreachable): {message}");
            ExitCode::from(2)
        } else {
            refused("device_unreachable", message)
        }
    };
    let Ok(mut child) = command.spawn() else {
        return unreachable("the device's transport did not start");
    };
    // The code is written whole and stdin closed, so the device's CLI reads it to its end.
    if let (Some(code), Some(mut stdin)) = (input, child.stdin.take())
        && stdin.write_all(code.as_bytes()).await.is_err()
    {
        return unreachable("the device did not take the code");
    }
    let mut bytes = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        let limit = artifact::READ_LIMIT + 1;
        if (&mut stdout)
            .take(limit)
            .read_to_end(&mut bytes)
            .await
            .is_err()
        {
            return unreachable("the device's answer was cut off");
        }
    }
    let Ok(status) = child.wait().await else {
        return unreachable("the device's transport failed");
    };
    // ssh answers 255 for its own failures, never the CLI's.
    if transport.kind() == "ssh" && status.code() == Some(255) {
        return unreachable("ssh could not reach the device");
    }
    if let Some(file) = output {
        if !status.success() {
            std::io::Write::write_all(&mut std::io::stdout(), &bytes).ok();
        } else if bytes.len() as u64 > artifact::READ_LIMIT
            || std::fs::write(&file, &bytes).is_err()
        {
            return refused(
                "unavailable",
                "the artifact could not be written to the file",
            );
        } else {
            print(&serde_json::json!({ "written": file, "bytes": bytes.len() }));
        }
    }
    exit_code(status)
}

#[cfg(any(unix, windows))]
fn exit_code(status: std::process::ExitStatus) -> ExitCode {
    match status.code() {
        Some(code) => ExitCode::from(u8::try_from(code).unwrap_or(2)),
        None => ExitCode::from(2),
    }
}

/// Every configured device and its status, asked of all of them at once.
#[cfg(any(unix, windows))]
async fn devices() -> ExitCode {
    let devices = match device::Devices::load() {
        Ok(devices) => devices,
        Err(error) => {
            return refused(
                error.code(),
                "devices.json in the nds-browser-use configuration directory is not a valid private device list",
            );
        }
    };
    let probes = devices.iter().map(|(name, transport)| {
        let (name, transport) = (name.clone(), transport.clone());
        async move {
            let mut command = spawn(&transport, &["status"]);
            command
                .stdin(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            let answer = tokio::time::timeout(DEVICE_STATUS_TIMEOUT, command.output()).await;
            // A device that answers reports its own state, such as `unavailable` when its browser
            // has no connected extension; only a device that does not answer is unreachable.
            let reply = match answer {
                Ok(Ok(output)) => serde_json::from_slice::<serde_json::Value>(&output.stdout)
                    .ok()
                    .filter(serde_json::Value::is_object)
                    .map(|reply| (output.status.success(), reply)),
                _ => None,
            };
            let kind = transport.kind();
            match reply {
                Some((true, status)) => {
                    serde_json::json!({ "name": name, "transport": kind, "status": status })
                }
                Some((false, refusal)) if refusal["error"].is_string() => {
                    serde_json::json!({ "name": name, "transport": kind, "error": refusal["error"] })
                }
                _ => serde_json::json!({ "name": name, "transport": kind, "error": "device_unreachable" }),
            }
        }
    });
    print(&concurrently(probes.collect()).await);
    ExitCode::SUCCESS
}

// Runs the probes concurrently and keeps their order.
#[cfg(any(unix, windows))]
async fn concurrently<F: std::future::Future<Output = serde_json::Value> + Send + 'static>(
    futures: Vec<F>,
) -> Vec<serde_json::Value> {
    let handles: Vec<_> = futures.into_iter().map(tokio::spawn).collect();
    let mut answers = Vec::with_capacity(handles.len());
    for handle in handles {
        answers.push(
            handle
                .await
                .unwrap_or_else(|_| serde_json::json!({ "error": "device_unreachable" })),
        );
    }
    answers
}

/// A session's artifacts on this device: their list, or one file's bytes on stdout or into a file.
#[cfg(any(unix, windows))]
/// The project's activity journal as JSON lines (docs/observability.md), read here without the
/// host, so it also answers while no browser runs.
#[cfg(any(unix, windows))]
fn activity_command(project: &str, words: &[&str]) -> ExitCode {
    let Some(query) = activity::Query::parse(words) else {
        return usage();
    };
    if !protocol::valid_project(project) {
        return refused("invalid_request", "the project name is not valid");
    }
    let directory = match install::state_dir() {
        Ok(state) => state.join("activity").join(project),
        Err(error) => return failed(&Error::Io(error)),
    };
    match activity::read(&directory, &query) {
        Ok(lines) => {
            let mut out = std::io::stdout().lock();
            for line in lines {
                if std::io::Write::write_all(&mut out, format!("{line}\n").as_bytes()).is_err() {
                    return ExitCode::from(2);
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            refused("not_found", "the activity journal holds no such body")
        }
        Err(_) => refused("unavailable", "the activity journal could not be read"),
    }
}

/// A recording's events as JSON lines, or the path of the frame closest to one event, read from
/// the activity journal here without the host.
#[cfg(any(unix, windows))]
fn recorder_command(project: &str, frame: bool, words: &[&str]) -> ExitCode {
    let Some(query) = activity::Recorder::parse(frame, words) else {
        return usage();
    };
    if !protocol::valid_project(project) {
        return refused("invalid_request", "the project name is not valid");
    }
    let directory = match install::state_dir() {
        Ok(state) => state.join("activity").join(project),
        Err(error) => return failed(&Error::Io(error)),
    };
    let lines = if frame {
        activity::recorder_frame(&directory, &query).map(|path| vec![path.display().to_string()])
    } else {
        activity::recorder_events(&directory, &query)
    };
    match lines {
        Ok(lines) => {
            let mut out = std::io::stdout().lock();
            for line in lines {
                if std::io::Write::write_all(&mut out, format!("{line}\n").as_bytes()).is_err() {
                    return ExitCode::from(2);
                }
            }
            ExitCode::SUCCESS
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => refused(
            "not_found",
            "the activity journal holds no such recording, event or frame",
        ),
        Err(_) => refused("unavailable", "the activity journal could not be read"),
    }
}

#[cfg(any(unix, windows))]
fn artifact_command(project: &str, words: &[&str]) -> ExitCode {
    match words {
        ["list"] => match artifact::list(project) {
            Ok(entries) => {
                print(&entries);
                ExitCode::SUCCESS
            }
            Err(error) => failed(&Error::Io(error)),
        },
        [path] | [path, "--output", _] => match artifact::read(project, path) {
            Ok(bytes) => match words {
                [_, "--output", file] => match std::fs::write(file, &bytes) {
                    Ok(()) => {
                        print(&serde_json::json!({ "written": file, "bytes": bytes.len() }));
                        ExitCode::SUCCESS
                    }
                    Err(_) => refused(
                        "unavailable",
                        "the artifact could not be written to the file",
                    ),
                },
                _ => match std::io::Write::write_all(&mut std::io::stdout(), &bytes) {
                    Ok(()) => ExitCode::SUCCESS,
                    Err(_) => ExitCode::from(2),
                },
            },
            Err(error) => failed(&Error::Io(error)),
        },
        _ => usage(),
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
            // The recorder commands are its helper's calls, run as the session's code.
            let execution = match rest {
                ["recorder", action @ ("start" | "stop" | "status")] => Some(Execution {
                    code: format!("return await recorder.{action}()"),
                    timeout: Duration::from_secs(20),
                    expect: None,
                    json: false,
                }),
                ["recorder", ..] => None,
                _ => Execution::parse(rest),
            };
            let Some(execution) = execution else {
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
                "-f" if value == "-" => code = Some(read_stdin()?),
                "-f" => code = Some(read_code(value)?),
                // The host refuses a deadline outside its bound; the usage names it here.
                "--timeout" => {
                    let ms = value
                        .parse()
                        .ok()
                        .filter(|ms| protocol::valid_execution(*ms))?;
                    timeout = Duration::from_millis(ms);
                }
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
impl Execution {
    /// The arguments that run this execution on a device, its code coming on stdin.
    fn forwarded(&self, project: &str) -> Vec<String> {
        let mut args: Vec<String> = ["-s", project, "-f", "-"].map(String::from).to_vec();
        args.extend(["--timeout".into(), self.timeout.as_millis().to_string()]);
        if let Some(expect) = &self.expect {
            args.extend([
                "--expect".into(),
                format!("{}:{}", expect.target, expect.document),
            ]);
        }
        if self.json {
            args.push("--json".into());
        }
        args
    }
}

// Code given on stdin, as a device's CLI receives it.
#[cfg(any(unix, windows))]
fn read_stdin() -> Option<String> {
    use std::io::Read;
    let mut code = String::new();
    std::io::stdin()
        .take(CODE_LIMIT as u64 + 1)
        .read_to_string(&mut code)
        .ok()?;
    (code.len() <= CODE_LIMIT).then_some(code)
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
