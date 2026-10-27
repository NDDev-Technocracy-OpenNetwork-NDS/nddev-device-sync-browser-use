//! Typed control protocol between agent clients and the host.
//!
//! One exchange is a request frame, then a reply header frame `{"bytes":N}`
//! followed by exactly `N` payload bytes, matching `adapter-io` LocalChannel.

use crate::view;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Request and header frames, including the newline.
pub const FRAME_LIMIT: usize = 65_536;
/// Reply payload; equal to the LocalChannel payload ceiling.
pub const PAYLOAD_LIMIT: usize = 1_048_576;
/// Executor output kept in a reply; the rest is reported as truncated.
pub const OUTPUT_LIMIT: usize = 900_000;
/// One execution, leaving headroom inside the 30 s LocalChannel deadline.
pub const MAX_EXECUTION: Duration = Duration::from_secs(25);
pub const MAX_SESSIONS: usize = 8;
pub const MAX_TABS: usize = 32;
const PROJECT_LIMIT: usize = 48;

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Status,
    Open {
        project: String,
    },
    /// Reserves a new generation without claiming tabs or starting an executor.
    CreateOwned {
        project: String,
    },
    OpenOwned {
        session: OwnedSession,
    },
    ExecuteOwned {
        session: OwnedSession,
        code: String,
        timeout_ms: u64,
        expect: Option<Document>,
    },
    CloseOwned {
        session: OwnedSession,
        close_tabs: bool,
    },
    Sessions,
    Close {
        project: String,
        close_tabs: bool,
    },
    Execute {
        project: String,
        code: String,
        timeout_ms: u64,
        expect: Option<Document>,
    },
    /// Reloads an unpacked extension whose installed files are newer.
    Update,
}

impl std::fmt::Debug for Request {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Request bodies may contain agent code and private project/document IDs.
        formatter.write_str(match self {
            Self::Status => "Request::Status",
            Self::Open { .. } => "Request::Open(REDACTED)",
            Self::CreateOwned { .. } => "Request::CreateOwned(REDACTED)",
            Self::OpenOwned { .. } => "Request::OpenOwned(REDACTED)",
            Self::ExecuteOwned { .. } => "Request::ExecuteOwned(REDACTED)",
            Self::CloseOwned { .. } => "Request::CloseOwned(REDACTED)",
            Self::Sessions => "Request::Sessions",
            Self::Close { .. } => "Request::Close(REDACTED)",
            Self::Execute { .. } => "Request::Execute(REDACTED)",
            Self::Update => "Request::Update",
        })
    }
}

/// Private local control handle. Keep it in Rust, outside telemetry and UI DTOs.
/// Only the host creates generations; a project name alone is not ownership.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedSession {
    pub(crate) project: String,
    pub(crate) generation: String,
}

impl std::fmt::Debug for OwnedSession {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("OwnedSession(REDACTED)")
    }
}

/// Identity of one loaded document: the tab target and its main-frame loader.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Document {
    pub target: String,
    pub document: String,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "result", rename_all = "snake_case", deny_unknown_fields)]
pub enum Reply {
    Status(view::Status),
    Session(view::Session),
    OwnedSession(OwnedSession),
    Sessions { sessions: Vec<view::Session> },
    Closed,
    Executed(view::Outcome),
    Updated { reload: bool },
    Refused { refusal: Refusal },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Header {
    pub bytes: usize,
}

/// Stable refusal vocabulary; also the telemetry `error.type` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "snake_case")]
pub enum Refusal {
    #[error("agent browser control is disabled by the owner")]
    PermissionRequired,
    #[error("the NDS browser extension is not connected")]
    ExtensionUnavailable,
    #[error("the session is already executing")]
    Busy,
    #[error("the session or tab limit is reached")]
    Capacity,
    #[error("no session exists for this project")]
    SessionNotFound,
    #[error("the project name is invalid")]
    InvalidProject,
    #[error("the request is invalid")]
    InvalidRequest,
    #[error("the expected tab is closed or not in this session")]
    TargetClosed,
    #[error("the expected document was replaced")]
    StaleDocument,
    #[error("the execution exceeded its deadline; session state was reset")]
    Timeout,
    #[error("the executor is unavailable")]
    ExecutorUnavailable,
    #[error("a browser message exceeds its size limit")]
    PayloadLimit,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::PermissionRequired => "permission_required",
            Self::ExtensionUnavailable => "extension_unavailable",
            Self::Busy => "busy",
            Self::Capacity => "capacity",
            Self::SessionNotFound => "session_not_found",
            Self::InvalidProject => "invalid_project",
            Self::InvalidRequest => "invalid_request",
            Self::TargetClosed => "target_closed",
            Self::StaleDocument => "stale_document",
            Self::Timeout => "timeout",
            Self::ExecutorUnavailable => "executor_unavailable",
            Self::PayloadLimit => "payload_limit",
        }
    }
}

