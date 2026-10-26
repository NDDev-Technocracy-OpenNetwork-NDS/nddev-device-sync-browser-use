//! The native host as Chrome starts it: caller identity and the lifetime of its sockets.
#![cfg(target_os = "linux")]

use std::{
    io::Read,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

const HOST: &str = env!("CARGO_BIN_EXE_nds-browser-use");
const UNPACKED: &str = "chrome-extension://lcdkocghcaakekcaeopjanfbohpfacbk/";
const FOREIGN: &str = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";

struct Fixture {
    root: tempfile::TempDir,
}

impl Fixture {
    /// Socket paths must fit `sun_path`, so the fixture lives under a short base directory.
    fn new() -> Self {
        let base = std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("/tmp"));
        Self {
            root: tempfile::Builder::new()
                .prefix("nds-bu-host-")
                .tempdir_in(base)
                .unwrap(),
        }
    }

    fn runtime(&self) -> PathBuf {
        self.root.path().join("runtime")
    }

    fn command(&self, arguments: &[&str]) -> Command {
        let mut command = Command::new(HOST);
        command
            .args(arguments)
            .env("XDG_CONFIG_HOME", self.root.path().join("config"))
            .env("NDS_BROWSER_USE_RUNTIME_DIR", self.runtime())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    /// Registers the host the way `just install` does, without a browser.
    fn install(&self) {
        let executor = self.root.path().join("executor.ts");
        std::fs::write(&executor, b"").unwrap();
        let hosts = self.root.path().join("hosts");
        let output = self
            .command(&[
                "install",
                "--bun",
                HOST,
                "--executor",
                executor.to_str().unwrap(),
                "--host-dir",
                hosts.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
    }
}

fn wait(child: &mut Child, limit: Duration) -> ExitStatus {
    let started = Instant::now();
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(started.elapsed() < limit, "the host did not exit");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn stderr(child: &mut Child) -> String {
    let mut text = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    text
}

fn appears(path: &Path) {
    let started = Instant::now();
    while !path.exists() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{path:?} did not appear"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_foreign_origin_is_refused_before_any_local_state() {
    for installed in [false, true] {
        let fixture = Fixture::new();
        if installed {
            fixture.install();
        }
        // Chrome keeps the host's stdin open; the refusal must not wait for it.
        let mut host = fixture.command(&[FOREIGN]).spawn().unwrap();
        let status = wait(&mut host, Duration::from_secs(5));
        assert_eq!(status.code(), Some(2));
        assert!(stderr(&mut host).contains(r#""error.type":"origin_rejected""#));
        assert!(
            !fixture.runtime().exists(),
            "a refused caller created the runtime directory"
        );
    }
}

#[test]
fn an_admitted_host_serves_owner_only_sockets_until_its_port_closes() {
    let fixture = Fixture::new();
    fixture.install();
    let runtime = fixture.runtime();
    // A host that died without its shutdown left a session area behind.
    let leftover = runtime.join("sessions").join("acceptance");
    std::fs::create_dir_all(&leftover).unwrap();
    std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700)).unwrap();
    std::fs::write(leftover.join("form.png"), b"earlier screenshot").unwrap();
    let mut host = fixture.command(&[UNPACKED]).spawn().unwrap();
    let control = runtime.join("control.sock");
    let cdp = runtime.join("cdp.sock");
    appears(&control);
    appears(&cdp);
    let started = Instant::now();
    while leftover.exists() {
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "a dead host's session area survived"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&runtime), 0o700);
    assert_eq!((mode(&control), mode(&cdp)), (0o600, 0o600));

    // Without the extension's hello the host answers but grants nothing.
    let status = fixture.command(&["status"]).output().unwrap();
    assert!(status.status.success());
    let body: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(body["enabled"], false);
    let opened = fixture
        .command(&["session", "new", "acceptance"])
        .output()
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&opened.stdout).unwrap();
    assert_eq!(body["error"], "extension_unavailable");

    // Chrome closing the port ends the host and its sockets.
    drop(host.stdin.take());
    let status = wait(&mut host, Duration::from_secs(5));
    assert!(status.success());
    assert!(stderr(&mut host).contains(r#""error.type":"extension_closed""#));
    assert!(!control.exists() && !cdp.exists());
}
