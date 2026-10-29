use serde::{Deserialize, Serialize};

// URLs, titles and executor output are private operation results. These
// types deliberately do not implement Debug and never become telemetry.

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Status {
    pub enabled: bool,
    /// The owner's observation profile: full, standard or off (docs/observability.md).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation: Option<String>,
    pub browser: String,
    /// Version of the connected extension build.
    pub extension: String,
    pub sessions: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub project: String,
    pub tabs: usize,
    pub executor: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tab {
    pub target: String,
    /// Main-frame loader of the document Chrome reported when this reply was built.
    pub document: Option<String>,
    pub url: String,
    pub title: String,
}

/// A completed execution. `failure` reports the agent code's own outcome;
/// host refusals are a separate reply and never look like success.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Outcome {
    pub failure: Option<ScriptFailure>,
    pub output: String,
    pub truncated: bool,
    pub tabs: Vec<Tab>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScriptFailure {
    ScriptError,
    TargetClosed,
    BrowserDisconnected,
    /// The script outlived its deadline and was aborted: its later Playwright calls throw, and
    /// the session keeps its executor and state. An action already sent may still complete.
    Aborted,
}

impl ScriptFailure {
    pub fn code(self) -> &'static str {
        match self {
            Self::ScriptError => "script_error",
            Self::TargetClosed => "target_closed",
            Self::BrowserDisconnected => "browser_disconnected",
            Self::Aborted => "aborted",
        }
    }
}