/// Project names become tab-group titles and directory names.
pub fn valid_project(project: &str) -> bool {
    (1..=PROJECT_LIMIT).contains(&project.len())
        && !project.starts_with('.')
        && project
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

pub fn valid_execution(timeout_ms: u64) -> bool {
    (1..=MAX_EXECUTION.as_millis() as u64).contains(&timeout_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owned_requests_keep_the_handle_private_and_reject_incomplete_generations() {
        let handle = OwnedSession {
            project: "project".into(),
            generation: "host-generation".into(),
        };
        assert_eq!(format!("{handle:?}"), "OwnedSession(REDACTED)");
        let request = Request::OpenOwned {
            session: handle.clone(),
        };
        assert_eq!(format!("{request:?}"), "Request::OpenOwned(REDACTED)");
        assert_eq!(
            format!(
                "{:?}",
                Request::ExecuteOwned {
                    session: handle.clone(),
                    code: "INERT-PRIVATE-CODE".into(),
                    timeout_ms: 1,
                    expect: None,
                }
            ),
            "Request::ExecuteOwned(REDACTED)"
        );
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(wire["op"], "open_owned");
        assert_eq!(serde_json::from_value::<Request>(wire).unwrap(), request);
        for invalid in [
            r#"{"op":"open_owned","session":{"project":"project"}}"#,
            r#"{"op":"close_owned","session":{"project":"project","generation":"g","extra":true},"close_tabs":false}"#,
        ] {
            assert!(serde_json::from_str::<Request>(invalid).is_err());
        }
        // Existing project clients keep their original wire operation and fields.
        assert_eq!(
            serde_json::to_value(Request::Open {
                project: "project".into()
            })
            .unwrap(),
            serde_json::json!({ "op": "open", "project": "project" })
        );
    }

    #[test]
    fn project_names_are_bounded_titles_and_path_segments() {
        for valid in ["nds", "client-site_2", "a.b"] {
            assert!(valid_project(valid), "{valid}");
        }
        for invalid in [
            "",
            ".hidden",
            "../x",
            "a/b",
            "with space",
            &"x".repeat(49),
            "проект",
        ] {
            assert!(!valid_project(invalid), "{invalid}");
        }
    }

    #[test]
    fn execution_deadline_fits_the_local_channel() {
        assert!(valid_execution(1) && valid_execution(25_000));
        assert!(!valid_execution(0) && !valid_execution(25_001));
    }

    #[test]
    fn requests_reject_unknown_operations_and_fields() {
        let open: Request = serde_json::from_str(r#"{"op":"open","project":"nds"}"#).unwrap();
        assert_eq!(
            open,
            Request::Open {
                project: "nds".into()
            }
        );
        for invalid in [
            r#"{"op":"shell","command":"id"}"#,
            r#"{"op":"open","project":"nds","url":"https://example.com"}"#,
            r#"{"op":"execute","project":"nds","code":"1"}"#,
        ] {
            assert!(
                serde_json::from_str::<Request>(invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn refusal_codes_match_their_wire_names() {
        for refusal in [
            Refusal::PermissionRequired,
            Refusal::StaleDocument,
            Refusal::Timeout,
        ] {
            let wire = serde_json::to_value(refusal).unwrap();
            assert_eq!(wire, refusal.code());
        }
    }
}
