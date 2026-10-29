//! The activity journal on disk (docs/observability.md): what agents read with
//! `nds-browser-use -s <project> activity`, and its one-week, size-bounded retention.
//!
//! Each executor of a project appends JSON lines to its own file in the project's journal
//! directory; bodies are stored once by hash under `bodies/`. Reading never follows a link and
//! never leaves the project's directory.

use std::{
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde_json::Value;

pub mod clean;
mod writer;
pub use writer::{FOLD, Writer};

/// How long journal files and bodies are kept, and the most all journals may take together.
pub const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
pub const TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
const DEFAULT_LAST: usize = 200;
const LAST_LIMIT: usize = 10_000;
const THIN_CHARS: usize = 300;

/// What one `activity` call asks for.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Query {
    /// Every journal file of the project, not only the newest one.
    pub all: bool,
    pub kind: Option<String>,
    pub errors: bool,
    pub grep: Option<String>,
    pub exec: Option<u64>,
    pub last: usize,
    pub full: bool,
    /// Print this stored body instead of records.
    pub body: Option<String>,
}

impl Query {
    pub fn parse(words: &[&str]) -> Option<Self> {
        let mut query = Self {
            last: DEFAULT_LAST,
            ..Self::default()
        };
        let mut words = words.iter();
        while let Some(word) = words.next() {
            match *word {
                "--all" => query.all = true,
                "--errors" => query.errors = true,
                "--full" => query.full = true,
                "--type" => query.kind = Some((*words.next()?).to_owned()),
                "--grep" => query.grep = Some(words.next()?.to_lowercase()),
                "--exec" => query.exec = Some(words.next()?.parse().ok()?),
                "--last" => {
                    query.last = words
                        .next()?
                        .parse()
                        .ok()
                        .filter(|last| (1..=LAST_LIMIT).contains(last))?;
                }
                "body" => {
                    let hash = words.next()?;
                    if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                        return None;
                    }
                    query.body = Some(hash.to_ascii_lowercase());
                }
                _ => return None,
            }
        }
        Some(query)
    }

    fn admits(&self, record: &Value, line: &str) -> bool {
        let kind = record["type"].as_str().unwrap_or_default();
        self.kind.as_deref().is_none_or(|wanted| wanted == kind)
            && self
                .exec
                .is_none_or(|exec| record["exec"].as_u64() == Some(exec))
            && self
                .grep
                .as_deref()
                .is_none_or(|text| line.to_lowercase().contains(text))
            && (!self.errors || problem(record))
    }
}

/// Failed requests, failed actions and executions, console errors and page errors.
fn problem(record: &Value) -> bool {
    match record["type"].as_str() {
        Some("network") => {
            record["failure"].is_string()
                || record["status"]
                    .as_u64()
                    .is_some_and(|status| status >= 400)
        }
        Some("action") => record["error"].is_string(),
        Some("execution") => record["ok"] == false,
        Some("console" | "page-error") => true,
        _ => false,
    }
}

/// The thin view: headers and long text out, sizes in their place.
fn thin(mut record: Value) -> Value {
    if let Some(fields) = record.as_object_mut() {
        fields.remove("headers");
        if let Some(post) = fields.remove("postData") {
            fields.insert(
                "postDataSize".into(),
                post.as_str().map_or(0, str::len).into(),
            );
        }
        for name in ["code", "output", "text", "message"] {
            if let Some(Value::String(text)) = fields.get_mut(name)
                && let Some((index, _)) = text.char_indices().nth(THIN_CHARS)
            {
                text.truncate(index);
                text.push('…');
            }
        }
    }
    record
}

/// Regular journal files of a project, oldest first; links and directories are skipped.
fn journals(directory: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "jsonl")
        })
        .collect();
    files.sort();
    files
}

/// The lines `query` asks for from the project's journal directory.
pub fn read(directory: &Path, query: &Query) -> std::io::Result<Vec<String>> {
    if let Some(hash) = &query.body {
        let path = directory.join("bodies").join(hash);
        let metadata = std::fs::symlink_metadata(&path)?;
        if !metadata.is_file() {
            return Err(std::io::ErrorKind::NotFound.into());
        }
        return Ok(vec![std::fs::read_to_string(path)?]);
    }
    let files = journals(directory);
    let chosen = if query.all {
        &files[..]
    } else {
        &files[files.len().saturating_sub(1)..]
    };
    let mut lines = std::collections::VecDeque::with_capacity(query.last);
    for file in chosen {
        for line in BufReader::new(std::fs::File::open(file)?).lines() {
            let line = line?;
            let Ok(record) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if !query.admits(&record, &line) {
                continue;
            }
            if lines.len() == query.last {
                lines.pop_front();
            }
            lines.push_back(if query.full {
                line
            } else {
                thin(record).to_string()
            });
        }
    }
    Ok(lines.into())
}

