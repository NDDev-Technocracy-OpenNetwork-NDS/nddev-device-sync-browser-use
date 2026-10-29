//! One session's journal file (docs/observability.md). The executor's raw records become records
//! with secrets removed and noise left out; consecutive identical requests and console messages
//! fold into one record with a count, and each body is stored once by its hash.

use super::clean;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

const RECORD_BYTES: usize = 64 * 1024;
const FILE_BYTES: u64 = 64 * 1024 * 1024;
const BODY_BYTES: usize = 256 * 1024;
const POST_BYTES: usize = 16 * 1024;
const TEXT_CHARS: usize = 2000;
const CODE_CHARS: usize = 20_000;
/// How long a record waits for identical ones to fold into it.
pub const FOLD: Duration = Duration::from_secs(1);
/// Successful requests of these kinds are noise.
const STATIC: &[&str] = &[
    "image",
    "font",
    "stylesheet",
    "script",
    "media",
    "manifest",
    "texttrack",
];

pub struct Writer {
    file: PathBuf,
    bodies: PathBuf,
    output: Option<File>,
    written: u64,
    sequence: u64,
    full: bool,
    held: Option<Held>,
    /// Values typed into fields that are no secret: aria snapshots may show them.
    typed: std::collections::HashSet<String>,
    /// The owner's private sites (hosts, with their subdomains): of them the journal keeps that
    /// something happened, never what.
    private: Vec<String>,
    /// The host each page of the session shows now, checked against the private sites when a
    /// record comes, so a site made private later counts at once.
    page_hosts: std::collections::HashMap<u64, String>,
}

/// Pages whose site the journal remembers at once.
const PAGES_LIMIT: usize = 1024;

/// How many typed values a journal remembers for its snapshots.
const TYPED_LIMIT: usize = 256;

struct Held {
    key: String,
    record: Map<String, Value>,
    since: Instant,
}

/// A stable class: letters, digits and `._-`, as telemetry keeps them.
fn class(value: &Value, limit: usize) -> Option<Value> {
    value
        .as_str()
        .filter(|text| {
            !text.is_empty()
                && text.len() <= limit
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        })
        .map(Value::from)
}

fn text(value: &Value, limit: usize) -> Option<Value> {
    value.as_str().map(|text| clean::text(text, limit).into())
}

/// File names only, never the paths they came from.
fn names(value: &Value) -> Option<Value> {
    value.as_array().map(|files| {
        files
            .iter()
            .filter_map(Value::as_str)
            .take(32)
            .map(|path| clean::bounded(path.rsplit(['/', '\\']).next().unwrap_or_default(), 256))
            .collect()
    })
}

fn url(value: &Value) -> Option<Value> {
    value.as_str().map(|url| clean::url(url).into())
}

/// What the journal keeps of a private site's record: that it happened, when, in which execution,
/// page and tab, and its outcome; never a URL, text, value, locator, code, output or body. Console
/// messages, toasts, dialogs and page errors of such a site are not kept at all.
fn bare(raw: &Value) -> Option<Map<String, Value>> {
    let kind = raw["type"].as_str()?;
    if matches!(
        kind,
        "console" | "toast" | "dialog" | "page-error" | "person-signal"
    ) {
        return None;
    }
    let mut record = Map::new();
    record.insert("type".into(), kind.into());
    if let Some(at) = raw["at"]
        .as_str()
        .filter(|at| at.len() <= 32 && at.bytes().all(|byte| b"0123456789TZ:.-".contains(&byte)))
    {
        record.insert("at".into(), at.into());
    }
    for field in ["exec", "page", "tab", "id", "ms", "status"] {
        if let Some(number) = raw[field].as_u64() {
            record.insert(field.into(), number.into());
        }
    }
    if let Some(ok) = raw["ok"].as_bool() {
        record.insert("ok".into(), ok.into());
    }
    for field in ["api", "method", "resource", "event", "action", "recording"] {
        if let Some(value) = class(&raw[field], 64) {
            record.insert(field.into(), value);
        }
    }
    record.insert("private".into(), true.into());
    Some(record)
}

