//! The owner's observation profile (docs/observability.md). The extension's popup chooses it; the
//! host keeps it, answers `NDS.observation` on a browser session and tells every such session of
//! a change, so each executor collects exactly what the profile allows.

use super::{Host, State};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Observation {
    Full,
    /// Also what an extension that names no profile gets.
    #[default]
    Standard,
    Off,
}

impl Observation {
    pub(crate) fn parse(value: &Value) -> Self {
        match value.as_str() {
            Some("full") => Self::Full,
            Some("off") => Self::Off,
            _ => Self::Standard,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Full => "full",
            Self::Standard => "standard",
            Self::Off => "off",
        }
    }
}

impl Host {
    /// Applies the profile the extension reports and tells the executors' browser sessions.
    pub(super) fn observe(&self, profile: Observation) {
        let mut state = self.state();
        if state.observation == profile {
            return;
        }
        state.observation = profile;
        // The closed telemetry schema names no profiles, so each has its own event.
        match profile {
            Observation::Full => {
                tracing::info!(event.name = "browser.observation.full", outcome = "ok")
            }
            Observation::Standard => {
                tracing::info!(event.name = "browser.observation.standard", outcome = "ok")
            }
            Observation::Off => {
                tracing::info!(event.name = "browser.observation.off", outcome = "ok")
            }
        }
        // Off and standard collect no content: what the journals hold back is dropped.
        if profile != Observation::Full {
            for session in state.sessions.values() {
                if let Some(journal) = &session.journal {
                    journal
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .discard();
                }
            }
        }
        notify(&mut state);
    }

    pub(super) fn observation(&self) -> Value {
        json!({ "profile": self.state().observation.as_str() })
    }
}

fn notify(state: &mut State) {
    let profile = state.observation.as_str();
    let targets: Vec<(String, String)> = state
        .sessions
        .iter()
        .flat_map(|(project, session)| {
            super::relay::browser_aliases(session)
                .into_iter()
                .map(move |alias| (project.clone(), alias))
        })
        .collect();
    for (project, alias) in targets {
        let event = json!({ "method": "NDS.observation", "params": { "profile": profile }, "sessionId": alias });
        super::deliver(state, &project, event);
    }
}

/// The most private sites the owner can keep.
const SITES_LIMIT: usize = 256;
/// The newest journal records the popup shows of an agent group.
const RECENT: usize = 12;

/// The owner's private sites from the extension: lowercase host names, each with its subdomains.
pub(super) fn sites(value: &Value) -> Vec<String> {
    let mut sites: Vec<String> = value
        .as_array()
        .map(|sites| {
            sites
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_ascii_lowercase)
                .filter(|site| {
                    (1..=253).contains(&site.len())
                        && !site.starts_with('.')
                        && !site.ends_with('.')
                        && site
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b".-".contains(&byte))
                })
                .take(SITES_LIMIT)
                .collect()
        })
        .unwrap_or_default();
    sites.sort();
    sites.dedup();
    sites
}

impl Host {
    /// The popup's view of an agent group's newest journal records, for the owner of this device.
    pub(super) async fn recent(&self, message: &Value) {
        let project = message["group"].as_str().unwrap_or_default().to_owned();
        let directory = self.config.activity.join(&project);
        let lines = if crate::protocol::valid_project(&project) {
            tokio::task::spawn_blocking(move || {
                let query = crate::activity::Query {
                    last: RECENT,
                    ..Default::default()
                };
                crate::activity::read(&directory, &query).unwrap_or_default()
            })
            .await
            .unwrap_or_default()
        } else {
            Vec::new()
        };
        let answer = json!({ "type": "journaled", "request": message["request"], "lines": lines });
        if let Some(framed) = serde_json::to_vec(&answer)
            .ok()
            .and_then(|body| super::frame(&body))
        {
            let _ = self.outbound.try_send(framed);
        }
    }

