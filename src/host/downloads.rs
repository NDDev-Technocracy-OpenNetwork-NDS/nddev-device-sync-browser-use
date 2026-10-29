//! Agent downloads. Chrome refuses an extension's `Page.setDownloadBehavior`, so a download keeps
//! the browser's folder. The extension names the finished file of each download that began in an
//! agent tab, or in a tab one opened. The host keeps a copy in that session's area, hands its path
//! to the executor's `NDS.takeDownload`, and then asks the extension to remove the browser's copy.
//! A file only ever goes to the session its download belongs to.

use super::{Failure, Host};
use crate::protocol::Refusal;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::Notify;

/// Finished downloads a session keeps for its executor, and how long one waits to be taken.
const KEPT: usize = 32;
const KEEP_FOR: Duration = Duration::from_secs(300);
/// The longest one `NDS.takeDownload` waits for a download that is still loading.
const WAIT_LIMIT: Duration = Duration::from_secs(30);
const URL_LIMIT: usize = 8192;

/// The finished downloads of one session that its executor has not taken yet.
#[derive(Default)]
pub(super) struct Files {
    finished: VecDeque<Finished>,
    /// Downloads the browser finished whose copy is still being made.
    copying: Vec<Vec<String>>,
    changed: Arc<Notify>,
}

struct Finished {
    /// The download's first and final URL; the executor names it by either.
    urls: Vec<String>,
    outcome: Result<PathBuf, &'static str>,
    at: Instant,
}

impl Files {
    fn copying(&self, url: &str) -> bool {
        self.copying
            .iter()
            .any(|urls| urls.iter().any(|known| known == url))
    }

    fn push(&mut self, finished: Finished) {
        if let Some(index) = self.copying.iter().position(|urls| *urls == finished.urls) {
            self.copying.swap_remove(index);
        }
        let now = Instant::now();
        self.finished
            .retain(|each| now.duration_since(each.at) < KEEP_FOR);
        if self.finished.len() >= KEPT {
            self.finished.pop_front();
        }
        self.finished.push_back(finished);
        self.changed.notify_waiters();
    }

    /// The oldest finished download at `url`, taken out.
    fn take(&mut self, url: &str) -> Option<Result<PathBuf, &'static str>> {
        let index = self
            .finished
            .iter()
            .position(|each| each.urls.iter().any(|known| known == url))?;
        self.finished.remove(index).map(|each| each.outcome)
    }
}