impl Writer {
    pub fn new(directory: &Path, name: &str) -> Self {
        Self {
            file: directory.join(name),
            bodies: directory.join("bodies"),
            output: None,
            written: 0,
            sequence: 0,
            full: false,
            held: None,
            typed: std::collections::HashSet::new(),
            private: Vec::new(),
            page_hosts: std::collections::HashMap::new(),
        }
    }

    /// The owner's private sites, as the extension's popup keeps them.
    pub fn set_private(&mut self, sites: &[String]) {
        if self.private != sites {
            self.private = sites.to_vec();
        }
    }

    fn private_url(&self, url: &str) -> bool {
        self.private_host(&clean::host(url).to_ascii_lowercase())
    }

    fn private_host(&self, host: &str) -> bool {
        !host.is_empty()
            && self.private.iter().any(|site| {
                host == *site
                    || host
                        .strip_suffix(site.as_str())
                        .is_some_and(|rest| rest.ends_with('.'))
            })
    }

    /// Follows which page shows which site, and tells whether a record is of a private one. An
    /// execution, and a record that names no page, count as private while any page shows a
    /// private site, since they may carry that page's content.
    fn private(&mut self, raw: &Value) -> bool {
        let kind = raw["type"].as_str().unwrap_or_default();
        let page = raw["page"].as_u64();
        if let (Some(page), "page" | "navigation") = (page, kind) {
            if raw["event"].as_str() == Some("closed") {
                self.page_hosts.remove(&page);
            } else if let Some(url) = raw["url"].as_str()
                && (self.page_hosts.len() < PAGES_LIMIT || self.page_hosts.contains_key(&page))
            {
                self.page_hosts
                    .insert(page, clean::host(url).to_ascii_lowercase());
            }
        }
        if self.private.is_empty() {
            return false;
        }
        let any_private = || self.page_hosts.values().any(|host| self.private_host(host));
        if raw["url"].as_str().is_some_and(|url| self.private_url(url)) {
            return true;
        }
        match (kind, page) {
            ("execution", _) | (_, None) => any_private(),
            (_, Some(page)) => self
                .page_hosts
                .get(&page)
                .is_some_and(|host| self.private_host(host)),
        }
    }

    /// Remembers a value typed into a field that is no secret, so snapshots may show it.
    fn typed(&mut self, value: &str) {
        if self.typed.len() < TYPED_LIMIT && !value.is_empty() && value.len() <= 500 {
            self.typed.insert(value.to_owned());
        }
    }

    /// Writes one raw record of the executor or the host, if the journal keeps it.
    pub fn ingest(&mut self, raw: &Value, now: Instant) {
        if self.private(raw) {
            if let Some(mut record) = bare(raw) {
                self.flush();
                self.sequence += 1;
                record.insert("seq".into(), self.sequence.into());
                self.append(record);
            }
            return;
        }
        let Some((mut record, fold)) = self.project(raw) else {
            return;
        };
        if let (Some(key), Some(held)) = (&fold, self.held.as_mut())
            && held.key == *key
        {
            // Playwright's recorder reports a fill again with each keystroke: the newest wins.
            if raw["update"].as_bool() == Some(true) {
                for (name, value) in record {
                    if name != "at" {
                        held.record.insert(name, value);
                    }
                }
                return;
            }
            let repeat = held
                .record
                .get("repeat")
                .and_then(Value::as_u64)
                .unwrap_or(1);
            held.record.insert("repeat".into(), (repeat + 1).into());
            if let Some(at) = record.remove("at") {
                held.record.insert("last".into(), at);
            }
            return;
        }
        self.flush();
        self.sequence += 1;
        record.insert("seq".into(), self.sequence.into());
        match fold {
            Some(key) => {
                self.held = Some(Held {
                    key,
                    record,
                    since: now,
                })
            }
            None => self.append(record),
        }
    }

    /// Writes a held record once nothing identical followed it in time.
    pub fn tick(&mut self, now: Instant) {
        if self
            .held
            .as_ref()
            .is_some_and(|held| now.duration_since(held.since) >= FOLD)
        {
            self.flush();
        }
    }

