use std::{fmt, io, path::PathBuf};

use serde::{Serialize, Serializer};

#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    InvalidFileName(String),
    Io {
        path: PathBuf,
        source: io::Error,
    },
    Corrupt {
        backup: PathBuf,
        source: serde_json::Error,
    },
    Encode(serde_json::Error),
    Tauri(tauri::Error),
    GlobalShortcutMissing,
}

impl Error {
    pub(crate) fn io(path: impl Into<PathBuf>) -> impl FnOnce(io::Error) -> Self {
        let path = path.into();
        move |source| Self::Io { path, source }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFileName(name) => write!(
                f,
                "invalid state file name {name:?}: expected lowercase letters, digits, '.', '_' or '-' ending in .json"
            ),
            Self::Io { path, source } => write!(f, "{}: {source}", path.display()),
            Self::Corrupt { backup, source } => write!(
                f,
                "unparseable state file moved to {}: {source}",
                backup.display()
            ),
            Self::Encode(source) => write!(f, "cannot encode state: {source}"),
            Self::Tauri(source) => write!(f, "{source}"),
            Self::GlobalShortcutMissing => {
                write!(f, "tauri-plugin-global-shortcut is not registered")
            }
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidFileName(_) | Self::GlobalShortcutMissing => None,
            Self::Io { source, .. } => Some(source),
            Self::Corrupt { source, .. } | Self::Encode(source) => Some(source),
            Self::Tauri(source) => Some(source),
        }
    }
}

impl From<tauri::Error> for Error {
    fn from(error: tauri::Error) -> Self {
        Self::Tauri(error)
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;
