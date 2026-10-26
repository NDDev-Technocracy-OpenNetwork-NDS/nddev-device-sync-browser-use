//! The private per-user runtime directory shared by the host and its clients.

use crate::IoError;
use std::{
    os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
};

/// `sun_path` holds 108 bytes on Linux and 104 on macOS; keep margin for the terminator.
const SOCKET_PATH_LIMIT: usize = 100;

pub(crate) fn directory() -> Result<PathBuf, IoError> {
    let path = match std::env::var_os("NDS_BROWSER_USE_RUNTIME_DIR") {
        Some(path) => PathBuf::from(path),
        None => user_runtime()?.join("nds-browser-use"),
    };
    if !path.is_absolute() {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(path)
}

/// The session's runtime directory on Linux.
#[cfg(not(target_os = "macos"))]
fn user_runtime() -> Result<PathBuf, IoError> {
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .ok_or(IoError::Unavailable)
}

/// macOS has no runtime directory; its per-user temporary directory is private to the user and
/// shared by Chrome and the user's shells through launchd.
#[cfg(target_os = "macos")]
fn user_runtime() -> Result<PathBuf, IoError> {
    Ok(std::env::temp_dir())
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

/// Creates or verifies a directory that only the current user can enter.
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

pub(crate) fn owner_only(path: &Path) -> Result<(), IoError> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|_| IoError::Unavailable)
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn symlinked_runtime_directory_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real");
        private_directory(&real).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert_eq!(private_directory(&link), Err(IoError::InvalidConfiguration));
    }

    #[test]
    fn socket_paths_fit_sun_path() {
        assert!(control_socket(Path::new("/run/user/1000/nds-browser-use")).is_ok());
        let long = PathBuf::from(format!("/{}", "x".repeat(95)));
        assert_eq!(cdp_socket(&long), Err(IoError::InvalidConfiguration));
    }
}
