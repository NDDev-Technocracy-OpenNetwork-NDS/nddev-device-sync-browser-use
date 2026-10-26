//! Custody port for agent WebAuthn credentials (ADR 0015, agent passkey custody).
//!
//! An agent credential is a separate credential the owner registers for one RP ID, origin and
//! project session; it is never an owner passkey. Agent composition implements this port with
//! the NDS Vault adapter. This crate keeps no credential at rest: the host holds a released
//! credential in zeroizing memory for one operation and imports it into a virtual authenticator
//! of the agent tab, so agent code, the executor, logs and telemetry never carry it.

use crate::protocol;
use zeroize::Zeroizing;

/// WebAuthn limits: credential IDs up to 1023 bytes, user handles up to 64 bytes.
const CREDENTIAL_ID_LIMIT: usize = 1023;
const USER_HANDLE_LIMIT: usize = 64;
/// A PKCS#8 private key of the supported algorithms fits well inside this bound.
const PRIVATE_KEY_LIMIT: usize = 4096;
const RP_ID_LIMIT: usize = 253;

/// The scope one agent credential belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Binding {
    rp_id: String,
    origin: String,
    project: String,
}

impl Binding {
    /// Accepts an `https` origin whose host is the RP ID or one of its subdomains, or
    /// `http://localhost` for the `localhost` RP ID, and a valid project session name.
    pub fn new(rp_id: &str, origin: &str, project: &str) -> Result<Self, CustodyError> {
        if !valid_rp_id(rp_id) || !protocol::valid_project(project) {
            return Err(CustodyError::Invalid);
        }
        let scheme = if rp_id == "localhost" {
            "http://"
        } else {
            "https://"
        };
        let host = origin
            .strip_prefix(scheme)
            .map(|rest| {
                rest.split_once(':').map_or(rest, |(host, port)| {
                    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
                        ""
                    } else {
                        host
                    }
                })
            })
            .ok_or(CustodyError::Invalid)?;
        let within = host == rp_id
            || host.strip_suffix(rp_id).is_some_and(|prefix| {
                prefix.ends_with('.') && valid_rp_id(&prefix[..prefix.len() - 1])
            });
        if !within {
            return Err(CustodyError::Invalid);
        }
        Ok(Self {
            rp_id: rp_id.to_owned(),
            origin: origin.to_owned(),
            project: project.to_owned(),
        })
    }

    pub fn rp_id(&self) -> &str {
        &self.rp_id
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn project(&self) -> &str {
        &self.project
    }
}