    pub fn flush(&mut self) {
        if let Some(held) = self.held.take() {
            self.append(held.record);
        }
    }

    /// Drops the record not yet written, as the off profile asks.
    pub fn discard(&mut self) {
        self.held = None;
    }

    /// The record the journal keeps of a raw one, and its folding key, or none for noise.
    fn project(&mut self, raw: &Value) -> Option<(Map<String, Value>, Option<String>)> {
        let kind = raw["type"].as_str()?;
        let mut record = Map::new();
        record.insert("type".into(), kind.into());
        if let Some(at) = raw["at"].as_str().filter(|at| {
            at.len() <= 32 && at.bytes().all(|byte| b"0123456789TZ:.-".contains(&byte))
        }) {
            record.insert("at".into(), at.into());
        }
        for field in ["exec", "page", "tab"] {
            if let Some(number) = raw[field].as_u64() {
                record.insert(field.into(), number.into());
            }
        }
        let mut put = |name: &str, value: Option<Value>| {
            if let Some(value) = value {
                record.insert(name.into(), value);
            }
        };
        let fold = match kind {
            "execution" => {
                put("id", raw["id"].as_u64().map(Value::from));
                put("ok", raw["ok"].as_bool().map(Value::from));
                put("error", class(&raw["error"], 64));
                put("ms", raw["ms"].as_u64().map(Value::from));
                put(
                    "code",
                    raw["code"]
                        .as_str()
                        .map(|code| clean::code(code, CODE_CHARS).into()),
                );
                put(
                    "output",
                    raw["output"]
                        .as_str()
                        .map(|output| clean::aria(output, &self.typed, TEXT_CHARS).into()),
                );
                None
            }
            "action" => {
                let locator = raw["locator"].as_str();
                put("api", class(&raw["api"], 64));
                put(
                    "locator",
                    locator.map(|locator| clean::text(locator, 500).into()),
                );
                put("url", url(&raw["url"]));
                put("key", text(&raw["key"], 32));
                let secret_action = raw["secret"].as_bool() == Some(true)
                    || locator.is_some_and(clean::secret_field);
                if let (false, Some(value)) = (secret_action, raw["value"].as_str()) {
                    self.typed(value);
                }
                put(
                    "value",
                    raw["value"].as_str().map(|value| {
                        if secret_action {
                            clean::REDACTED.into()
                        } else {
                            clean::text(value, 500).into()
                        }
                    }),
                );
                put(
                    "files",
                    raw["files"].as_array().map(|files| {
                        files
                            .iter()
                            .filter_map(Value::as_str)
                            .take(32)
                            .map(|path| {
                                clean::bounded(
                                    path.rsplit(['/', '\\']).next().unwrap_or_default(),
                                    256,
                                )
                            })
                            .collect()
                    }),
                );
                put("ms", raw["ms"].as_u64().map(Value::from));
                put(
                    "error",
                    raw["error"].as_str().map(|error| {
                        clean::text(error.lines().next().unwrap_or_default(), 500).into()
                    }),
                );
                None
            }
            "navigation" => {
                put("url", url(&raw["url"]));
                None
            }
            "page" => {
                put(
                    "event",
                    raw["event"]
                        .as_str()
                        .filter(|event| matches!(*event, "opened" | "closed"))
                        .map(Value::from),
                );
                put("url", url(&raw["url"]));
                None
            }
            "download" => {
                put("url", url(&raw["url"]));
                put("name", text(&raw["name"], 256));
                None
            }
            "dialog" => {
                put("kind", class(&raw["kind"], 32));
                put("text", text(&raw["text"], TEXT_CHARS));
                None
            }
            "console" => {
                let level = raw["level"]
                    .as_str()
                    .filter(|level| matches!(*level, "error" | "warning" | "assert"))?;
                let message = clean::text(raw["text"].as_str().unwrap_or_default(), TEXT_CHARS);
                put("level", Some(level.into()));
                put("text", Some(message.clone().into()));
                Some(format!("console {level} {message}"))
            }
            "toast" => {
                let message = clean::text(raw["text"].as_str().unwrap_or_default(), TEXT_CHARS);
                put("text", Some(message.clone().into()));
                Some(format!("toast {message}"))
            }
            "page-error" => {
                let message = clean::text(raw["message"].as_str().unwrap_or_default(), TEXT_CHARS);
                put("message", Some(message.clone().into()));
                Some(format!("error {message}"))
            }
            "recording" => {
                put(
                    "event",
                    raw["event"]
                        .as_str()
                        .filter(|event| matches!(*event, "started" | "stopped"))
                        .map(Value::from),
                );
                put("recording", class(&raw["recording"], 64));
                put(
                    "dir",
                    raw["dir"]
                        .as_str()
                        .map(|dir| clean::bounded(dir, 1024).into()),
                );
                put("reason", class(&raw["reason"], 32));
                None
            }
            "person-action" => {
                let locator = raw["locator"].as_str();
                let recording = class(&raw["recording"], 64);
                let action = class(&raw["action"], 32);
                let secret = raw["secret"].as_bool() == Some(true)
                    || locator.is_some_and(clean::secret_field);
                let key = format!(
                    "person {} {} {} {}",
                    recording
                        .as_ref()
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                    raw["page"].as_u64().unwrap_or_default(),
                    action.as_ref().and_then(Value::as_str).unwrap_or_default(),
                    locator.unwrap_or_default(),
                );
                put("recording", recording);
                put("action", action);
                put(
                    "locator",
                    locator.map(|locator| clean::text(locator, 500).into()),
                );
                put(
                    "value",
                    raw["value"].as_str().map(|value| {
                        if secret {
                            clean::REDACTED.into()
                        } else {
                            clean::text(value, 500).into()
                        }
                    }),
                );
                put("key", text(&raw["key"], 32));
                put(
                    "options",
                    raw["options"].as_array().map(|options| {
                        options
                            .iter()
                            .filter_map(Value::as_str)
                            .take(32)
                            .map(|option| clean::text(option, 200))
                            .collect()
                    }),
                );
                put("files", names(&raw["files"]));
                if let (false, Some(value)) = (secret, raw["value"].as_str()) {
                    self.typed(value);
                }
                put(
                    "aria",
                    raw["aria"]
                        .as_str()
                        .filter(|_| !secret)
                        .map(|aria| clean::aria(aria, &self.typed, 8000).into()),
                );
                put("clickCount", raw["clickCount"].as_u64().map(Value::from));
                put("button", class(&raw["button"], 16));
                put("url", url(&raw["url"]));
                put(
                    "code",
                    raw["code"].as_str().map(|code| {
                        let kept = clean::code(code, 2000);
                        if secret {
                            clean::typed_all(&kept)
                        } else {
                            kept
                        }
                        .into()
                    }),
                );
                Some(key)
            }
            "person-signal" => {
                put("recording", class(&raw["recording"], 64));
                put("signal", class(&raw["signal"], 32));
                put("url", url(&raw["url"]));
                None
            }
            "network" => return self.network(raw, record),
            _ => return None,
        };
        Some((record, fold))
    }

