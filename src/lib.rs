//! Agent browser automation inside owner-granted Chrome tab groups (ADR 0015).
//!
//! The NDS extension attaches `chrome.debugger` only to tabs in NDS-managed
//! groups and reaches the host through Chrome native messaging. The host owns
//! sessions, bounds, the private control/CDP sockets and telemetry; each
//! session runs agent Playwright code in its own executor process. Pages,
//! DOM and results are untrusted data and never enter telemetry or Debug.

pub mod protocol;
pub mod view;
pub use protocol::OwnedSession;

#[cfg(any(unix, windows))]
pub mod activity;
#[cfg(any(unix, windows))]
mod adapter;
#[cfg(any(unix, windows))]
pub mod artifact;
#[cfg(any(unix, windows))]
pub mod device;
#[cfg(any(unix, windows))]
pub mod host;
#[cfg(any(unix, windows))]
pub mod install;
#[cfg(any(unix, windows))]
mod runtime;
#[cfg(any(unix, windows))]
mod socket;

#[cfg(any(unix, windows))]
pub use adapter::BrowserUseClient;
#[cfg(any(unix, windows))]
pub use nddev_device_sync_adapter_io::{CancellationToken, IoError, LocalIo, NativeIo};
#[cfg(any(unix, windows))]
use protocol::Document;
use protocol::Refusal;

/// Unpacked build: the ID follows the public key pinned in `packages/extension/manifest.json`.
pub const UNPACKED_EXTENSION_ID: &str = "lcdkocghcaakekcaeopjanfbohpfacbk";
/// The same extension published in the Chrome Web Store, which assigns its own key.
pub const STORE_EXTENSION_ID: &str = "lpnfnhkdjamhnoknoohhmjfhhjkeofio";
/// Every build the native host admits; Chrome enforces the same list.
pub const EXTENSION_IDS: [&str; 2] = [UNPACKED_EXTENSION_ID, STORE_EXTENSION_ID];

/// Chrome native messaging host name registered by `install`.
pub const NATIVE_HOST: &str = "ai.nddev.nds.browser_use";

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Error {
    #[cfg(any(unix, windows))]
    #[error(transparent)]
    Io(#[from] IoError),
    #[error(transparent)]
    Refused(Refusal),
    #[error("browser-use response is invalid")]
    InvalidResponse,
    #[error("browser-use is not supported on this platform")]
    UnsupportedPlatform,
}

impl From<Refusal> for Error {
    fn from(refusal: Refusal) -> Self {
        Self::Refused(refusal)
    }
}

/// Application port: agents depend on typed sessions and outcomes, not on a socket.
#[cfg(any(unix, windows))]
pub trait BrowserUse {
    /// Reserve before opening, retaining this handle even if opening is canceled.
    /// A lost reserve reply can leave only a bounded, unstarted reservation.
    fn create_owned(
        &self,
        project: &str,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<OwnedSession, Error>> + Send;
    fn open_owned(
        &self,
        session: &OwnedSession,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<view::Session, Error>> + Send;
    fn execute_owned(
        &self,
        session: &OwnedSession,
        code: &str,
        timeout: std::time::Duration,
        expect: Option<Document>,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<view::Outcome, Error>> + Send;
    /// Success acknowledges stop/reap and release for this exact generation.
    /// On a transport failure retain the handle and the unresolved drain state.
    fn close_owned(
        &self,
        session: &OwnedSession,
        close_tabs: bool,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<(), Error>> + Send;
    fn status(
        &self,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<view::Status, Error>> + Send;
    /// Opens or returns the project's session and its existing agent tab group.
    fn open(
        &self,
        project: &str,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<view::Session, Error>> + Send;
    fn sessions(
        &self,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<Vec<view::Session>, Error>> + Send;
    fn close(
        &self,
        project: &str,
        close_tabs: bool,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<(), Error>> + Send;
    /// Reloads an unpacked extension whose installed files are newer; returns
    /// whether a reload was requested.
    fn update(
        &self,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<bool, Error>> + Send;
    /// Runs Playwright code in the project's executor. `expect` refuses the run
    /// when that tab's document was replaced or the tab left the session.
    fn execute(
        &self,
        project: &str,
        code: &str,
        timeout: std::time::Duration,
        expect: Option<Document>,
        cancellation: CancellationToken,
    ) -> impl Future<Output = Result<view::Outcome, Error>> + Send;
}

/// Canonical compiled-in runtime manifest for this integration.
pub const MANIFEST: &str = include_str!("../contracts/module.json");

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    #[test]
    fn extension_id_matches_the_pinned_manifest_key() {
        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../packages/extension/manifest.json")).unwrap();
        let key = manifest["key"].as_str().unwrap();
        let der = decode_base64(key);
        let digest = Sha256::digest(&der);
        let id: String = digest[..16]
            .iter()
            .flat_map(|byte| [byte >> 4, byte & 0x0f])
            .map(|nibble| (b'a' + nibble) as char)
            .collect();
        assert_eq!(id, super::UNPACKED_EXTENSION_ID);
    }

    #[test]
    fn extension_ids_use_chromes_alphabet() {
        for id in super::EXTENSION_IDS {
            assert!(
                id.len() == 32 && id.bytes().all(|byte| (b'a'..=b'p').contains(&byte)),
                "{id}"
            );
        }
        assert_ne!(super::UNPACKED_EXTENSION_ID, super::STORE_EXTENSION_ID);
    }

    #[test]
    fn manifest_declares_the_browser_control_boundary() {
        let manifest: serde_json::Value = serde_json::from_str(super::MANIFEST).unwrap();
        assert_eq!(manifest["id"], "browser-use");
        assert_eq!(
            manifest["capabilities"],
            serde_json::json!(["control_browser"])
        );
        assert_eq!(
            manifest["permissions"],
            serde_json::json!(["browser_control"])
        );
    }

    fn decode_base64(text: &str) -> Vec<u8> {
        let value = |byte: u8| match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("invalid base64"),
        };
        let digits: Vec<u8> = text
            .bytes()
            .filter(|byte| *byte != b'=')
            .map(value)
            .collect();
        digits
            .chunks(4)
            .flat_map(|chunk| {
                let bits = chunk.iter().enumerate().fold(0u32, |bits, (index, digit)| {
                    bits | (u32::from(*digit) << (18 - 6 * index))
                });
                let bytes = [(bits >> 16) as u8, (bits >> 8) as u8, bits as u8];
                bytes.into_iter().take(chunk.len() - 1)
            })
            .collect()
    }
}
