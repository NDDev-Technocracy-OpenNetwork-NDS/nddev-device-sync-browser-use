//! Local registration of the native messaging host for one Chrome profile root.
//!
//! Installing writes two owner-only files and nothing else: Chrome's host
//! manifest and the host's executor configuration. Loading the unpacked
//! extension into a browser remains the owner's explicit action.

use crate::{EXTENSION_ID, IoError, NATIVE_HOST, host::Config, runtime};
use serde::{Deserialize, Serialize};
use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Browser {
    Chrome,
    ChromeBeta,
    ChromeForTesting,
    Chromium,
}

impl Browser {
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "chrome" => Some(Self::Chrome),
            "chrome-beta" => Some(Self::ChromeBeta),
            "chrome-for-testing" => Some(Self::ChromeForTesting),
            "chromium" => Some(Self::Chromium),
            _ => None,
        }
    }

    fn profile_root(self) -> &'static str {
        match self {
            Self::Chrome => "google-chrome",
            Self::ChromeBeta => "google-chrome-beta",
            Self::ChromeForTesting => "google-chrome-for-testing",
            Self::Chromium => "chromium",
        }
    }
}

/// Where Chrome looks up user-level hosts: `<user data dir>/NativeMessagingHosts`.
pub fn host_directory(browser: Browser) -> Result<PathBuf, IoError> {
    Ok(config_home()?
        .join(browser.profile_root())
        .join("NativeMessagingHosts"))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct HostConfig {
    bun: PathBuf,
    executor: PathBuf,
}

#[derive(Serialize)]
struct HostManifest<'a> {
    name: &'a str,
    description: &'a str,
    path: &'a Path,
    r#type: &'a str,
    allowed_origins: [String; 1],
}

pub struct Installation {
    pub manifest: PathBuf,
    pub config: PathBuf,
}

pub fn install(
    host: &Path,
    directory: &Path,
    bun: &Path,
    executor: &Path,
) -> Result<Installation, IoError> {
    for path in [host, directory, bun, executor] {
        if !path.is_absolute() {
            return Err(IoError::InvalidConfiguration);
        }
    }
    if !host.is_file() || !bun.is_file() || !executor.is_file() {
        return Err(IoError::Unavailable);
    }
    let manifest = HostManifest {
        name: NATIVE_HOST,
        description: "NDDev OpenNetwork NDS browser-use host",
        path: host,
        r#type: "stdio",
        allowed_origins: [format!("chrome-extension://{EXTENSION_ID}/")],
    };
    let config_path = config_path()?;
    let parent = config_path.parent().ok_or(IoError::InvalidConfiguration)?;
    std::fs::create_dir_all(config_home()?).map_err(|_| IoError::Unavailable)?;
    runtime::private_directory(parent)?;
    write_private(
        &config_path,
        &serde_json::to_vec_pretty(&HostConfig {
            bun: bun.into(),
            executor: executor.into(),
        })
        .map_err(|_| IoError::InvalidConfiguration)?,
    )?;
    std::fs::create_dir_all(directory).map_err(|_| IoError::Unavailable)?;
    let manifest_path = directory.join(format!("{NATIVE_HOST}.json"));
    write_private(
        &manifest_path,
        &serde_json::to_vec_pretty(&manifest).map_err(|_| IoError::InvalidConfiguration)?,
    )?;
    Ok(Installation {
        manifest: manifest_path,
        config: config_path,
    })
}

pub fn load() -> Result<Config, IoError> {
    let bytes = std::fs::read(config_path()?).map_err(|_| IoError::Unavailable)?;
    let config: HostConfig =
        serde_json::from_slice(&bytes).map_err(|_| IoError::InvalidConfiguration)?;
    Ok(Config {
        runtime: runtime::directory()?,
        bun: config.bun,
        executor: config.executor,
    })
}

fn config_home() -> Result<PathBuf, IoError> {
    let path = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(path) => PathBuf::from(path),
        None => {
            PathBuf::from(std::env::var_os("HOME").ok_or(IoError::Unavailable)?).join(".config")
        }
    };
    if !path.is_absolute() {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(path)
}

fn config_path() -> Result<PathBuf, IoError> {
    Ok(config_home()?.join("nds-browser-use").join("host.json"))
}

/// Atomic owner-only replacement.
fn write_private(path: &Path, bytes: &[u8]) -> Result<(), IoError> {
    let temporary = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(|_| IoError::Unavailable)?;
    file.write_all(bytes)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.sync_all())
        .map_err(|_| IoError::Unavailable)?;
    std::fs::rename(&temporary, path).map_err(|_| IoError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_manifest_admits_only_the_pinned_extension() {
        let manifest = HostManifest {
            name: NATIVE_HOST,
            description: "",
            path: Path::new("/opt/nds/nds-browser-use"),
            r#type: "stdio",
            allowed_origins: [format!("chrome-extension://{EXTENSION_ID}/")],
        };
        let value = serde_json::to_value(&manifest).unwrap();
        assert_eq!(value["type"], "stdio");
        assert_eq!(
            value["allowed_origins"],
            serde_json::json!([format!("chrome-extension://{EXTENSION_ID}/")])
        );
        assert!(
            NATIVE_HOST
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'.' || byte == b'_')
        );
    }

    #[test]
    fn written_files_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("host.json");
        write_private(&path, b"{}").unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(std::fs::read(&path).unwrap(), b"{}\n");
    }

    #[test]
    fn browsers_map_to_their_profile_roots() {
        assert_eq!(
            Browser::parse("chrome-beta").map(Browser::profile_root),
            Some("google-chrome-beta")
        );
        assert_eq!(Browser::parse("firefox"), None);
    }
}
