//! A pushed session, ready to open.
//!
//! Tapping a notification opens its session, and the phone's first read is
//! the session's detail. A long transcript that is not in the transcript
//! cache is parsed whole for that read: 2 to 7 s for the 3,000 to 8,000-turn
//! Claude Code sessions in daily use (more on a loaded machine), all of it
//! spent with the phone showing the copy it saved, minutes or hours old. A
//! push is the moment that read becomes likely, so once a device got one for
//! a session, its transcript is read through the cache in the background
//! ([`warm_transcript_cache`]) and the tap finds it parsed.
//!
//! Kept cheap:
//! * one warm per session at a time: a push for a session whose warm is
//!   queued or running starts none;
//! * one warm at a time overall, so a burst of pushes reads one transcript
//!   after the other instead of all of them at once;
//! * out of the push's way: it starts once the push went out, on a task of
//!   its own, and the parse runs on the blocking pool;
//! * the cache's budget and eviction apply as to any read, and a session
//!   whose agent's parser keeps nothing between reads is skipped.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::Instant;

use sea_orm::DatabaseConnection;

use super::payload::{PushKind, PushMessage};
use super::DeliveryReport;
use crate::commands::conversations::{warm_transcript_cache, WarmOutcome};

/// One warm of one session's transcript.
pub type WarmFuture = Pin<Box<dyn Future<Output = ()> + Send>>;
type WarmFn = dyn Fn(DatabaseConnection, i32) -> WarmFuture + Send + Sync;

/// Starts warms, at most one per session and one at a time.
pub struct Warmer {
    warm: Box<WarmFn>,
    /// Sessions whose warm is queued or running.
    pending: Mutex<HashSet<i32>>,
    /// Held by the warm that runs.
    turn: tokio::sync::Semaphore,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The pushes a tap on opens a session from.
fn opens_session(kind: PushKind) -> bool {
    match kind {
        PushKind::TurnFinished | PushKind::NeedsYou | PushKind::Error | PushKind::Critical => true,
        PushKind::Test | PushKind::Badge => false,
    }
}

/// Takes a session off the pending set when its warm ends, however it ends.
struct Done {
    warmer: Arc<Warmer>,
    conversation_id: i32,
}

impl Drop for Done {
    fn drop(&mut self) {
        lock(&self.warmer.pending).remove(&self.conversation_id);
    }
}

impl Warmer {
    /// A warmer that runs `warm` for each session it starts.
    pub fn new(
        warm: impl Fn(DatabaseConnection, i32) -> WarmFuture + Send + Sync + 'static,
    ) -> Self {
        Self {
            warm: Box::new(warm),
            pending: Mutex::new(HashSet::new()),
            turn: tokio::sync::Semaphore::new(1),
        }
    }

    /// The process-wide warmer, reading through the transcript cache.
    pub fn global() -> &'static Arc<Warmer> {
        static WARMER: LazyLock<Arc<Warmer>> = LazyLock::new(|| Arc::new(Warmer::new(warm)));
        &WARMER
    }

    /// `message` went out with `report`: warm its session when a device got
    /// it and a tap on it opens one. Returns whether a warm was started.
    pub fn after_delivery(
        self: &Arc<Self>,
        db: &DatabaseConnection,
        message: &PushMessage,
        report: &DeliveryReport,
    ) -> bool {
        if report.delivered == 0 || !opens_session(message.kind) {
            return false;
        }
        match message.conversation_id {
            Some(conversation_id) => self.session_pushed(db, conversation_id),
            None => false,
        }
    }

    /// A push for `conversation_id` reached a device: warm its transcript
    /// unless a warm for it is already queued or running. Returns whether one
    /// was started. Never waits: the warm runs on a task of its own.
    pub fn session_pushed(self: &Arc<Self>, db: &DatabaseConnection, conversation_id: i32) -> bool {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return false;
        };
        if !lock(&self.pending).insert(conversation_id) {
            return false;
        }
        let done = Done {
            warmer: Arc::clone(self),
            conversation_id,
        };
        let db = db.clone();
        runtime.spawn(async move {
            let warmer = Arc::clone(&done.warmer);
            // Only fails once closed, which this semaphore never is.
            let _turn = warmer.turn.acquire().await;
            (warmer.warm)(db, conversation_id).await;
            drop(done);
        });
        true
    }

    /// Sessions whose warm is queued or running.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        lock(&self.pending).len()
    }
}

