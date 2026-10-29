//! The private per-user runtime directory shared by the host and its clients.

use crate::IoError;
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};

/// `sun_path` holds 108 bytes on Linux and Windows and 104 on macOS; keep margin for the
/// terminator.
const SOCKET_PATH_LIMIT: usize = 100;

/// The phone this process works with, once chosen (`--phone`): its host has its own runtime
/// directory beside the desktop host's.
static PHONE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Chooses the phone whose host this process serves or talks to; once, before any directory is
/// used.
pub fn choose_phone(serial: &str) -> Result<(), IoError> {
    if !crate::mobile::adb::valid_serial(serial) {
        return Err(IoError::InvalidConfiguration);
    }
    PHONE
        .set(serial.to_owned())
        .map_err(|_| IoError::InvalidConfiguration)
}

/// The root of this host's session areas: on disk under the user's state directory, not in the
/// runtime directory, which is a small memory-backed file system on Linux, so a large download,
/// recording or recorder capture neither fails nor holds memory. Each host (the desktop's, each
/// phone's, a test's own runtime directory) has its own root, named by its runtime directory,
/// because a starting host removes the areas a dead host left in its root.
pub(crate) fn sessions_directory() -> Result<PathBuf, IoError> {
    use sha2::{Digest, Sha256};
    let runtime = directory()?;
    let digest = Sha256::digest(runtime.as_os_str().as_encoded_bytes());
    let key: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(crate::install::state_dir()?.join("sessions").join(key))
}

pub(crate) fn directory() -> Result<PathBuf, IoError> {
    let path = match std::env::var_os("NDS_BROWSER_USE_RUNTIME_DIR") {
        Some(path) => PathBuf::from(path),
        None => user_runtime()?,
    };
    if !path.is_absolute() {
        return Err(IoError::InvalidConfiguration);
    }
    match PHONE.get() {
        Some(serial) => {
            // The phone's directory lies inside the desktop host's, which must exist first.
            private_directory(&path)?;
            Ok(path.join(format!("phone-{}", serial.replace(':', "_"))))
        }
        None => Ok(path),
    }
}

/// The session's runtime directory on Linux.
#[cfg(all(unix, not(target_os = "macos")))]
fn user_runtime() -> Result<PathBuf, IoError> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(|path| PathBuf::from(path).join("nds-browser-use"))
        .ok_or(IoError::Unavailable)
}

/// macOS has no runtime directory; its per-user temporary directory is private to the user and
/// shared by Chrome and the user's shells through launchd.
#[cfg(target_os = "macos")]
fn user_runtime() -> Result<PathBuf, IoError> {
    Ok(std::env::temp_dir().join("nds-browser-use"))
}

/// Windows keeps it in the user's local application data, beside the host configuration.
#[cfg(windows)]
fn user_runtime() -> Result<PathBuf, IoError> {
    Ok(local_app_data()?.join("nds-browser-use").join("runtime"))
}