/// Removes journal files and bodies older than [`RETENTION`], then the oldest files while all
/// journals together take more than `total` bytes. Links are never followed.
pub fn prune(root: &Path, now: SystemTime, total: u64) {
    let Ok(projects) = std::fs::read_dir(root) else {
        return;
    };
    let mut kept: Vec<(SystemTime, u64, PathBuf)> = Vec::new();
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let bodies = project.path().join("bodies");
        let files = journals(&project.path()).into_iter().chain(
            std::fs::read_dir(&bodies)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
                .map(|entry| entry.path()),
        );
        for file in files {
            let Ok(metadata) = std::fs::symlink_metadata(&file) else {
                continue;
            };
            let modified = metadata.modified().unwrap_or(now);
            if now.duration_since(modified).unwrap_or_default() > RETENTION {
                let _ = std::fs::remove_file(&file);
            } else {
                kept.push((modified, metadata.len(), file));
            }
        }
    }
    kept.sort();
    let mut used: u64 = kept.iter().map(|(_, size, _)| size).sum();
    for (_, size, file) in kept {
        if used <= total {
            break;
        }
        if std::fs::remove_file(&file).is_ok() {
            used = used.saturating_sub(size);
        }
    }
}

/// What `recorder events` and `recorder frame` ask of one recording: the latest one unless named.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Recorder {
    pub recording: Option<String>,
    pub kind: Option<String>,
    pub errors: bool,
    /// Requests whose URL matches this pattern are left out.
    pub exclude: Option<String>,
    /// Only these events, as full records.
    pub ids: Vec<u64>,
    pub full: bool,
    /// The event `frame` looks at, and how long after it.
    pub event: Option<u64>,
    pub offset_ms: i64,
}

impl Recorder {
    /// `events [<id>...] [--recording <id>] [--type <t>] [--errors] [--exclude <re>] [--full]`
    /// or `frame <id> [--offset <ms>] [--recording <id>]`, without the leading word.
    pub fn parse(frame: bool, words: &[&str]) -> Option<Self> {
        let mut query = Self::default();
        let mut words = words.iter();
        while let Some(word) = words.next() {
            match *word {
                "--recording" => {
                    let id = words.next()?;
                    if id.is_empty()
                        || id.len() > 64
                        || !id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                    {
                        return None;
                    }
                    query.recording = Some((*id).to_owned());
                }
                "--type" if !frame => query.kind = Some((*words.next()?).to_owned()),
                "--errors" if !frame => query.errors = true,
                "--full" if !frame => query.full = true,
                "--exclude" if !frame => {
                    let pattern = words.next()?;
                    regex::Regex::new(pattern)
                        .ok()
                        .filter(|_| pattern.len() <= 200)?;
                    query.exclude = Some((*pattern).to_owned());
                }
                "--offset" if frame => {
                    query.offset_ms = words
                        .next()?
                        .parse()
                        .ok()
                        .filter(|ms: &i64| ms.abs() <= 3_600_000)?
                }
                id => {
                    let id = id.parse().ok()?;
                    if frame {
                        if query.event.replace(id).is_some() {
                            return None;
                        }
                    } else if query.ids.len() < 256 {
                        query.ids.push(id);
                    }
                }
            }
        }
        (!frame || query.event.is_some()).then_some(query)
    }
}

/// One recording's place in a journal file: the records after its start marker, up to its stop.
struct Window {
    file: PathBuf,
    start: u64,
    end: Option<u64>,
    dir: Option<String>,
    started_ms: Option<i64>,
}