    fn network(
        &mut self,
        raw: &Value,
        mut record: Map<String, Value>,
    ) -> Option<(Map<String, Value>, Option<String>)> {
        let target = raw["url"].as_str()?;
        if ["data:", "blob:", "chrome-extension:", "about:"]
            .iter()
            .any(|scheme| target.starts_with(scheme))
            || clean::telemetry(target)
        {
            return None;
        }
        let status = raw["status"].as_u64().unwrap_or(0);
        let failure = raw["failure"]
            .as_str()
            .map(|failure| clean::text(failure, 200));
        let failed = failure.is_some() || status >= 400;
        let resource = raw["resource"].as_str().unwrap_or("other");
        let method = raw["method"].as_str().unwrap_or("GET");
        if !failed && STATIC.contains(&resource) {
            return None;
        }
        let page = raw["pageUrl"].as_str().unwrap_or_default();
        if !failed
            && method == "GET"
            && resource != "document"
            && clean::host(target) != clean::host(page)
        {
            return None;
        }
        let address = clean::url(target);
        record.insert("method".into(), clean::bounded(method, 16).into());
        record.insert("url".into(), address.clone().into());
        record.insert("resource".into(), clean::bounded(resource, 32).into());
        record.insert("status".into(), status.into());
        if let Some(failure) = &failure {
            record.insert("failure".into(), failure.clone().into());
        }
        let content_type = raw["contentType"].as_str().unwrap_or_default();
        if !content_type.is_empty() {
            record.insert(
                "contentType".into(),
                clean::bounded(content_type, 200).into(),
            );
        }
        record.insert("headers".into(), clean::headers(&raw["headers"]));
        if let Some(post) = raw["postData"].as_str() {
            let kept = clean::body(post, raw["requestType"].as_str().unwrap_or_default());
            record.insert("postData".into(), clean::bounded(&kept, POST_BYTES).into());
        }
        match raw["body"].as_str() {
            Some(body) if body.len() <= BODY_BYTES && clean::textual(content_type) => {
                record.insert("body".into(), self.store(&clean::body(body, content_type)));
            }
            Some(_) => {
                record.insert("bodyOmitted".into(), "too-large".into());
            }
            None => {
                if let Some(reason) = class(&raw["bodyOmitted"], 32) {
                    record.insert("bodyOmitted".into(), reason);
                }
            }
        }
        let key = format!(
            "network {method} {address} {status} {}",
            failure.unwrap_or_default()
        );
        Some((record, Some(key)))
    }

