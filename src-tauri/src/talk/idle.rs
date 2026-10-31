//! Talk left on by a client that went away: a phone suspended mid-call, an
//! app that crashed, a Mac that slept through the end of a Talk. A
//! conversation that stays in Talk (`on`) while no client's fresh presence
//! report names it for [`TALK_IDLE_LIMIT`] has its Talk turned off, as the
//! menu would: the state becomes `ending`, so the Off note goes with the next
//! message and nothing the agent already has changes. Never while some
//! client's report for it is fresh (talking, looking, or merely showing it).

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use sea_orm::DatabaseConnection;

use crate::acp::manager::ConnectionManager;
use crate::db::service::conversation_service;
use crate::web::event_bridge::EventEmitter;

/// How long a Talk may go without any client reporting it.
pub const TALK_IDLE_LIMIT: Duration = Duration::from_secs(15 * 60);
/// How often the conversations in Talk are checked.
const CHECK_EVERY: Duration = Duration::from_secs(60);

/// When each conversation in Talk was last named by a fresh report (or first
/// seen in Talk, which starts its clock).
#[derive(Debug, Default)]
pub struct TalkIdleTracker {
    last_reported: HashMap<i32, Instant>,
}

impl TalkIdleTracker {
    /// One check of the conversations in Talk (`on`) against the sessions
    /// some fresh report names (`reported`): the ones to turn off.
    pub fn step(
        &mut self,
        on: &[i32],
        reported: &HashSet<i32>,
        now: Instant,
        limit: Duration,
    ) -> Vec<i32> {
        self.last_reported.retain(|id, _| on.contains(id));
        let mut idle = Vec::new();
        for &id in on {
            if reported.contains(&id) {
                self.last_reported.insert(id, now);
                continue;
            }
            let since = *self.last_reported.entry(id).or_insert(now);
            if now.saturating_duration_since(since) >= limit {
                idle.push(id);
            }
        }
        idle
    }
}

/// One check: turns off the Talks nobody reported for `limit`, and returns
/// their conversations.
pub async fn idle_pass(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    manager: &ConnectionManager,
    tracker: &mut TalkIdleTracker,
    reported: &HashSet<i32>,
    now: Instant,
    limit: Duration,
) -> Vec<i32> {
    let on = match conversation_service::list_talk_on(conn).await {
        Ok(ids) => ids,
        Err(e) => {
            tracing::warn!("[talk] could not list the conversations in Talk: {e}");
            return Vec::new();
        }
    };
    let mut turned_off = Vec::new();
    for id in tracker.step(&on, reported, now, limit) {
        match super::set_conversation_talk_mode_core(conn, emitter, manager, id, false).await {
            Ok(()) => {
                tracing::info!(
                    "[talk] conversation {id} stayed in Talk with no client reporting it for {} minutes; turned Talk off",
                    limit.as_secs() / 60
                );
                turned_off.push(id);
            }
            Err(e) => tracing::warn!("[talk] could not turn Talk off for conversation {id}: {e}"),
        }
    }
    turned_off
}

