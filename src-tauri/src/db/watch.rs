//! Contention diagnostics for the database pool, cheap enough to stay on:
//!
//!   * a write that keeps SQLite's write lock [`SLOW_WRITE_LOCK`] or longer is
//!     logged when it commits or rolls back, with the first table it changed,
//!     under the tracing span of the code that ran it (sqlx runs every command
//!     inside its caller's span) — the holder every other writer queues behind;
//!   * a statement that keeps its pooled connection [`SLOW_STATEMENT`] or longer
//!     is logged with its SQL, under its caller's span;
//!   * a wait of [`SLOW_ACQUIRE`] or longer for a pooled connection is logged by
//!     sqlx itself ("acquired connection, but time to acquire exceeded slow
//!     threshold"), under the waiter's span;
//!   * [`run_runtime_stall_watch`] logs when the async runtime got to a ready
//!     task [`RUNTIME_STALL`] or more late. A task that is not polled keeps the
//!     connection (and any write lock) it holds, so a stalled runtime shows up
//!     as pool waits and "database is locked" everywhere else.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use sea_orm::sqlx::sqlite::SqliteConnection;

/// A write holding the write lock this long blocks every other writer for as
/// long, and a writer that waits past `busy_timeout` fails.
pub const SLOW_WRITE_LOCK: Duration = Duration::from_millis(500);
/// A statement keeping its connection this long.
pub const SLOW_STATEMENT: Duration = Duration::from_millis(500);
/// A wait for a pooled connection this long.
pub const SLOW_ACQUIRE: Duration = Duration::from_millis(500);

const RUNTIME_TICK: Duration = Duration::from_millis(250);
const RUNTIME_STALL: Duration = Duration::from_secs(1);

/// The write in progress on one connection: when its first row changed, and
/// what that change was.
type OpenWrite = Arc<Mutex<Option<(Instant, String)>>>;

/// Install the write-lock watch on a freshly opened pooled connection.
///
/// The update hook marks the first row a write changes (from then until the
/// transaction ends the connection holds the write lock), and the commit and
/// rollback hooks report how long that was. All three run on the connection's
/// worker thread, inside the span of the command that triggered them.
pub async fn watch_writes(conn: &mut SqliteConnection) -> Result<(), sea_orm::sqlx::Error> {
    let open: OpenWrite = Arc::default();
    let mut handle = conn.lock_handle().await?;

    let on_change = Arc::clone(&open);
    handle.set_update_hook(move |change| {
        let mut slot = on_change.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            *slot = Some((
                Instant::now(),
                format!("{:?} {}", change.operation, change.table),
            ));
        }
    });
    let on_commit = Arc::clone(&open);
    handle.set_commit_hook(move || {
        report_write(&on_commit, "committed");
        // `true` lets the commit go ahead.
        true
    });
    handle.set_rollback_hook(move || report_write(&open, "rolled back"));
    Ok(())
}

/// Close the write in progress, logging it when it held the lock too long.
/// Returns how long it held it.
fn report_write(open: &Mutex<Option<(Instant, String)>>, outcome: &str) -> Option<Duration> {
    let (since, first_write) = open
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take()?;
    let held = since.elapsed();
    if held >= SLOW_WRITE_LOCK {
        tracing::warn!(
            held_ms = held.as_millis() as u64,
            first_write = %first_write,
            outcome,
            "[db] write lock held {} ms",
            held.as_millis()
        );
    }
    Some(held)
}

/// sea-orm's metric callback: log a statement that kept its connection too
/// long. Runs in the caller's task, so the log carries the caller's span.
pub fn log_slow_statement(info: &sea_orm::metric::Info<'_>) {
    if info.elapsed < SLOW_STATEMENT {
        return;
    }
    tracing::warn!(
        elapsed_ms = info.elapsed.as_millis() as u64,
        failed = info.failed,
        sql = %sql_head(&info.statement.sql),
        "[db] slow statement: {} ms",
        info.elapsed.as_millis()
    );
}

/// The start of a statement, enough to tell which one it is.
fn sql_head(sql: &str) -> String {
    const MAX_CHARS: usize = 120;
    let flat: String = sql.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(MAX_CHARS) {
        Some((cut, _)) => format!("{}…", &flat[..cut]),
        None => flat,
    }
}

/// Log, for the life of the process, every time the async runtime got to a
/// ready task [`RUNTIME_STALL`] or more late.
pub async fn run_runtime_stall_watch() {
    let mut ticker = tokio::time::interval(RUNTIME_TICK);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await;
    let mut last = Instant::now();
    loop {
        ticker.tick().await;
        let now = Instant::now();
        if let Some(late) = stall(now.duration_since(last)) {
            tracing::warn!(
                stalled_ms = late.as_millis() as u64,
                "[runtime] async runtime stalled for {} ms",
                late.as_millis()
            );
        }
        last = now;
    }
}

/// How late a tick that came `gap` after the previous one was, when that is a
/// stall worth reporting.
fn stall(gap: Duration) -> Option<Duration> {
    let late = gap.saturating_sub(RUNTIME_TICK);
    (late >= RUNTIME_STALL).then_some(late)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_write_is_timed_from_its_first_change_and_closed_once() {
        let open: OpenWrite = Arc::default();
        assert_eq!(report_write(&open, "committed"), None, "nothing was written");

        *open.lock().unwrap() = Some((Instant::now() - Duration::from_secs(2), "Insert t".into()));
        let held = report_write(&open, "committed").expect("an open write");
        assert!(held >= Duration::from_secs(2));
        assert_eq!(report_write(&open, "committed"), None, "closed by the first report");
    }

    #[test]
    fn sql_is_flattened_and_cut() {
        assert_eq!(sql_head("SELECT  *\n FROM t"), "SELECT * FROM t");
        let long = "x".repeat(300);
        let head = sql_head(&long);
        assert_eq!(head.chars().count(), 121);
        assert!(head.ends_with('…'));
    }

    #[test]
    fn only_a_late_tick_is_a_stall() {
        assert_eq!(stall(RUNTIME_TICK), None);
        assert_eq!(stall(RUNTIME_TICK + Duration::from_millis(900)), None);
        assert_eq!(
            stall(RUNTIME_TICK + Duration::from_secs(3)),
            Some(Duration::from_secs(3))
        );
    }
}