/// The user's local application data, whose access list admits only the user, the system and
/// administrators; directories created inside inherit it.
#[cfg(windows)]
pub(crate) fn local_app_data() -> Result<PathBuf, IoError> {
    let path = PathBuf::from(std::env::var_os("LOCALAPPDATA").ok_or(IoError::Unavailable)?);
    if !path.is_absolute() {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(path)
}

/// The `ws+unix:` URL of a socket and a request path. The URL client splits the socket path at
/// its first `:`, so on Windows the socket path drops its drive and resolves against the
/// executor's working directory, which lies on the runtime directory's drive.
pub(crate) fn socket_url(socket: &Path, path: &str) -> String {
    #[cfg(windows)]
    let socket = socket
        .components()
        .filter_map(|component| match component {
            std::path::Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .fold(String::new(), |url, part| format!("{url}/{part}"));
    #[cfg(unix)]
    let socket = socket.display();
    format!("ws+unix://{socket}:{path}")
}

pub(crate) fn control_socket(directory: &Path) -> Result<PathBuf, IoError> {
    socket(directory, "control.sock")
}

pub(crate) fn cdp_socket(directory: &Path) -> Result<PathBuf, IoError> {
    socket(directory, "cdp.sock")
}

fn socket(directory: &Path, name: &str) -> Result<PathBuf, IoError> {
    let path = directory.join(name);
    if path.as_os_str().len() > SOCKET_PATH_LIMIT {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(path)
}

/// Creates a private directory together with the missing directories above it, each of those only
/// the user can enter, then verifies it as [`private_directory`] does.
pub(crate) fn private_tree(path: &Path) -> Result<(), IoError> {
    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)
            .map_err(|_| IoError::Unavailable)?;
    }
    private_directory(path)
}

/// Creates or verifies a directory that only the current user can enter.
#[cfg(unix)]
pub(crate) fn private_directory(path: &Path) -> Result<(), IoError> {
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(_) => return Err(IoError::Unavailable),
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|_| IoError::Unavailable)?;
    if !metadata.is_dir()
        || metadata.uid() != rustix::process::getuid().as_raw()
        || metadata.permissions().mode() & 0o077 != 0
    {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(())
}

/// Creates or verifies a directory inside the user's local application data, so that it
/// inherits the access list that admits only the user, the system and administrators. A link
/// or a directory elsewhere is refused.
#[cfg(windows)]
pub(crate) fn private_directory(path: &Path) -> Result<(), IoError> {
    std::fs::create_dir_all(path).map_err(|_| IoError::Unavailable)?;
    let metadata = std::fs::symlink_metadata(path).map_err(|_| IoError::Unavailable)?;
    let base = std::fs::canonicalize(local_app_data()?).map_err(|_| IoError::Unavailable)?;
    let real = std::fs::canonicalize(path).map_err(|_| IoError::Unavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || !real.starts_with(&base) {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(())
}

#[cfg(unix)]
pub(crate) fn owner_only(path: &Path) -> Result<(), IoError> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| IoError::Unavailable)
}

/// A socket file inherits the access list of its private directory.
#[cfg(windows)]
pub(crate) fn owner_only(_path: &Path) -> Result<(), IoError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn private_directory_rejects_shared_permissions() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("runtime");
        private_directory(&path).unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(private_directory(&path), Err(IoError::InvalidConfiguration));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_runtime_directory_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        private_directory(&real).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(private_directory(&link), Err(IoError::InvalidConfiguration));
    }

    #[cfg(unix)]
    #[test]
    fn socket_urls_carry_the_socket_path() {
        assert_eq!(
            socket_url(
                Path::new("/run/user/1000/nds-browser-use/cdp.sock"),
                "/session/t"
            ),
            "ws+unix:///run/user/1000/nds-browser-use/cdp.sock:/session/t"
        );
    }

    #[cfg(windows)]
    #[test]
    fn socket_urls_drop_the_drive() {
        assert_eq!(
            socket_url(
                Path::new(r"C:\Users\agent\AppData\Local\nds-browser-use\runtime\cdp.sock"),
                "/session/t"
            ),
            "ws+unix:///Users/agent/AppData/Local/nds-browser-use/runtime/cdp.sock:/session/t"
        );
    }

    #[cfg(windows)]
    #[test]
    fn private_directory_stays_inside_local_app_data() {
        // The temporary directory lies in the user's local application data.
        let root = tempfile::tempdir().unwrap();
        private_directory(&root.path().join("runtime")).unwrap();
        let outside = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("outside-runtime");
        assert_eq!(
            private_directory(&outside),
            Err(IoError::InvalidConfiguration)
        );
    }

    #[test]
    fn socket_paths_fit_sun_path() {
        assert!(control_socket(Path::new("/run/user/1000/nds-browser-use")).is_ok());
        let long = PathBuf::from(format!("/{}", "x".repeat(95)));
        assert_eq!(cdp_socket(&long), Err(IoError::InvalidConfiguration));
    }
}