/// The warm itself: read the transcript through the cache, and say how it went.
fn warm(db: DatabaseConnection, conversation_id: i32) -> WarmFuture {
    Box::pin(async move {
        let started = Instant::now();
        let outcome = warm_transcript_cache(&db, conversation_id).await;
        let elapsed_ms = started.elapsed().as_millis() as u64;
        match outcome {
            Ok(WarmOutcome::Warmed { turns }) => tracing::info!(
                conversation_id,
                turns,
                elapsed_ms,
                "[push] warmed conversation {conversation_id} for its notification in {elapsed_ms} ms"
            ),
            Ok(skipped) => tracing::debug!(
                conversation_id,
                ?skipped,
                "[push] conversation {conversation_id} not warmed"
            ),
            Err(e) => tracing::warn!(
                conversation_id,
                elapsed_ms,
                "[push] could not warm conversation {conversation_id}: {}",
                e.message
            ),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use crate::db::service::push_device_service;
    use crate::db::test_helpers;
    use crate::presence::Looking;
    use crate::push::deliver_with;
    use crate::push::prefs::DevicePrefs;
    use crate::push::tests::{add_device, mock_apns, setup};

    /// A warmer whose warms count themselves, record the sessions they ran
    /// for, and each wait until `release` lets them finish.
    struct Probe {
        warmer: Arc<Warmer>,
        runs: Arc<AtomicUsize>,
        order: Arc<Mutex<Vec<i32>>>,
        running: Arc<AtomicUsize>,
        most_at_once: Arc<AtomicUsize>,
        release: Arc<tokio::sync::Notify>,
    }

    fn probe() -> Probe {
        let runs = Arc::new(AtomicUsize::new(0));
        let order = Arc::new(Mutex::new(Vec::new()));
        let running = Arc::new(AtomicUsize::new(0));
        let most_at_once = Arc::new(AtomicUsize::new(0));
        let release = Arc::new(tokio::sync::Notify::new());
        let warmer = {
            let (runs, order, running, most_at_once, release) = (
                runs.clone(),
                order.clone(),
                running.clone(),
                most_at_once.clone(),
                release.clone(),
            );
            Arc::new(Warmer::new(move |_db, conversation_id| {
                let (runs, order, running, most_at_once, release) = (
                    runs.clone(),
                    order.clone(),
                    running.clone(),
                    most_at_once.clone(),
                    release.clone(),
                );
                Box::pin(async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    lock(&order).push(conversation_id);
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    most_at_once.fetch_max(now, Ordering::SeqCst);
                    release.notified().await;
                    running.fetch_sub(1, Ordering::SeqCst);
                })
            }))
        };
        Probe {
            warmer,
            runs,
            order,
            running,
            most_at_once,
            release,
        }
    }

    /// Wait (bounded) until `condition` holds.
    async fn until(condition: impl Fn() -> bool) {
        for _ in 0..200 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition never held");
    }

    fn turn_finished(conversation_id: i32) -> PushMessage {
        PushMessage {
            kind: PushKind::TurnFinished,
            title: "Fix login".into(),
            body: "codeg · Claude Code has finished responding".into(),
            conversation_id: Some(conversation_id),
            folder_id: Some(3),
            agent_type: Some("claude_code".into()),
            alert_id: "alert-1".into(),
            critical_kind: None,
            needs: None,
            permission: None,
            sound: true,
            badge: None,
            pending: None,
        }
    }

    fn away() -> Looking {
        Looking {
            anyone: false,
            conversations: HashSet::new(),
        }
    }

    #[tokio::test]
    async fn a_push_that_reached_a_device_warms_its_session_once() {
        let db = test_helpers::fresh_in_memory_db().await;
        let conn = &db.conn;
        let (sender, _mock) = mock_apns().await;
        add_device(conn, "aaaa0001", "Phone", DevicePrefs::default()).await;
        add_device(conn, "bbbb0002", "iPad", DevicePrefs::default()).await;
        let probe = probe();

        let message = turn_finished(7);
        let report = deliver_with(&sender, conn, &setup(), &message, &away()).await;
        assert_eq!(report.delivered, 2, "one push, two devices");
        assert!(probe.warmer.after_delivery(conn, &message, &report));
        until(|| probe.runs.load(Ordering::SeqCst) == 1).await;

        // The same session pushed again while its warm runs (a reminder, the
        // turn's end right after its question): nothing more starts.
        let again = deliver_with(&sender, conn, &setup(), &message, &away()).await;
        assert!(!probe.warmer.after_delivery(conn, &message, &again));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(probe.runs.load(Ordering::SeqCst), 1);
        assert_eq!(probe.warmer.pending_count(), 1);

        // Once it ended, the next push warms again.
        probe.release.notify_one();
        until(|| probe.warmer.pending_count() == 0).await;
        assert!(probe.warmer.after_delivery(conn, &message, &again));
        until(|| probe.runs.load(Ordering::SeqCst) == 2).await;
        probe.release.notify_one();
        until(|| probe.warmer.pending_count() == 0).await;
        assert_eq!(*lock(&probe.order), vec![7, 7]);
    }

    #[tokio::test]
    async fn a_push_no_device_took_warms_nothing() {
        let db = test_helpers::fresh_in_memory_db().await;
        let conn = &db.conn;
        let (sender, _mock) = mock_apns().await;
        add_device(conn, "aaaa0001", "Phone", DevicePrefs::default()).await;
        let probe = probe();

        // Someone is looking at the session: the push is not sent.
        let looking = Looking {
            anyone: true,
            conversations: [7].into_iter().collect(),
        };
        let message = turn_finished(7);
        let report = deliver_with(&sender, conn, &setup(), &message, &looking).await;
        assert_eq!(report.delivered, 0);
        assert!(!probe.warmer.after_delivery(conn, &message, &report));

        // No device at all.
        for device in push_device_service::list(conn).await.unwrap() {
            push_device_service::delete(conn, device.id).await.unwrap();
        }
        let report = deliver_with(&sender, conn, &setup(), &message, &away()).await;
        assert!(!probe.warmer.after_delivery(conn, &message, &report));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(probe.runs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn pushes_that_open_no_session_warm_nothing() {
        let db = test_helpers::fresh_in_memory_db().await;
        let probe = probe();
        let delivered = DeliveryReport {
            delivered: 1,
            ..DeliveryReport::default()
        };
        let mut badge = PushMessage::badge_only(3);
        assert!(!probe.warmer.after_delivery(&db.conn, &badge, &delivered));
        // A badge or a test push never names a session; even one that did
        // opens nothing.
        badge.conversation_id = Some(7);
        assert!(!probe.warmer.after_delivery(&db.conn, &badge, &delivered));
        let mut test = turn_finished(7);
        test.kind = PushKind::Test;
        assert!(!probe.warmer.after_delivery(&db.conn, &test, &delivered));
        let mut unnamed = turn_finished(7);
        unnamed.conversation_id = None;
        assert!(!probe.warmer.after_delivery(&db.conn, &unnamed, &delivered));

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(probe.runs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn warms_for_different_sessions_run_one_after_the_other() {
        let db = test_helpers::fresh_in_memory_db().await;
        let probe = probe();
        assert!(probe.warmer.session_pushed(&db.conn, 1));
        assert!(probe.warmer.session_pushed(&db.conn, 2));
        assert!(probe.warmer.session_pushed(&db.conn, 3));
        // A session already queued is not queued twice.
        assert!(!probe.warmer.session_pushed(&db.conn, 3));
        assert_eq!(probe.warmer.pending_count(), 3);

        for finished in 1..=3 {
            until(|| probe.running.load(Ordering::SeqCst) == 1).await;
            // Give a second warm the chance to start alongside, if it could.
            tokio::time::sleep(Duration::from_millis(30)).await;
            assert_eq!(probe.runs.load(Ordering::SeqCst), finished);
            probe.release.notify_one();
            until(|| probe.warmer.pending_count() == 3 - finished).await;
        }
        assert_eq!(probe.most_at_once.load(Ordering::SeqCst), 1);
        let mut order = lock(&probe.order).clone();
        order.sort_unstable();
        assert_eq!(order, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn a_session_without_a_cached_parser_or_a_transcript_is_skipped() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/warm-skip").await;
        // Codex parses afresh on every read: warming it would throw a parse away.
        let codex =
            test_helpers::seed_conversation(&db, folder_id, crate::models::agent::AgentType::Codex)
                .await;
        crate::db::service::conversation_service::bind_external_id(
            &db.conn,
            codex,
            "019a0000-0000-7000-8000-000000000001",
            &[],
        )
        .await
        .unwrap();
        assert_eq!(
            warm_transcript_cache(&db.conn, codex).await.unwrap(),
            WarmOutcome::NotCached
        );
        // A row whose agent session has not started has nothing to read.
        let fresh = test_helpers::seed_conversation(
            &db,
            folder_id,
            crate::models::agent::AgentType::ClaudeCode,
        )
        .await;
        assert_eq!(
            warm_transcript_cache(&db.conn, fresh).await.unwrap(),
            WarmOutcome::NoTranscript
        );
    }
}