    /// `NDS.activity { records, flush }`: the executor's raw records for the session's journal,
    /// kept only in the full profile. Writing happens off the async runtime.
    pub(super) async fn activity(&self, project: &str, params: &Value) -> Value {
        let records: Vec<Value> = params["records"]
            .as_array()
            .map(|records| records.iter().take(256).cloned().collect())
            .unwrap_or_default();
        let flush = params["flush"].as_bool() == Some(true);
        let journal = {
            let mut state = self.state();
            if state.observation != Observation::Full {
                return json!({ "kept": false });
            }
            let sites = state.private_sites.clone();
            Self::open_journal(&mut state, &self.config.activity, project)
                .map(|journal| (journal, sites))
        };
        let Some((journal, sites)) = journal else {
            return json!({ "kept": false });
        };
        let _ = tokio::task::spawn_blocking(move || {
            let mut writer = journal.lock().unwrap_or_else(|error| error.into_inner());
            writer.set_private(&sites);
            let now = std::time::Instant::now();
            for record in &records {
                writer.ingest(record, now);
            }
            if flush {
                writer.flush();
            } else {
                writer.tick(now);
            }
        })
        .await;
        json!({ "kept": true })
    }

    /// `NDS.recording { frame, words }`: the recorder's events or one event's frame for agent
    /// code, read from the journal as `recorder events` and `recorder frame` read it.
    pub(super) async fn recording(&self, project: &str, params: &Value) -> Value {
        let frame = params["frame"].as_bool() == Some(true);
        let words: Vec<String> = params["words"]
            .as_array()
            .map(|words| {
                words
                    .iter()
                    .filter_map(Value::as_str)
                    .take(64)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let journal = self
            .state()
            .sessions
            .get(project)
            .and_then(|session| session.journal.clone());
        let directory = self.config.activity.join(project);
        let answer = tokio::task::spawn_blocking(move || {
            if let Some(journal) = journal {
                journal
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .flush();
            }
            let words: Vec<&str> = words.iter().map(String::as_str).collect();
            let Some(query) = crate::activity::Recorder::parse(frame, &words) else {
                return json!({ "error": "invalid_request" });
            };
            let found = if frame {
                crate::activity::recorder_frame(&directory, &query)
                    .map(|path| vec![path.display().to_string()])
            } else {
                crate::activity::recorder_events(&directory, &query)
            };
            match found {
                Ok(lines) => json!({ "lines": lines }),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    json!({ "error": "not_found" })
                }
                Err(_) => json!({ "error": "unavailable" }),
            }
        })
        .await;
        answer.unwrap_or_else(|_| json!({ "error": "unavailable" }))
    }

    /// Writes records the host itself observed, in the full profile only.
    pub(super) fn journal(
        state: &mut State,
        root: &std::path::Path,
        project: &str,
        records: &[Value],
    ) {
        if state.observation != Observation::Full {
            return;
        }
        let sites = state.private_sites.clone();
        if let Some(journal) = Self::open_journal(state, root, project) {
            let mut writer = journal.lock().unwrap_or_else(|error| error.into_inner());
            writer.set_private(&sites);
            for record in records {
                writer.ingest(record, std::time::Instant::now());
            }
        }
    }

    fn open_journal(
        state: &mut State,
        root: &std::path::Path,
        project: &str,
    ) -> Option<std::sync::Arc<std::sync::Mutex<crate::activity::Writer>>> {
        let session = state.sessions.get_mut(project)?;
        let journal = session.journal.get_or_insert_with(|| {
            let started = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            let life: String = session.life.generation.chars().take(8).collect();
            let name = format!("{started:012}-{life}.jsonl");
            std::sync::Arc::new(std::sync::Mutex::new(crate::activity::Writer::new(
                &root.join(project),
                &name,
            )))
        });
        Some(journal.clone())
    }

    /// Writes the records the journals held for folding once nothing identical followed them.
    pub(super) fn tick_journals(&self) {
        let journals: Vec<_> = self
            .state()
            .sessions
            .values()
            .filter_map(|session| session.journal.clone())
            .collect();
        let now = std::time::Instant::now();
        for journal in journals {
            journal
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .tick(now);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_full_and_off_are_named_and_anything_else_is_standard() {
        assert_eq!(Observation::parse(&json!("full")), Observation::Full);
        assert_eq!(Observation::parse(&json!("off")), Observation::Off);
        for other in [json!("standard"), json!("FULL"), json!(null), json!(1)] {
            assert_eq!(Observation::parse(&other), Observation::Standard);
        }
        assert_eq!(Observation::Full.as_str(), "full");
    }
}
