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
}
