//! One codeg process per data dir.
//!
//! Every codeg process claims its data dir before it writes there: the desktop
//! app and `codeg-server` before their file logger (the first thing that
//! writes), and [`crate::db::init_database`] before the pending restore, the
//! migrations and the startup sweeps — the one that marks running turns as cut
//! off and queues them for the automatic resume, and the cleanup. A process
//! that finds the dir taken leaves it exactly as it found it and exits.
//!
//! The claim is an exclusive advisory lock on `<database file>.lock`: the file
//! the automation engine has always locked before its boot reconcile, now taken
//! once at startup and held for the life of the process. The OS drops it
//! however the process ends. Because it is named after the database file, it
//! contends exactly when two processes would share a database: a debug desktop
//! build keeps its own `codeg-dev.db` (and lock) beside a release `codeg.db`.
//!
//! `std`'s file lock is `flock` on Unix and `LockFileEx` on Windows. Both count
//! two opens of the file as two holders, even inside one process, so this
//! module keeps a single handle per dir and answers a repeat claim from it
//! rather than locking again.

use std::fs::{File, OpenOptions, TryLockError};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long a starting process waits for its data dir's owner to exit before
/// giving up. A restart can start the next process before the last one is gone
/// (Tauri's relaunch, the Windows server's re-spawn after an upgrade), and a
/// process holds its lock until it has exited.
pub const HANDOFF_GRACE: Duration = Duration::from_secs(5);

/// Exit status of a process that found its data dir in use: `EX_TEMPFAIL`, as
/// it may start once the owner is gone. The `--supervise` supervisor does not
/// count it against a freshly upgraded version.
pub const EXIT_IN_USE: u8 = 75;

const RETRY_INTERVAL: Duration = Duration::from_millis(50);

/// The data dirs this process owns, each with the open handle holding its lock.
static OWNED: Mutex<Vec<Owned>> = Mutex::new(Vec::new());

struct Owned {
    /// Canonical, so two spellings of one dir are one entry.
    dir: PathBuf,
    _lock: File,
}

#[derive(Debug)]
pub enum ClaimError {
    /// Another live process owns the data dir.
    InUse {
        data_dir: PathBuf,
        /// The owner's pid, when its lock file could be read.
        holder_pid: Option<u32>,
    },
    /// No lock could be taken at all: an IO error, such as a filesystem without
    /// lock support. Not contention.
    Unavailable {
        data_dir: PathBuf,
        error: std::io::Error,
    },
}

impl std::fmt::Display for ClaimError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InUse {
                data_dir,
                holder_pid: Some(pid),
            } => write!(
                f,
                "the data directory {} is in use by another codeg process (pid {pid})",
                data_dir.display()
            ),
            Self::InUse {
                data_dir,
                holder_pid: None,
            } => write!(
                f,
                "the data directory {} is in use by another codeg process",
                data_dir.display()
            ),
            Self::Unavailable { data_dir, error } => write!(
                f,
                "could not lock the data directory {}: {error}",
                data_dir.display()
            ),
        }
    }
}

impl std::error::Error for ClaimError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InUse { .. } => None,
            Self::Unavailable { error, .. } => Some(error),
        }
    }
}

/// The owner lock file of `data_dir`.
pub fn lock_path(data_dir: &Path) -> PathBuf {
    data_dir.join(format!("{}.lock", crate::db::database_file_name()))
}

/// Claim `data_dir` for this process, creating it if needed, or confirm that
/// this process already owns it. Never waits; see [`claim_with_grace`].
pub fn claim(data_dir: &Path) -> Result<(), ClaimError> {
    let unavailable = |error| ClaimError::Unavailable {
        data_dir: data_dir.to_path_buf(),
        error,
    };
    std::fs::create_dir_all(data_dir).map_err(unavailable)?;
    let dir = std::fs::canonicalize(data_dir).map_err(unavailable)?;
    let mut owned = OWNED.lock().unwrap_or_else(PoisonError::into_inner);
    if owned.iter().any(|o| o.dir == dir) {
        return Ok(());
    }
    // A lock handle first; the text in it is only the owner's pid, for the
    // message a refused process prints.
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path(&dir))
        .map_err(unavailable)?;
    match file.try_lock() {
        Ok(()) => {
            record_pid(&mut file);
            owned.push(Owned { dir, _lock: file });
            Ok(())
        }
        Err(TryLockError::WouldBlock) => Err(ClaimError::InUse {
            data_dir: data_dir.to_path_buf(),
            holder_pid: read_pid(&mut file),
        }),
        Err(TryLockError::Error(error)) => Err(unavailable(error)),
    }
}

