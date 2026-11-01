use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    process,
    sync::{
        Mutex, PoisonError,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

const RENAME_RETRIES: u32 = 5;
const RENAME_RETRY_DELAY: Duration = Duration::from_millis(20);

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub revision: u64,
    pub state: Option<Value>,
}

pub fn validate_file_name(name: &str) -> Result<()> {
    let valid = name.strip_suffix(".json").is_some_and(|stem| {
        let plain = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit();
        stem.starts_with(plain)
            && stem
                .chars()
                .all(|c| plain(c) || matches!(c, '.' | '_' | '-'))
    });
    if valid {
        Ok(())
    } else {
        Err(Error::InvalidFileName(name.to_owned()))
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn sibling(path: &Path, name: String) -> PathBuf {
    path.with_file_name(name)
}

fn unix_ms(now: SystemTime) -> u128 {
    now.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default()
}

pub fn read_state(path: &Path) -> Result<Option<Value>> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(Error::io(path)(error)),
    };
    serde_json::from_slice(&bytes).map(Some).or_else(|source| {
        let backup = sibling(
            path,
            format!("{}.corrupt-{}", file_name(path), unix_ms(SystemTime::now())),
        );
        fs::rename(path, &backup).map_err(Error::io(path))?;
        Err(Error::Corrupt { backup, source })
    })
}

fn temp_prefix(name: &str) -> String {
    format!(".{name}.tmp-")
}

fn write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

