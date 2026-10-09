//! The process's open-file limit.
//!
//! macOS starts every app launched from Finder or the Dock at a soft limit of
//! 256 descriptors (`launchctl limit maxfiles`), and many Linux setups start at
//! 1024. codeg holds a socket per web client, pipes per agent process, a
//! kqueue/epoll per async runtime and a few per SQLite connection, so 256 is
//! not a ceiling it can live under. Hitting it does not crash anything: it
//! makes unrelated operations fail with `EMFILE`. The one that surfaced it was
//! the session-import scan, whose Claude Code walk failed on its first
//! `read_dir` and came back empty, so a session plainly on disk was reported
//! as not found (`accept()` on the web listener was failing at the same time).

/// The soft limit [`raise_open_file_limit`] aims for. Comfortably above what
/// codeg uses, and macOS's `OPEN_MAX`, the highest value `setrlimit` accepts
/// there without consulting `kern.maxfilesperproc`.
pub const OPEN_FILE_LIMIT_TARGET: u64 = 10_240;

/// The soft limit to ask for, given the current soft and hard limits, or
/// `None` when the current one is already at least the target (or the hard
/// limit leaves no room to raise it).
pub fn open_file_limit_target(soft: u64, hard: u64) -> Option<u64> {
    let target = OPEN_FILE_LIMIT_TARGET.min(hard);
    (target > soft).then_some(target)
}

/// Raise this process's soft `RLIMIT_NOFILE` toward
/// [`OPEN_FILE_LIMIT_TARGET`], never above the hard limit. Returns the
/// `(before, after)` soft limits when it changed anything.
///
/// Call it once at startup. Child processes inherit the raised soft limit,
/// which is what they would get from a terminal on most systems anyway.
/// Failure is not fatal: the process just keeps the limit it was given.
#[cfg(unix)]
#[allow(clippy::unnecessary_cast)] // `rlim_t` is not u64 on every target.
pub fn raise_open_file_limit() -> Option<(u64, u64)> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: plain syscall with a valid, writable out-pointer.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return None;
    }
    let (soft, hard) = (limit.rlim_cur as u64, limit.rlim_max as u64);
    let mut target = open_file_limit_target(soft, hard)?;
    // A kernel cap below the target (`kern.maxfilesperproc` on macOS) makes
    // `setrlimit` refuse outright rather than clamp: step down until it takes.
    while target > soft {
        let wanted = libc::rlimit {
            rlim_cur: target as libc::rlim_t,
            rlim_max: limit.rlim_max,
        };
        // SAFETY: plain syscall with a valid in-pointer.
        if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &wanted) } == 0 {
            return Some((soft, target));
        }
        target /= 2;
    }
    None
}

#[cfg(not(unix))]
pub fn raise_open_file_limit() -> Option<(u64, u64)> {
    None
}

/// [`raise_open_file_limit`], logging the result. For the binaries' startup,
/// once the logging subscriber exists.
pub fn raise_open_file_limit_logged() {
    match raise_open_file_limit() {
        Some((before, after)) => {
            tracing::info!("[fd] raised the open-file limit from {before} to {after}")
        }
        None => tracing::debug!("[fd] open-file limit left as is"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_is_capped_by_the_hard_limit_and_never_lowers_the_soft_one() {
        // The macOS GUI default: 256 soft, unlimited hard.
        assert_eq!(
            open_file_limit_target(256, u64::MAX),
            Some(OPEN_FILE_LIMIT_TARGET)
        );
        // A hard limit below the target is as far as it can go.
        assert_eq!(open_file_limit_target(256, 4096), Some(4096));
        // Already there, or above: leave it alone.
        assert_eq!(open_file_limit_target(OPEN_FILE_LIMIT_TARGET, u64::MAX), None);
        assert_eq!(open_file_limit_target(65_536, u64::MAX), None);
        // No headroom at all.
        assert_eq!(open_file_limit_target(1024, 1024), None);
    }

    #[cfg(unix)]
    #[test]
    fn raising_leaves_the_soft_limit_at_least_where_it_was() {
        #[allow(clippy::unnecessary_cast)]
        fn soft_limit() -> u64 {
            let mut limit = libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            };
            // SAFETY: plain syscall with a valid, writable out-pointer.
            assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) }, 0);
            limit.rlim_cur as u64
        }

        let before = soft_limit();
        let changed = raise_open_file_limit();
        let after = soft_limit();
        assert!(after >= before);
        if let Some((from, to)) = changed {
            assert_eq!(to, after);
            assert!(to > from);
        } else {
            assert_eq!(after, before);
        }
    }
}