    /// Stores a body once by its hash; one seen again stays as long as its newest use.
    fn store(&self, body: &str) -> Value {
        let hash: String = Sha256::digest(body.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let path = self.bodies.join(&hash);
        let kept = match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => File::options()
                .append(true)
                .open(&path)
                .and_then(|file| file.set_modified(SystemTime::now()))
                .is_ok(),
            Ok(_) => false,
            Err(_) => {
                private_directory(&self.bodies).is_ok() && write_new(&path, body.as_bytes()).is_ok()
            }
        };
        if kept {
            json!({ "hash": hash, "size": body.len() })
        } else {
            json!({ "omitted": "unavailable" })
        }
    }

    fn append(&mut self, mut record: Map<String, Value>) {
        if self.full {
            return;
        }
        let mut line = Value::Object(record.clone()).to_string();
        if line.len() > RECORD_BYTES {
            for value in record.values_mut() {
                if let Value::String(text) = value {
                    *text = clean::bounded(text, TEXT_CHARS);
                }
            }
            record.insert("truncated".into(), true.into());
            line = Value::Object(record).to_string();
        }
        if self.written + line.len() as u64 + 1 > FILE_BYTES {
            self.full = true;
            line = json!({ "type": "journal", "reason": "max-size" }).to_string();
        }
        if self.output.is_none() {
            self.output = open_append(&self.file).ok();
        }
        if let Some(output) = self.output.as_mut()
            && output.write_all(format!("{line}\n").as_bytes()).is_ok()
        {
            self.written += line.len() as u64 + 1;
        }
    }
}