fn records(file: &Path) -> Vec<Value> {
    std::fs::File::open(file)
        .map(|file| {
            BufReader::new(file)
                .lines()
                .map_while(Result::ok)
                .filter_map(|line| serde_json::from_str(&line).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn window(directory: &Path, recording: Option<&str>) -> Option<Window> {
    for file in journals(directory).into_iter().rev() {
        let mut found: Option<Window> = None;
        for record in records(&file) {
            if record["type"] != "recording" {
                continue;
            }
            let id = record["recording"].as_str().unwrap_or_default();
            let seq = record["seq"].as_u64().unwrap_or_default();
            match record["event"].as_str() {
                Some("started") if recording.is_none_or(|wanted| wanted == id) => {
                    found = Some(Window {
                        file: file.clone(),
                        start: seq,
                        end: None,
                        dir: record["dir"].as_str().map(str::to_owned),
                        started_ms: record["at"].as_str().and_then(epoch_ms),
                    });
                }
                Some("stopped") if recording.is_none_or(|wanted| wanted == id) => {
                    if let Some(window) = found.as_mut().filter(|window| window.end.is_none()) {
                        window.end = Some(seq);
                    }
                }
                _ => {}
            }
        }
        if found.is_some() {
            return found;
        }
    }
    None
}

fn inside(window: &Window, record: &Value) -> bool {
    let seq = record["seq"].as_u64().unwrap_or_default();
    seq > window.start && window.end.is_none_or(|end| seq < end)
}

/// The latest (or the named) recording's events: what the person did and what the pages did meanwhile.
pub fn recorder_events(directory: &Path, query: &Recorder) -> std::io::Result<Vec<String>> {
    let window =
        window(directory, query.recording.as_deref()).ok_or(std::io::ErrorKind::NotFound)?;
    let exclude = query
        .exclude
        .as_deref()
        .and_then(|pattern| regex::Regex::new(pattern).ok());
    let kinds = Query {
        kind: query.kind.clone(),
        errors: query.errors,
        last: LAST_LIMIT,
        ..Query::default()
    };
    Ok(records(&window.file)
        .into_iter()
        .filter(|record| inside(&window, record))
        .filter(|record| {
            query.ids.is_empty()
                || record["seq"]
                    .as_u64()
                    .is_some_and(|seq| query.ids.contains(&seq))
        })
        .filter(|record| {
            !(record["type"] == "network"
                && exclude.as_ref().is_some_and(|pattern| {
                    pattern.is_match(record["url"].as_str().unwrap_or_default())
                }))
        })
        .filter(|record| kinds.admits(record, ""))
        .map(|record| {
            if query.full || !query.ids.is_empty() {
                record.to_string()
            } else {
                thin(record).to_string()
            }
        })
        .collect())
}

/// The frame of the event's page closest to the event plus `offset_ms`: the last one at or before
/// that moment, else the first one after it.
pub fn recorder_frame(directory: &Path, query: &Recorder) -> std::io::Result<PathBuf> {
    let window =
        window(directory, query.recording.as_deref()).ok_or(std::io::ErrorKind::NotFound)?;
    let event = records(&window.file)
        .into_iter()
        .find(|record| inside(&window, record) && record["seq"].as_u64() == query.event)
        .ok_or(std::io::ErrorKind::NotFound)?;
    let (Some(dir), Some(started), Some(at)) = (
        window.dir.as_deref(),
        window.started_ms,
        event["at"].as_str().and_then(epoch_ms),
    ) else {
        return Err(std::io::ErrorKind::NotFound.into());
    };
    let target = at - started + query.offset_ms;
    let page = event["page"].as_u64();
    let frames = Path::new(dir).join("frames");
    let mut found: Vec<(i64, PathBuf)> = std::fs::read_dir(&frames)?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let (ms, rest) = name.strip_suffix(".jpg")?.split_once("-p")?;
            let frame_page: u64 = rest.parse().ok()?;
            page.is_none_or(|page| page == frame_page)
                .then(|| (ms.parse().ok(), entry.path()))
                .and_then(|(ms, path)| Some((ms?, path)))
        })
        .collect();
    found.sort();
    found
        .iter()
        .rev()
        .find(|(ms, _)| *ms <= target)
        .or_else(|| found.first())
        .map(|(_, path)| path.clone())
        .ok_or_else(|| std::io::ErrorKind::NotFound.into())
}

/// Milliseconds since the Unix epoch of `YYYY-MM-DDTHH:MM:SS[.mmm]Z`, as the journal writes it.
fn epoch_ms(text: &str) -> Option<i64> {
    let text = text.strip_suffix('Z')?;
    let (date, time) = text.split_once('T')?;
    let mut date = date.split('-').map(str::parse::<i64>);
    let (year, month, day) = (date.next()?.ok()?, date.next()?.ok()?, date.next()?.ok()?);
    let (clock, fraction) = time.split_once('.').unwrap_or((time, "0"));
    let mut clock = clock.split(':').map(str::parse::<i64>);
    let (hour, minute, second) = (
        clock.next()?.ok()?,
        clock.next()?.ok()?,
        clock.next()?.ok()?,
    );
    let millis: i64 = format!("{fraction:0<3}").get(..3)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    // Days from the civil date (Howard Hinnant's algorithm).
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    let days = era * 146_097 + of_cycle - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000 + millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn journal(directory: &Path, name: &str, records: &[Value]) {
        std::fs::create_dir_all(directory).unwrap();
        let text: String = records.iter().map(|record| format!("{record}\n")).collect();
        std::fs::write(directory.join(name), text).unwrap();
    }

    #[test]
    fn queries_parse_only_bounded_known_words() {
        assert_eq!(
            Query::parse(&["--errors", "--type", "network", "--last", "5"]),
            Some(Query {
                errors: true,
                kind: Some("network".into()),
                last: 5,
                ..Query::default()
            })
        );
        assert_eq!(Query::parse(&["--last", "0"]), None);
        assert_eq!(Query::parse(&["--last", "10001"]), None);
        assert_eq!(Query::parse(&["--exec"]), None);
        assert_eq!(Query::parse(&["--what"]), None);
        assert_eq!(Query::parse(&["body", "../../etc/passwd"]), None);
        assert!(Query::parse(&["body", &"a".repeat(64)]).is_some());
    }

    #[test]
    fn the_newest_journal_reads_thin_and_filters_problems() {
        let directory = tempfile::tempdir().unwrap();
        journal(
            directory.path(),
            "1-old.jsonl",
            &[json!({ "type": "execution", "exec": 1, "ok": false })],
        );
        journal(
            directory.path(),
            "2-new.jsonl",
            &[
                json!({ "type": "execution", "exec": 1, "ok": true, "code": "x".repeat(400) }),
                json!({ "type": "network", "exec": 1, "status": 200, "headers": { "accept": "*/*" }, "postData": "a=1" }),
                json!({ "type": "network", "exec": 2, "status": 500, "url": "https://shop.test/api" }),
                json!({ "type": "console", "exec": 2, "level": "error", "text": "boom" }),
                "not json".into(),
            ],
        );
        let all = read(directory.path(), &Query::parse(&[]).unwrap()).unwrap();
        assert_eq!(all.len(), 5);
        let first: Value = serde_json::from_str(&all[0]).unwrap();
        assert_eq!(
            first["code"].as_str().unwrap().chars().count(),
            THIN_CHARS + 1
        );
        let request: Value = serde_json::from_str(&all[1]).unwrap();
        assert_eq!(request.get("headers"), None);
        assert_eq!(request["postDataSize"], 3);
        let problems = read(directory.path(), &Query::parse(&["--errors"]).unwrap()).unwrap();
        assert_eq!(problems.len(), 2);
        let everywhere = read(
            directory.path(),
            &Query::parse(&["--all", "--errors"]).unwrap(),
        )
        .unwrap();
        assert_eq!(everywhere.len(), 3);
        let found = read(
            directory.path(),
            &Query::parse(&["--grep", "SHOP.TEST", "--full"]).unwrap(),
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        let last = read(
            directory.path(),
            &Query::parse(&["--exec", "2", "--last", "1"]).unwrap(),
        )
        .unwrap();
        assert!(last[0].contains("boom"));
    }

    #[test]
    fn a_body_is_read_by_hash_and_never_through_a_link() {
        let directory = tempfile::tempdir().unwrap();
        let bodies = directory.path().join("bodies");
        std::fs::create_dir_all(&bodies).unwrap();
        let hash = "b".repeat(64);
        std::fs::write(bodies.join(&hash), "{\"ok\":true}").unwrap();
        let query = Query::parse(&["body", &hash]).unwrap();
        assert_eq!(read(directory.path(), &query).unwrap(), ["{\"ok\":true}"]);
        #[cfg(unix)]
        {
            let link = "c".repeat(64);
            std::os::unix::fs::symlink(bodies.join(&hash), bodies.join(&link)).unwrap();
            assert!(read(directory.path(), &Query::parse(&["body", &link]).unwrap()).is_err());
        }
    }

    #[test]
    fn retention_removes_old_files_then_the_oldest_beyond_the_total() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("shop");
        journal(&project, "a.jsonl", &[json!({ "type": "page" })]);
        journal(&project, "b.jsonl", &[json!({ "type": "page" })]);
        std::fs::create_dir_all(project.join("bodies")).unwrap();
        std::fs::write(project.join("bodies").join("c"), "body").unwrap();
        let later = SystemTime::now() + RETENTION + Duration::from_secs(60);
        prune(root.path(), SystemTime::now(), u64::MAX);
        assert_eq!(journals(&project).len(), 2);
        // The total bound removes the oldest first, one at a time.
        let size = std::fs::metadata(project.join("a.jsonl")).unwrap().len();
        prune(root.path(), SystemTime::now(), size * 2);
        assert_eq!(
            journals(&project).len() + usize::from(project.join("bodies/c").exists()),
            2
        );
        prune(root.path(), later, u64::MAX);
        assert!(journals(&project).is_empty());
        assert!(!project.join("bodies/c").exists());
    }

    #[test]
    fn journal_times_read_as_milliseconds_since_the_epoch() {
        assert_eq!(epoch_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(
            epoch_ms("2026-10-29T08:52:16.112Z"),
            Some(1_793_263_936_112)
        );
        assert_eq!(epoch_ms("2000-02-29T12:00:00Z"), Some(951_825_600_000));
        assert_eq!(epoch_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(epoch_ms("yesterday"), None);
    }

    #[test]
    fn a_recording_reads_its_own_window_and_finds_the_frame_of_an_event() {
        let directory = tempfile::tempdir().unwrap();
        let frames = directory.path().join("rec").join("frames");
        std::fs::create_dir_all(&frames).unwrap();
        for name in [
            "00000000-p1.jpg",
            "00000400-p1.jpg",
            "00000900-p1.jpg",
            "00000500-p2.jpg",
        ] {
            std::fs::write(frames.join(name), b"jpeg").unwrap();
        }
        let dir = directory.path().join("rec");
        journal(
            directory.path(),
            "1.jsonl",
            &[
                json!({ "type": "network", "seq": 1, "status": 500 }),
                json!({ "type": "recording", "seq": 2, "event": "started", "recording": "r1", "dir": dir, "at": "2026-10-29T08:00:00.000Z" }),
                json!({ "type": "person-action", "seq": 3, "page": 1, "action": "click", "at": "2026-10-29T08:00:00.500Z" }),
                json!({ "type": "network", "seq": 4, "url": "https://shop.test/analytics", "status": 200 }),
                json!({ "type": "network", "seq": 5, "url": "https://shop.test/api", "status": 500, "headers": {} }),
                json!({ "type": "recording", "seq": 6, "event": "stopped", "recording": "r1" }),
                json!({ "type": "console", "seq": 7, "level": "error", "text": "after" }),
            ],
        );
        let all = recorder_events(directory.path(), &Recorder::parse(false, &[]).unwrap()).unwrap();
        assert_eq!(all.len(), 3);
        let errors = recorder_events(
            directory.path(),
            &Recorder::parse(false, &["--errors", "--exclude", "analytics"]).unwrap(),
        )
        .unwrap();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].contains("/api"));
        let one =
            recorder_events(directory.path(), &Recorder::parse(false, &["5"]).unwrap()).unwrap();
        assert!(one[0].contains("headers"));
        let frame =
            recorder_frame(directory.path(), &Recorder::parse(true, &["3"]).unwrap()).unwrap();
        assert!(frame.ends_with("00000400-p1.jpg"));
        let later = recorder_frame(
            directory.path(),
            &Recorder::parse(true, &["3", "--offset", "450"]).unwrap(),
        )
        .unwrap();
        assert!(later.ends_with("00000900-p1.jpg"));
        assert!(
            recorder_events(
                directory.path(),
                &Recorder::parse(false, &["--recording", "r9"]).unwrap()
            )
            .is_err()
        );
        assert_eq!(Recorder::parse(true, &[]), None);
        assert_eq!(Recorder::parse(false, &["--exclude", "("]), None);
    }
}