/// [`claim`], retried for up to `grace` while another process owns the dir, so
/// an owner on its way out can finish exiting first.
pub fn claim_with_grace(data_dir: &Path, grace: Duration) -> Result<(), ClaimError> {
    let deadline = Instant::now() + grace;
    loop {
        match claim(data_dir) {
            Err(ClaimError::InUse { .. }) if Instant::now() < deadline => {
                std::thread::sleep(RETRY_INTERVAL);
            }
            result => return result,
        }
    }
}

/// Best effort: the lock keeps other processes out, not this text.
fn record_pid(file: &mut File) {
    let _ = file.set_len(0);
    let _ = file.write_all(format!("{}\n", std::process::id()).as_bytes());
}

/// The pid an owner recorded. `None` for an owner from before pids were
/// recorded, and on Windows, where the owner's lock also blocks reads.
fn read_pid(file: &mut File) -> Option<u32> {
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    text.trim().parse().ok()
}

/// Lock `dir`'s owner file through a handle of its own, as another process
/// holding the dir would; see the module docs for why that works inside one
/// process. Creates `dir` if needed.
#[cfg(test)]
pub(crate) fn hold_as_other_process(dir: &Path) -> File {
    std::fs::create_dir_all(dir).expect("create data dir");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path(dir))
        .expect("open lock file");
    // Tests run in parallel, and a sibling test that spawns a subprocess
    // duplicates every open handle into it until its `exec`, so a lock that was
    // just released can stay held for a moment. Retry until that clears.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match file.try_lock() {
            Ok(()) => return file,
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(e) => panic!("could not lock {}: {e:?}", lock_path(dir).display()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claim_creates_the_dir_takes_the_lock_once_and_records_the_pid() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let dir = tmp.path().join("data");

        claim(&dir).expect("first claim");
        assert!(dir.is_dir(), "claiming creates the data dir");
        claim(&dir).expect("the owner claiming again is a no-op");

        // Windows also blocks reads of a locked file from other handles.
        if cfg!(unix) {
            let recorded = std::fs::read_to_string(lock_path(&dir)).expect("read lock file");
            assert_eq!(recorded.trim(), std::process::id().to_string());
        }
        // Held for real: any other handle is refused.
        let other = OpenOptions::new()
            .write(true)
            .open(lock_path(&dir))
            .expect("open lock file");
        assert!(matches!(other.try_lock(), Err(TryLockError::WouldBlock)));
    }

    #[test]
    fn claim_refuses_a_dir_another_process_owns_and_names_it() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let mut other = hold_as_other_process(tmp.path());
        other.write_all(b"4242\n").expect("record the other pid");

        let err = claim(tmp.path()).expect_err("the dir is taken");
        match &err {
            ClaimError::InUse {
                data_dir,
                holder_pid,
            } => {
                assert_eq!(data_dir.as_path(), tmp.path());
                if cfg!(unix) {
                    assert_eq!(*holder_pid, Some(4242));
                }
            }
            unexpected => panic!("expected InUse, got {unexpected:?}"),
        }
        let message = err.to_string();
        assert!(
            message.contains(&tmp.path().display().to_string()),
            "the message names the data dir: {message}"
        );
        // A different dir is independent.
        let elsewhere = tempfile::tempdir().expect("temp dir");
        claim(elsewhere.path()).expect("an unrelated dir is free");
    }

    #[test]
    fn claim_with_grace_waits_for_an_owner_on_its_way_out() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let other = hold_as_other_process(tmp.path());
        let exiting = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            drop(other);
        });
        let started = Instant::now();

        claim_with_grace(tmp.path(), Duration::from_secs(10)).expect("claimed once it let go");
        assert!(started.elapsed() >= Duration::from_millis(250));
        exiting.join().expect("join");
    }

    #[test]
    fn claim_with_grace_gives_up_on_an_owner_that_stays() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let _other = hold_as_other_process(tmp.path());
        let started = Instant::now();

        let err = claim_with_grace(tmp.path(), Duration::from_millis(200)).expect_err("taken");
        assert!(matches!(err, ClaimError::InUse { .. }), "{err:?}");
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[test]
    fn claim_is_unavailable_where_the_dir_cannot_exist() {
        let file = tempfile::NamedTempFile::new().expect("temp file");
        let err = claim(&file.path().join("data")).expect_err("no dir under a file");
        assert!(matches!(err, ClaimError::Unavailable { .. }), "{err:?}");
    }
}