/// Runs for the life of the process (desktop and server).
pub async fn talk_idle_task(
    conn: DatabaseConnection,
    emitter: EventEmitter,
    manager: ConnectionManager,
) {
    let mut tracker = TalkIdleTracker::default();
    let mut every = tokio::time::interval(CHECK_EVERY);
    every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        every.tick().await;
        let reported = crate::presence::reported();
        idle_pass(
            &conn,
            &emitter,
            &manager,
            &mut tracker,
            &reported,
            Instant::now(),
            TALK_IDLE_LIMIT,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::db::entities::conversation::ConversationTalkState;
    use crate::db::service::conversation_service::{read_talk_state, set_talk_state};
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::models::AgentType;
    use crate::presence::{ClientKind, PresenceRegistry, PresenceReport};
    use crate::web::event_bridge::WebEventBroadcaster;

    const MINUTE: Duration = Duration::from_secs(60);

    #[test]
    fn talk_goes_off_after_fifteen_minutes_with_no_report() {
        let mut tracker = TalkIdleTracker::default();
        let t0 = Instant::now();
        let none = HashSet::new();
        assert!(tracker.step(&[25], &none, t0, TALK_IDLE_LIMIT).is_empty());
        assert!(tracker
            .step(&[25], &none, t0 + 14 * MINUTE, TALK_IDLE_LIMIT)
            .is_empty());
        assert_eq!(
            tracker.step(&[25], &none, t0 + 15 * MINUTE, TALK_IDLE_LIMIT),
            vec![25]
        );
    }

    #[test]
    fn a_fresh_report_holds_talk_and_restarts_the_clock() {
        let mut tracker = TalkIdleTracker::default();
        let t0 = Instant::now();
        let none = HashSet::new();
        let talking = HashSet::from([25]);
        tracker.step(&[25], &none, t0, TALK_IDLE_LIMIT);
        // Fifty minutes of a phone talking: never off.
        for minute in 1..=50 {
            assert!(tracker
                .step(&[25], &talking, t0 + minute * MINUTE, TALK_IDLE_LIMIT)
                .is_empty());
        }
        let quiet = t0 + 50 * MINUTE;
        assert!(tracker
            .step(&[25], &none, quiet + 14 * MINUTE, TALK_IDLE_LIMIT)
            .is_empty());
        assert_eq!(
            tracker.step(&[25], &none, quiet + 15 * MINUTE, TALK_IDLE_LIMIT),
            vec![25]
        );
    }

    #[test]
    fn a_talk_turned_off_meanwhile_is_forgotten() {
        let mut tracker = TalkIdleTracker::default();
        let t0 = Instant::now();
        let none = HashSet::new();
        tracker.step(&[25, 26], &none, t0, TALK_IDLE_LIMIT);
        // 25 was turned off, then on again later: its clock starts over.
        tracker.step(&[26], &none, t0 + 10 * MINUTE, TALK_IDLE_LIMIT);
        assert_eq!(
            tracker.step(&[25, 26], &none, t0 + 15 * MINUTE, TALK_IDLE_LIMIT),
            vec![26]
        );
    }

    /// The registry's fresh reports decide, as the task reads them.
    #[test]
    fn what_the_presence_registry_reports_holds_talk() {
        let mut registry = PresenceRegistry::default();
        let t0 = Instant::now();
        let phone = registry.connect_socket(ClientKind::Ios);
        registry.report_socket(
            phone,
            PresenceReport {
                talking: true,
                conversation_ids: vec![25],
                ..PresenceReport::default()
            },
            t0,
        );
        let mut tracker = TalkIdleTracker::default();
        let at = |minutes: u32| t0 + minutes * MINUTE;
        tracker.step(&[25], &registry.reported(at(0)), at(0), TALK_IDLE_LIMIT);
        // The phone is suspended: its report goes stale after 90 s, then
        // fifteen minutes later Talk goes off.
        assert!(tracker
            .step(&[25], &registry.reported(at(2)), at(2), TALK_IDLE_LIMIT)
            .is_empty());
        assert_eq!(
            tracker.step(&[25], &registry.reported(at(17)), at(17), TALK_IDLE_LIMIT),
            vec![25]
        );
    }

    #[tokio::test]
    async fn the_pass_turns_an_abandoned_talk_to_ending() {
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, "/tmp/codeg-talk-idle").await;
        let abandoned = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let attended = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let off = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        for id in [abandoned, attended] {
            set_talk_state(&db.conn, id, Some(ConversationTalkState::On))
                .await
                .unwrap();
        }
        let emitter = EventEmitter::test_web_only(Arc::new(WebEventBroadcaster::new()));
        let manager = ConnectionManager::new();
        let mut tracker = TalkIdleTracker::default();
        let t0 = Instant::now();
        let reported = HashSet::from([attended]);
        let first = idle_pass(
            &db.conn,
            &emitter,
            &manager,
            &mut tracker,
            &reported,
            t0,
            TALK_IDLE_LIMIT,
        )
        .await;
        assert!(first.is_empty());
        let later = idle_pass(
            &db.conn,
            &emitter,
            &manager,
            &mut tracker,
            &reported,
            t0 + TALK_IDLE_LIMIT,
            TALK_IDLE_LIMIT,
        )
        .await;
        assert_eq!(later, vec![abandoned]);
        assert_eq!(
            read_talk_state(&db.conn, abandoned).await.unwrap(),
            Some(Some(ConversationTalkState::Ending)),
            "the Off note goes with the next message"
        );
        assert_eq!(
            read_talk_state(&db.conn, attended).await.unwrap(),
            Some(Some(ConversationTalkState::On))
        );
        assert_eq!(read_talk_state(&db.conn, off).await.unwrap(), Some(None));
    }
}