impl Host {
    /// The extension reports that a download of an agent area finished or failed.
    pub(super) fn on_download(self: &Arc<Self>, message: &Value) {
        let urls: Vec<String> = message["urls"]
            .as_array()
            .map(|urls| {
                urls.iter()
                    .filter_map(Value::as_str)
                    .filter(|url| !url.is_empty() && url.len() <= URL_LIMIT)
                    .take(2)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let (Some(project), Some(id), false) = (
            message["group"].as_str(),
            message["id"].as_i64(),
            urls.is_empty(),
        ) else {
            tracing::warn!(event.name = "browser.download.kept", outcome = "rejected", error.type = "invalid_frame");
            return;
        };
        let (Some("complete"), Some(source)) =
            (message["state"].as_str(), message["path"].as_str())
        else {
            self.finished(project, urls, Err("interrupted"));
            return;
        };
        let artifacts = {
            let mut state = self.state();
            let Some(session) = state.sessions.get_mut(project) else {
                return;
            };
            if session.files.copying.len() >= KEPT {
                session.files.copying.remove(0);
            }
            session.files.copying.push(urls.clone());
            session.artifacts.clone()
        };
        let (host, project, source) = (self.clone(), project.to_owned(), PathBuf::from(source));
        let name = message["name"].as_str().map(str::to_owned);
        tokio::spawn(async move {
            let kept =
                tokio::task::spawn_blocking(move || keep(&source, name.as_deref(), &artifacts))
                    .await
                    .unwrap_or(Err("copy_failed"));
            let forget = kept.is_ok();
            host.finished(&project, urls, kept);
            // Only a copy the session holds lets the browser's copy go.
            if forget {
                let _ = host
                    .refusable(json!({ "type": "forget", "download": id }))
                    .await;
            }
        });
    }

    fn finished(&self, project: &str, urls: Vec<String>, outcome: Result<PathBuf, &'static str>) {
        match &outcome {
            Ok(_) => tracing::info!(event.name = "browser.download.kept", outcome = "ok"),
            Err(error) => {
                tracing::warn!(event.name = "browser.download.kept", outcome = "error", error.type = *error)
            }
        }
        let mut state = self.state();
        if let Some(session) = state.sessions.get_mut(project) {
            session.files.push(Finished {
                urls,
                outcome,
                at: Instant::now(),
            });
        }
    }

    /// `NDS.takeDownload { url, waitMs }`: the session's copy of the download at `url`, waiting
    /// at most `waitMs` while it still loads. Answers `{ file }`, `{ error }`, `{ pending: true,
    /// copying }` or, when the extension cannot name download files, `{ unsupported: true }`.
    pub(super) async fn take_download(
        &self,
        project: &str,
        params: &Value,
    ) -> Result<Value, Failure> {
        let url = params["url"].as_str().unwrap_or_default();
        let wait = Duration::from_millis(params["waitMs"].as_u64().unwrap_or(0)).min(WAIT_LIMIT);
        let until = Instant::now() + wait;
        let mut copying;
        loop {
            let changed = self
                .state()
                .sessions
                .get(project)
                .map(|session| session.files.changed.clone())
                .ok_or(Failure::Refused(Refusal::SessionNotFound))?;
            // Interest is registered before the check, so a file kept in between still wakes it.
            let mut notified = std::pin::pin!(changed.notified());
            notified.as_mut().enable();
            {
                let mut state = self.state();
                if !state.downloads {
                    return Ok(json!({ "unsupported": true }));
                }
                let session = state
                    .sessions
                    .get_mut(project)
                    .ok_or(Failure::Refused(Refusal::SessionNotFound))?;
                match session.files.take(url) {
                    Some(Ok(file)) => return Ok(json!({ "file": file })),
                    Some(Err(error)) => return Ok(json!({ "error": error })),
                    None => copying = session.files.copying(url),
                }
            }
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Ok(json!({ "pending": true, "copying": copying }));
            }
            let _ = tokio::time::timeout(left, notified).await;
        }
    }
}

/// Takes a finished download into the session's area, never through a link, under the name the
/// site suggested when it is a plain file name, else under the browser's. The browser's file is
/// moved when both lie on one file system, so a large download is neither copied nor held twice;
/// elsewhere it is copied, and the browser's copy goes once the host answers `forget`.
fn keep(source: &Path, suggested: Option<&str>, artifacts: &Path) -> Result<PathBuf, &'static str> {
    let metadata = std::fs::symlink_metadata(source).map_err(|_| "missing")?;
    let plain = suggested
        .map(Path::new)
        .filter(|name| name.file_name() == Some(name.as_os_str()));
    let name = plain
        .and_then(Path::file_name)
        .or(source.file_name())
        .filter(|_| metadata.is_file())
        .ok_or("not_a_file")?;
    let folder = artifacts
        .join(".downloads")
        .join(super::token().map_err(|_| "copy_failed")?);
    std::fs::create_dir_all(&folder).map_err(|_| "copy_failed")?;
    let target = folder.join(name);
    if std::fs::rename(source, &target).is_err() {
        std::fs::copy(source, &target).map_err(|_| "copy_failed")?;
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finished(urls: &[&str], outcome: Result<PathBuf, &'static str>) -> Finished {
        Finished {
            urls: urls.iter().map(|url| (*url).to_owned()).collect(),
            outcome,
            at: Instant::now(),
        }
    }

    #[test]
    fn a_download_is_taken_once_by_either_of_its_urls_oldest_first() {
        let mut files = Files::default();
        files.push(finished(
            &["http://a/start", "http://b/final"],
            Ok("one".into()),
        ));
        files.push(finished(&["http://b/final"], Ok("two".into())));
        assert_eq!(files.take("http://b/final"), Some(Ok(PathBuf::from("one"))));
        assert_eq!(files.take("http://a/start"), None);
        assert_eq!(files.take("http://b/final"), Some(Ok(PathBuf::from("two"))));
        assert_eq!(files.take("http://b/final"), None);
    }

    #[test]
    fn a_download_being_copied_is_known_until_its_copy_is_kept() {
        let mut files = Files::default();
        files
            .copying
            .push(vec!["http://a/start".into(), "http://b/final".into()]);
        assert!(files.copying("http://b/final"));
        files.push(finished(
            &["http://a/start", "http://b/final"],
            Ok("kept".into()),
        ));
        assert!(!files.copying("http://b/final"));
        assert_eq!(
            files.take("http://a/start"),
            Some(Ok(PathBuf::from("kept")))
        );
    }

    #[test]
    fn a_session_keeps_only_its_latest_downloads() {
        let mut files = Files::default();
        for index in 0..KEPT + 3 {
            files.push(finished(
                &[&format!("http://a/{index}")],
                Err("interrupted"),
            ));
        }
        assert_eq!(files.finished.len(), KEPT);
        assert_eq!(files.take("http://a/0"), None);
        assert_eq!(
            files.take(&format!("http://a/{}", KEPT + 2)),
            Some(Err("interrupted"))
        );
    }

    #[test]
    fn only_a_regular_file_is_kept_and_a_link_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("report.pdf");
        let downloaded = || std::fs::write(&source, b"bytes").unwrap();
        downloaded();
        let area = directory.path().join("area");
        let kept = keep(&source, None, &area).unwrap();
        assert_eq!(kept.file_name().unwrap(), "report.pdf");
        assert!(kept.starts_with(area.join(".downloads")));
        assert_eq!(std::fs::read(&kept).unwrap(), b"bytes");
        // On one file system the browser's file moved into the session.
        assert!(!source.exists());
        // The site's name wins; one that names a path or a parent falls back to the browser's.
        downloaded();
        let named = keep(&source, Some("Invoice 7.pdf"), &area).unwrap();
        assert_eq!(named.file_name().unwrap(), "Invoice 7.pdf");
        for unsafe_name in ["../escape.pdf", "nested/escape.pdf", "..", ""] {
            downloaded();
            let kept = keep(&source, Some(unsafe_name), &area).unwrap();
            assert_eq!(kept.file_name().unwrap(), "report.pdf", "{unsafe_name}");
        }
        downloaded();
        assert_eq!(
            keep(&directory.path().join("gone"), None, &area),
            Err("missing")
        );
        assert_eq!(keep(directory.path(), None, &area), Err("not_a_file"));
        #[cfg(unix)]
        {
            let link = directory.path().join("link.pdf");
            std::os::unix::fs::symlink(&source, &link).unwrap();
            assert_eq!(keep(&link, None, &area), Err("not_a_file"));
        }
    }
}