fn valid_rp_id(rp_id: &str) -> bool {
    (1..=RP_ID_LIMIT).contains(&rp_id.len())
        && rp_id.split('.').all(|label| {
            (1..=63).contains(&label.len())
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

/// One agent credential. It deliberately implements neither `Debug` nor serialization: it only
/// travels between custody and the host, and its private key is zeroized when dropped.
pub struct AgentCredential {
    credential_id: Vec<u8>,
    user_handle: Vec<u8>,
    private_key: Zeroizing<Vec<u8>>,
    sign_count: u32,
}

impl AgentCredential {
    /// `private_key` is the PKCS#8 key Chrome's virtual authenticator exports and imports.
    pub fn new(
        credential_id: Vec<u8>,
        user_handle: Vec<u8>,
        private_key: Zeroizing<Vec<u8>>,
        sign_count: u32,
    ) -> Result<Self, CustodyError> {
        let bounded = |bytes: &[u8], limit: usize| (1..=limit).contains(&bytes.len());
        if !bounded(&credential_id, CREDENTIAL_ID_LIMIT)
            || !bounded(&user_handle, USER_HANDLE_LIMIT)
            || !bounded(&private_key, PRIVATE_KEY_LIMIT)
        {
            return Err(CustodyError::Invalid);
        }
        Ok(Self {
            credential_id,
            user_handle,
            private_key,
            sign_count,
        })
    }

    pub fn credential_id(&self) -> &[u8] {
        &self.credential_id
    }

    pub fn user_handle(&self) -> &[u8] {
        &self.user_handle
    }

    pub fn private_key(&self) -> &[u8] {
        &self.private_key
    }

    pub fn sign_count(&self) -> u32 {
        self.sign_count
    }
}

/// Stable refusal vocabulary; also the telemetry `error.type` values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CustodyError {
    #[error("agent credentials need the owner's browser_control consent")]
    PermissionRequired,
    #[error("no agent credential is registered for this binding")]
    NotRegistered,
    #[error("an agent credential is already registered for this binding")]
    AlreadyRegistered,
    #[error("the agent credential custody is unavailable")]
    Unavailable,
    #[error("the agent credential or its binding is invalid")]
    Invalid,
}

impl CustodyError {
    pub fn code(self) -> &'static str {
        match self {
            Self::PermissionRequired => "permission_required",
            Self::NotRegistered => "not_registered",
            Self::AlreadyRegistered => "already_registered",
            Self::Unavailable => "unavailable",
            Self::Invalid => "invalid",
        }
    }
}

/// Application port for agent credential custody. Every call checks consent afresh; a
/// cancelled call leaves custody unchanged.
#[cfg(target_os = "linux")]
pub trait AgentCredentials {
    /// Stores a credential the owner registered for `binding`.
    fn register(
        &self,
        binding: &Binding,
        credential: AgentCredential,
        cancellation: crate::CancellationToken,
    ) -> impl Future<Output = Result<(), CustodyError>> + Send;
    /// Releases the bound credential for one host operation.
    fn release(
        &self,
        binding: &Binding,
        cancellation: crate::CancellationToken,
    ) -> impl Future<Output = Result<AgentCredential, CustodyError>> + Send;
    /// Records the authenticator's signature counter after a use; it never decreases.
    fn record_use(
        &self,
        binding: &Binding,
        sign_count: u32,
        cancellation: crate::CancellationToken,
    ) -> impl Future<Output = Result<(), CustodyError>> + Send;
    /// Deletes the record. The RP keeps trusting the public key until the owner removes it there.
    fn revoke(
        &self,
        binding: &Binding,
        cancellation: crate::CancellationToken,
    ) -> impl Future<Output = Result<(), CustodyError>> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_tie_an_origin_to_its_rp_id_and_a_project() {
        for (rp_id, origin) in [
            ("example.com", "https://example.com"),
            ("example.com", "https://login.example.com:8443"),
            ("localhost", "http://localhost:4173"),
        ] {
            assert!(Binding::new(rp_id, origin, "nds").is_ok(), "{origin}");
        }
        for (rp_id, origin, project) in [
            ("example.com", "http://example.com", "nds"),
            ("example.com", "https://evilexample.com", "nds"),
            ("example.com", "https://example.com/path", "nds"),
            ("example.com", "https://example.com:", "nds"),
            ("localhost", "https://localhost", "nds"),
            ("Example.com", "https://Example.com", "nds"),
            ("example.com", "https://example.com", "../x"),
            ("", "https://", "nds"),
        ] {
            assert_eq!(
                Binding::new(rp_id, origin, project),
                Err(CustodyError::Invalid),
                "{rp_id} {origin} {project}"
            );
        }
    }

    #[test]
    fn credentials_are_bounded_and_keep_their_key_private() {
        let key = || Zeroizing::new(vec![7u8; 138]);
        let credential = AgentCredential::new(vec![1; 16], vec![2; 16], key(), 1).unwrap();
        assert_eq!(
            (credential.private_key().len(), credential.sign_count()),
            (138, 1)
        );
        for (id, handle, private_key) in [
            (vec![], vec![2; 16], key()),
            (vec![1; 1024], vec![2; 16], key()),
            (vec![1; 16], vec![2; 65], key()),
            (vec![1; 16], vec![2; 16], Zeroizing::new(Vec::new())),
            (vec![1; 16], vec![2; 16], Zeroizing::new(vec![0; 4097])),
        ] {
            assert!(matches!(
                AgentCredential::new(id, handle, private_key, 0),
                Err(CustodyError::Invalid)
            ));
        }
    }

    #[test]
    fn refusal_codes_are_stable() {
        assert_eq!(
            CustodyError::PermissionRequired.code(),
            "permission_required"
        );
        assert_eq!(CustodyError::AlreadyRegistered.code(), "already_registered");
    }
}
