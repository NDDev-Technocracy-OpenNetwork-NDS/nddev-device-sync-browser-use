//! Local registration of the native messaging host for one Chrome profile root.
//!
//! Installing writes two owner-only files, Chrome's host manifest and the host's executor
//! configuration, and on Windows the user's registry value that names the manifest. Loading
//! the unpacked extension into a browser remains the owner's explicit action.

use crate::{EXTENSION_IDS, IoError, NATIVE_HOST, host::Config, runtime};
use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    io::Write,
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

    /// The browser's default user data directory, relative to the platform's base.
    #[cfg(all(unix, not(target_os = "macos")))]
    fn profile_root(self) -> &'static str {
        match self {
            Self::Chrome => "google-chrome",
            Self::ChromeBeta => "google-chrome-beta",
            Self::ChromeForTesting => "google-chrome-for-testing",
            Self::Chromium => "chromium",
        }
    }

    #[cfg(target_os = "macos")]
    fn profile_root(self) -> &'static str {
        match self {
            Self::Chrome => "Google/Chrome",
            Self::ChromeBeta => "Google/Chrome Beta",
            Self::ChromeForTesting => "Google/Chrome for Testing",
            Self::Chromium => "Chromium",
        }
    }

    /// The user registry key under which the browser looks up native messaging hosts on
    /// Windows: the product's registry path, as each product has its own user data directory
    /// on the other platforms.
    #[cfg(windows)]
    fn registry_key(self) -> String {
        let product = match self {
            Self::Chrome => r"Google\Chrome",
            Self::ChromeBeta => r"Google\Chrome Beta",
            Self::ChromeForTesting => r"Google\Chrome for Testing",
            Self::Chromium => "Chromium",
        };
        format!(r"Software\{product}\NativeMessagingHosts\{NATIVE_HOST}")
    }
}

/// Where Chrome looks up user-level hosts: `<user data dir>/NativeMessagingHosts`.
#[cfg(unix)]
pub fn host_directory(browser: Browser) -> Result<PathBuf, IoError> {
    Ok(user_data_base()?
        .join(browser.profile_root())
        .join("NativeMessagingHosts"))
}

/// Windows browsers find the manifest through the registry, so one manifest beside the host
/// configuration serves every browser.
#[cfg(windows)]
pub fn host_directory(_browser: Browser) -> Result<PathBuf, IoError> {
    Ok(config_home()?.join("nds-browser-use"))
}

/// Points the browser's registry value at the installed manifest.
#[cfg(windows)]
pub fn register(browser: Browser, manifest: &Path) -> Result<(), IoError> {
    let manifest = manifest.to_str().ok_or(IoError::InvalidConfiguration)?;
    windows_registry::CURRENT_USER
        .create(browser.registry_key())
        .and_then(|key| key.set_string("", manifest))
        .map_err(|_| IoError::Unavailable)
}

/// Linux keeps browser user data under the XDG configuration home.
#[cfg(all(unix, not(target_os = "macos")))]
fn user_data_base() -> Result<PathBuf, IoError> {
    config_home()
}

/// macOS keeps browser user data under `~/Library/Application Support`.
#[cfg(target_os = "macos")]
fn user_data_base() -> Result<PathBuf, IoError> {
    let home = PathBuf::from(std::env::var_os("HOME").ok_or(IoError::Unavailable)?);
    if !home.is_absolute() {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(home.join("Library").join("Application Support"))
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
    allowed_origins: Vec<String>,
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
        allowed_origins: origins(),
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

fn origins() -> Vec<String> {
    EXTENSION_IDS
        .iter()
        .map(|id| format!("chrome-extension://{id}/"))
        .collect()
}

/// Windows keeps the configuration in the user's local application data.
#[cfg(windows)]
fn config_home() -> Result<PathBuf, IoError> {
    runtime::local_app_data()
}

#[cfg(unix)]
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
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    // On Windows the file inherits the private directory's access list.
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary).map_err(|_| IoError::Unavailable)?;
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
    fn host_manifest_admits_only_the_nds_extension_builds() {
        let manifest = HostManifest {
            name: NATIVE_HOST,
            description: "",
            path: Path::new("/opt/nds/nds-browser-use"),
            r#type: "stdio",
            allowed_origins: origins(),
        };
        let value = serde_json::to_value(&manifest).unwrap();
        assert_eq!(value["type"], "stdio");
        assert_eq!(
            value["allowed_origins"],
            serde_json::json!([
                "chrome-extension://lcdkocghcaakekcaeopjanfbohpfacbk/",
                "chrome-extension://lpnfnhkdjamhnoknoohhmjfhhjkeofio/"
            ])
        );
        assert!(
            NATIVE_HOST
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte == b'.' || byte == b'_')
        );
    }

    #[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn browsers_map_to_their_profile_roots() {
        let expected = if cfg!(target_os = "macos") {
            "Google/Chrome Beta"
        } else {
            "google-chrome-beta"
        };
        assert_eq!(
            Browser::parse("chrome-beta").map(Browser::profile_root),
            Some(expected)
        );
        assert_eq!(Browser::parse("firefox"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_hosts_live_under_application_support() {
        let directory = host_directory(Browser::Chrome).unwrap();
        assert!(
            directory.ends_with("Library/Application Support/Google/Chrome/NativeMessagingHosts"),
            "{directory:?}"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_browsers_name_their_registry_keys() {
        assert_eq!(
            Browser::ChromeForTesting.registry_key(),
            r"Software\Google\Chrome for Testing\NativeMessagingHosts\ai.nddev.nds.browser_use"
        );
        assert_eq!(
            Browser::Chromium.registry_key(),
            r"Software\Chromium\NativeMessagingHosts\ai.nddev.nds.browser_use"
        );
        assert!(
            host_directory(Browser::Chrome)
                .unwrap()
                .starts_with(runtime::local_app_data().unwrap())
        );
    }
}
