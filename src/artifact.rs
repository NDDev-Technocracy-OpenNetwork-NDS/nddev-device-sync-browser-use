//! A session's artifacts, read by its owner's CLI: screenshots, videos and files that agent code
//! wrote into the session area. Only regular files inside that area are listed or read; a path
//! that leaves it, or reaches through a symbolic link, is refused.

use crate::{IoError, protocol::valid_project, runtime};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// The largest artifact read in one call.
pub const READ_LIMIT: u64 = 256 * 1024 * 1024;
const LIST_LIMIT: usize = 1000;
const DEPTH_LIMIT: usize = 8;

#[derive(Serialize)]
pub struct Entry {
    pub path: String,
    pub bytes: u64,
}

fn area(project: &str) -> Result<PathBuf, IoError> {
    if !valid_project(project) {
        return Err(IoError::InvalidConfiguration);
    }
    Ok(runtime::sessions_directory()?.join(project))
}

/// Every regular file of the session area, with its path relative to the area.
pub fn list(project: &str) -> Result<Vec<Entry>, IoError> {
    let root = area(project)?;
    let mut entries = Vec::new();
    walk(&root, &root, 0, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

fn walk(root: &Path, dir: &Path, depth: usize, entries: &mut Vec<Entry>) -> Result<(), IoError> {
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && depth == 0 => return Ok(()),
        Err(_) => return Err(IoError::Unavailable),
    };
    for item in read {
        let item = item.map_err(|_| IoError::Unavailable)?;
        let kind = item.file_type().map_err(|_| IoError::Unavailable)?;
        let path = item.path();
        if kind.is_file() && entries.len() < LIST_LIMIT {
            let bytes = item.metadata().map_err(|_| IoError::Unavailable)?.len();
            let relative = path.strip_prefix(root).map_err(|_| IoError::Unavailable)?;
            entries.push(Entry {
                path: relative.to_string_lossy().replace('\\', "/"),
                bytes,
            });
        } else if kind.is_dir() && depth < DEPTH_LIMIT {
            walk(root, &path, depth + 1, entries)?;
        }
    }
    Ok(())
}

/// The bytes of one artifact, named relative to the session area.
pub fn read(project: &str, relative: &str) -> Result<Vec<u8>, IoError> {
    let root = area(project)?;
    let mut path = root.clone();
    let parts: Vec<Component> = Path::new(relative).components().collect();
    if parts.is_empty() || parts.len() > DEPTH_LIMIT + 1 {
        return Err(IoError::InvalidConfiguration);
    }
    for (index, part) in parts.iter().enumerate() {
        let Component::Normal(name) = part else {
            return Err(IoError::InvalidConfiguration);
        };
        path.push(name);
        // Every step is checked without following a link, so nothing outside the area is read.
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| IoError::Unavailable)?;
        let last = index + 1 == parts.len();
        let expected = if last {
            metadata.file_type().is_file()
        } else {
            metadata.file_type().is_dir()
        };
        if !expected {
            return Err(IoError::InvalidConfiguration);
        }
        if last && metadata.len() > READ_LIMIT {
            return Err(IoError::InvalidConfiguration);
        }
    }
    std::fs::read(&path).map_err(|_| IoError::Unavailable)
}