fn private_directory(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

fn private_options() -> std::fs::OpenOptions {
    #[cfg_attr(not(unix), expect(unused_mut, reason = "only Unix sets a file mode"))]
    let mut options = File::options();
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options
}

fn open_append(path: &Path) -> std::io::Result<File> {
    if let Some(parent) = path.parent() {
        private_directory(parent)?;
    }
    private_options().create(true).append(true).open(path)
}

fn write_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    private_options()
        .write(true)
        .create_new(true)
        .open(path)?
        .write_all(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(directory: &Path) -> Vec<Value> {
        std::fs::read_to_string(directory.join("j.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn a_private_site_keeps_only_that_something_happened() {
        let directory = tempfile::tempdir().unwrap();
        let mut writer = Writer::new(directory.path(), "j.jsonl");
        let now = Instant::now();
        // The pages open before the owner makes the site private.
        writer.ingest(&json!({ "type": "page", "page": 1, "event": "opened", "url": "https://mail.example.com/inbox" }), now);
        writer.ingest(
            &json!({ "type": "page", "page": 2, "event": "opened", "url": "https://shop.test/" }),
            now,
        );
        writer.set_private(&["example.com".to_owned()]);
        let records = [
            // An action Playwright reports without its page.
            json!({ "type": "action", "exec": 1, "api": "fill", "locator": "#reply", "value": "a private letter", "ms": 3 }),
            json!({ "type": "network", "exec": 1, "method": "GET", "status": 200, "resource": "fetch", "url": "https://api.example.com/messages?id=7" }),
            json!({ "type": "console", "page": 1, "level": "error", "text": "private error" }),
            json!({ "type": "execution", "exec": 1, "id": 1, "ok": true, "code": "return letter", "output": "a private letter" }),
            json!({ "type": "action", "exec": 2, "page": 2, "api": "fill", "locator": "#q", "value": "shoes" }),
            json!({ "type": "page", "page": 1, "event": "closed" }),
            json!({ "type": "execution", "exec": 3, "id": 3, "ok": true, "code": "return 1", "output": "1" }),
        ];
        for record in &records {
            writer.ingest(record, now);
        }
        writer.flush();
        let kept = lines(directory.path());
        let text = std::fs::read_to_string(directory.path().join("j.jsonl")).unwrap();
        assert!(!text.contains("private letter"));
        assert!(!text.contains("api.example.com") && !text.contains("private error"));
        // The page record written before the site became private keeps its URL; nothing after.
        assert_eq!(kept[1]["url"], "https://shop.test/");
        assert_eq!(
            kept[2],
            json!({ "type": "action", "exec": 1, "api": "fill", "ms": 3, "private": true, "seq": 3 })
        );
        assert_eq!(
            (kept[3]["private"].clone(), kept[3]["status"].clone()),
            (json!(true), json!(200))
        );
        // The execution while a private page was open keeps no code or output; the later one does.
        assert_eq!(kept[4]["type"], "execution");
        assert!(kept[4].get("output").is_none() && kept[4].get("code").is_none());
        assert_eq!(kept[5]["value"], "shoes");
        assert_eq!(kept[7]["output"], "1");
    }

    #[test]
    fn records_lose_their_secrets_and_identical_ones_fold() {
        let directory = tempfile::tempdir().unwrap();
        let mut writer = Writer::new(directory.path(), "j.jsonl");
        let now = Instant::now();
        writer.ingest(
            &json!({ "type": "execution", "exec": 1, "id": 1, "ok": true, "ms": 5,
                "code": "await page.fill('#pw', 'hunter2')", "output": "done" }),
            now,
        );
        writer.ingest(&json!({ "type": "action", "exec": 1, "api": "fill", "locator": "#password", "value": "hunter2" }), now);
        writer.ingest(&json!({ "type": "action", "exec": 1, "api": "fill", "locator": "#email", "value": "ann@test" }), now);
        for _ in 0..3 {
            writer.ingest(
                &json!({ "type": "console", "page": 1, "level": "error", "text": "boom" }),
                now,
            );
        }
        writer.ingest(
            &json!({ "type": "console", "page": 1, "level": "log", "text": "noise" }),
            now,
        );
        writer.ingest(&json!({ "type": "unknown" }), now);
        writer.tick(now + FOLD);
        let records = lines(directory.path());
        assert_eq!(records.len(), 4);
        assert_eq!(records[0]["code"], "await page.fill('#pw', \"[redacted]\")");
        assert_eq!(records[1]["value"], "[redacted]");
        assert_eq!(records[2]["value"], "ann@test");
        assert_eq!(records[3]["repeat"], 3);
        assert!(
            !std::fs::read_to_string(directory.path().join("j.jsonl"))
                .unwrap()
                .contains("hunter2")
        );
    }

    #[test]
    fn requests_keep_value_once_and_leave_noise_out() {
        let directory = tempfile::tempdir().unwrap();
        let mut writer = Writer::new(directory.path(), "j.jsonl");
        let now = Instant::now();
        let api = json!({ "type": "network", "page": 1, "method": "POST", "url": "https://shop.test/api/cart?token=abc",
            "pageUrl": "https://shop.test/", "resource": "fetch", "status": 200, "contentType": "application/json",
            "headers": { "authorization": "Bearer abc", "accept": "*/*" },
            "postData": "{\"password\":\"x\",\"item\":7}", "requestType": "application/json",
            "body": "{\"cart\":[7],\"token\":\"t\"}" });
        writer.ingest(&api, now);
        writer.ingest(&api, now);
        for noise in [
            json!({ "type": "network", "url": "https://shop.test/logo.png", "pageUrl": "https://shop.test/", "resource": "image", "status": 200 }),
            json!({ "type": "network", "url": "https://cdn.other.test/lib.json", "pageUrl": "https://shop.test/", "resource": "fetch", "method": "GET", "status": 200 }),
            json!({ "type": "network", "url": "https://www.google-analytics.com/g/collect", "pageUrl": "https://shop.test/", "resource": "ping", "status": 204 }),
            json!({ "type": "network", "url": "data:text/plain,x", "resource": "fetch", "status": 200 }),
        ] {
            writer.ingest(&noise, now);
        }
        writer.ingest(&json!({ "type": "network", "url": "https://cdn.other.test/missing.png", "pageUrl": "https://shop.test/", "resource": "image", "method": "GET", "status": 404 }), now);
        writer.flush();
        let records = lines(directory.path());
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["repeat"], 2);
        assert_eq!(
            records[0]["url"],
            "https://shop.test/api/cart?token=[redacted]"
        );
        assert_eq!(records[0]["headers"], json!({ "accept": "*/*" }));
        assert_eq!(
            records[0]["postData"],
            "{\"item\":7,\"password\":\"[redacted]\"}"
        );
        let hash = records[0]["body"]["hash"].as_str().unwrap();
        let body = std::fs::read_to_string(directory.path().join("bodies").join(hash)).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&body).unwrap(),
            json!({ "cart": [7], "token": "[redacted]" })
        );
        assert_eq!(records[1]["status"], 404);
    }

    #[test]
    fn a_persons_fill_keeps_its_newest_value_and_a_secret_field_none() {
        let directory = tempfile::tempdir().unwrap();
        let mut writer = Writer::new(directory.path(), "j.jsonl");
        let now = Instant::now();
        let fill = |value: &str, update: bool| {
            json!({ "type": "person-action", "recording": "r1", "page": 1, "action": "fill",
                "locator": "internal:role=textbox[name=\"Name\"i]", "value": value, "update": update,
                "code": format!("await page.getByRole('textbox', {{ name: 'Name' }}).fill('{value}');") })
        };
        writer.ingest(&fill("A", false), now);
        writer.ingest(&fill("Ad", true), now);
        writer.ingest(&fill("Ada", true), now);
        writer.ingest(
            &json!({ "type": "person-action", "recording": "r1", "page": 1, "action": "fill", "locator": "#code",
                "secret": true, "value": "481516", "code": "await page.locator('#code').fill('481516');" }),
            now,
        );
        writer.flush();
        let records = lines(directory.path());
        assert_eq!(records.len(), 2);
        assert_eq!(records[0]["value"], "Ada");
        assert_eq!(records[0].get("repeat"), None);
        assert_eq!(records[1]["value"], "[redacted]");
        assert_eq!(
            records[1]["code"],
            "await page.locator(\"[redacted]\").fill(\"[redacted]\");"
        );
        assert!(
            !std::fs::read_to_string(directory.path().join("j.jsonl"))
                .unwrap()
                .contains("481516")
        );
    }

    #[test]
    fn a_discarded_record_is_never_written() {
        let directory = tempfile::tempdir().unwrap();
        let mut writer = Writer::new(directory.path(), "j.jsonl");
        writer.ingest(
            &json!({ "type": "page-error", "message": "boom" }),
            Instant::now(),
        );
        writer.discard();
        writer.flush();
        assert!(lines(directory.path()).is_empty());
    }
}