fn rename_with_retry(from: &Path, to: &Path) -> io::Result<()> {
    let mut retries = 0;
    loop {
        match fs::rename(from, to) {
            Err(error)
                if error.kind() == io::ErrorKind::PermissionDenied && retries < RENAME_RETRIES =>
            {
                retries += 1;
                thread::sleep(RENAME_RETRY_DELAY);
            }
            result => return result,
        }
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) {
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) {}

pub fn write_atomic(path: &Path, value: &Value) -> Result<()> {
    let mut bytes = serde_json::to_vec_pretty(value).map_err(Error::Encode)?;
    bytes.push(b'\n');
    let dir = path.parent().unwrap_or(Path::new("."));
    fs::create_dir_all(dir).map_err(Error::io(dir))?;
    let temp = sibling(
        path,
        format!(
            "{}{}-{}",
            temp_prefix(&file_name(path)),
            process::id(),
            TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ),
    );
    if let Err(error) = write_file(&temp, &bytes) {
        let _ = fs::remove_file(&temp);
        return Err(Error::io(temp)(error));
    }
    if let Err(error) = rename_with_retry(&temp, path) {
        let _ = fs::remove_file(&temp);
        return Err(Error::io(path)(error));
    }
    sync_dir(dir);
    Ok(())
}

pub fn sweep_temp_files(dir: &Path, name: &str) {
    let prefix = temp_prefix(name);
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
        .for_each(|entry| {
            let _ = fs::remove_file(entry.path());
        });
}

pub struct StateStore {
    dir: PathBuf,
    revisions: Mutex<HashMap<String, u64>>,
}

impl StateStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            revisions: Mutex::new(HashMap::new()),
        }
    }

    fn with_revision<T>(&self, file: &str, body: impl FnOnce(&mut u64) -> Result<T>) -> Result<T> {
        validate_file_name(file)?;
        let mut revisions = self
            .revisions
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if !revisions.contains_key(file) {
            sweep_temp_files(&self.dir, file);
        }
        body(revisions.entry(file.to_owned()).or_insert(0))
    }

    pub fn load(&self, file: &str) -> Result<StateSnapshot> {
        self.with_revision(file, |revision| {
            Ok(StateSnapshot {
                revision: *revision,
                state: read_state(&self.dir.join(file))?,
            })
        })
    }

    // `announce` runs under the lock, so announcements reach listeners in revision order.
    pub fn save(&self, file: &str, state: &Value, announce: impl FnOnce(u64)) -> Result<u64> {
        self.with_revision(file, |revision| {
            write_atomic(&self.dir.join(file), state)?;
            *revision += 1;
            announce(*revision);
            Ok(*revision)
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn dir_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn accepts_plain_json_names() {
        ["shortcuts.json", "a.b-c_d.json", "9.json"]
            .iter()
            .for_each(|name| assert!(validate_file_name(name).is_ok(), "{name}"));
    }

    #[test]
    fn rejects_paths_hidden_files_other_extensions_and_uppercase() {
        [
            "../x.json",
            "a/b.json",
            "a\\b.json",
            ".hidden.json",
            "x.txt",
            ".json",
            "",
            "Shortcuts.json",
            "shortcuts.JSON",
            "a-B.json",
        ]
        .iter()
        .for_each(|name| {
            assert!(
                matches!(validate_file_name(name), Err(Error::InvalidFileName(n)) if n == *name),
                "{name}"
            )
        });
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("shortcuts.json");
        let value = json!({ "overrides": { "editor": { "save": ["ctrl+s"] } } });
        write_atomic(&path, &value).unwrap();
        assert_eq!(read_state(&path).unwrap(), Some(value));
    }

    #[test]
    fn writes_pretty_json_with_trailing_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shortcuts.json");
        write_atomic(&path, &json!({ "a": 1 })).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\n  \"a\": 1\n}\n");
    }

    #[test]
    fn overwrite_replaces_the_file_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shortcuts.json");
        write_atomic(&path, &json!({ "a": 1 })).unwrap();
        write_atomic(&path, &json!({ "b": 2 })).unwrap();
        assert_eq!(read_state(&path).unwrap(), Some(json!({ "b": 2 })));
        assert_eq!(dir_names(dir.path()), ["shortcuts.json"]);
    }

    #[test]
    fn first_access_sweeps_stale_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(".shortcuts.json.tmp-1-0"), "{").unwrap();
        fs::write(dir.path().join(".other.json.tmp-1-0"), "{").unwrap();
        let store = StateStore::new(dir.path().to_owned());
        store.load("shortcuts.json").unwrap();
        assert_eq!(dir_names(dir.path()), [".other.json.tmp-1-0"]);
    }

    #[test]
    fn reading_a_missing_file_gives_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(read_state(&dir.path().join("missing.json")).unwrap(), None);
    }

    #[test]
    fn unparseable_file_is_moved_to_a_corrupt_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("shortcuts.json");
        fs::write(&path, "{nope").unwrap();
        let Err(error) = read_state(&path) else {
            panic!("expected an error");
        };
        let Error::Corrupt { backup, .. } = &error else {
            panic!("expected Corrupt, got {error}");
        };
        let backup_name = file_name(backup);
        assert!(
            backup_name.starts_with("shortcuts.json.corrupt-"),
            "{backup_name}"
        );
        assert!(error.to_string().contains(&backup_name), "{error}");
        assert_eq!(fs::read_to_string(backup).unwrap(), "{nope");
        assert_eq!(dir_names(dir.path()), [backup_name]);
    }

    #[test]
    fn revisions_start_at_zero_and_rise_by_one_per_write() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path().to_owned());
        let mut announced = Vec::new();
        let mut announce = |r| {
            assert!(matches!(
                store.revisions.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            ));
            announced.push(r);
        };
        assert_eq!(store.load("shortcuts.json").unwrap().revision, 0);
        let first = store
            .save("shortcuts.json", &json!({ "a": 1 }), &mut announce)
            .unwrap();
        let second = store
            .save("shortcuts.json", &json!({ "a": 2 }), &mut announce)
            .unwrap();
        assert_eq!((first, second), (1, 2));
        assert_eq!(announced, [1, 2]);
        assert_eq!(
            store.load("shortcuts.json").unwrap(),
            StateSnapshot {
                revision: 2,
                state: Some(json!({ "a": 2 }))
            }
        );
        assert_eq!(store.load("other.json").unwrap().revision, 0);
    }

    #[test]
    fn store_rejects_invalid_names_before_touching_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = StateStore::new(dir.path().join("state"));
        assert!(matches!(
            store.save("../x.json", &json!({}), |_| {}),
            Err(Error::InvalidFileName(_))
        ));
        assert_eq!(dir_names(dir.path()), Vec::<String>::new());
    }
}
