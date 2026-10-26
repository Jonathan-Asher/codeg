//! The pending items' state machine: fed what the live sessions hold, who is
//! looking and the time, it decides what to push and when. No I/O and no
//! clock of its own, so the tests drive it with a fake one.
//!
//! Per item:
//!
//! 1. **First push** (attempt 0), when it appears: the ordinary "needs you"
//!    push, subject to each device's preference ("only when away" by
//!    default). Nothing while someone looks at its session. A second item of
//!    the same session within [`COOLDOWN_SECS`] waits for the cooldown, so a
//!    burst buzzes once.
//! 2. **Catch-up**: when the desk empties (presence flips to away), every item
//!    no iPhone heard of yet is pushed at once.
//! 3. **Reminders** (attempt 1, 2, …) at the schedule's offsets from the ask,
//!    to the iPhone (whatever "only when away" says) and the desktop. A
//!    reminder due while someone looks at the session is skipped; one due in
//!    the quiet hours waits for their end. Several due at once (the machine
//!    slept) go out as one, the latest.
//!
//! An item leaves the moment its session stops holding it — answered on any
//! device, cancelled, expired — and nothing more goes out for it.
//!
//! Counts: every push carries the badge; after the count settles for
//! [`BADGE_SETTLE_SECS`], a [`Job::Badge`] brings every device to it (an answered
//! item's silent badge drop).

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{
    fingerprint, Ask, PendingItem, PendingKind, PendingReminder, PendingSnapshot,
    ReminderSettings, SessionMeta,
};
use crate::presence::Looking;

/// A session's next first push waits this long (seconds) after its last one.
pub const COOLDOWN_SECS: i64 = 3;

/// The count must hold this long (seconds) before the devices' badges follow
/// it alone.
pub const BADGE_SETTLE_SECS: i64 = 3;

/// How long (seconds) after a restart a stored item may still be recognised
/// when its session asks it again.
pub const ORPHAN_TTL_SECS: i64 = 30 * 60;

fn secs(n: i64) -> chrono::Duration {
    chrono::Duration::seconds(n)
}

/// What the bookkeeping keeps of an item across a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stored {
    pub id: String,
    pub conversation_id: i32,
    pub kind: PendingKind,
    pub fingerprint: u64,
    pub asked_at: DateTime<Utc>,
    pub phone_notified: bool,
    pub next_attempt: u32,
    pub reminders_sent: u32,
    pub last_reminded_at: Option<DateTime<Utc>>,
}

/// Something to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Job {
    /// Push one item to the iPhones. `attempt` 0 is the first push (and the
    /// catch-up), `n` the n-th reminder.
    Push {
        item: PendingItem,
        attempt: u32,
        reminder: bool,
    },
    /// Bring every device's app badge to `count`.
    Badge { count: u32 },
}

/// What one observation decided.
#[derive(Debug, Default)]
pub struct Pass {
    /// The list (or an item's bookkeeping) changed: publish a snapshot.
    pub list_changed: bool,
    /// In order: the pushes, then a badge sync.
    pub jobs: Vec<Job>,
    /// The reminders that fired, for the desktop notification.
    pub reminders: Vec<PendingReminder>,
}

#[derive(Debug, Clone)]
struct Tracked {
    ask: Ask,
    meta: SessionMeta,
    fingerprint: u64,
    asked_at: DateTime<Utc>,
    first_push_done: bool,
    phone_notified: bool,
    /// A push for it is on its way; its outcome is not known yet.
    in_flight: bool,
    /// The next reminder to send (1 is the first).
    next_attempt: u32,
    reminders_sent: u32,
    last_reminded_at: Option<DateTime<Utc>>,
}

impl Tracked {
    fn seen(&self, looking: &Looking) -> bool {
        looking.at(self.ask.conversation_id) || looking.at(self.meta.root_conversation_id)
    }

    fn stored(&self) -> Stored {
        Stored {
            id: self.ask.id.clone(),
            conversation_id: self.ask.conversation_id,
            kind: self.ask.kind,
            fingerprint: self.fingerprint,
            asked_at: self.asked_at,
            phone_notified: self.phone_notified,
            next_attempt: self.next_attempt,
            reminders_sent: self.reminders_sent,
            last_reminded_at: self.last_reminded_at,
        }
    }
}

fn view(settings: &ReminderSettings, t: &Tracked) -> PendingItem {
    PendingItem {
        id: t.ask.id.clone(),
        kind: t.ask.kind,
        source: t.ask.source,
        conversation_id: t.ask.conversation_id,
        root_conversation_id: t.meta.root_conversation_id,
        folder_id: t.meta.folder_id,
        folder_name: t.meta.folder_name.clone(),
        title: t.meta.title.clone(),
        agent_type: t.meta.agent_type.clone(),
        agent_label: t.ask.agent_label.clone(),
        connection_id: t.ask.connection_id.clone(),
        request_id: t.ask.request_id.clone(),
        asked_at: t.asked_at,
        text: t.ask.text.clone(),
        options: t.ask.options.clone(),
        question: t.ask.question.clone(),
        queued: t.ask.queued,
        reminders_sent: t.reminders_sent,
        last_reminded_at: t.last_reminded_at,
        next_reminder_at: settings.due_at(t.asked_at, t.next_attempt),
        phone_notified: t.phone_notified,
    }
}

/// The registry. One per process ([`super::with_engine`]); tests build their
/// own.
#[derive(Debug, Default)]
pub struct Engine {
    settings: ReminderSettings,
    items: BTreeMap<String, Tracked>,
    /// Items stored by the previous run, waiting to be asked again.
    orphans: Vec<Stored>,
    orphans_until: Option<DateTime<Utc>>,
    /// Whether the user was away at the previous observation.
    away: Option<bool>,
    /// When each top-level session last had a first push.
    last_first_push: HashMap<i32, DateTime<Utc>>,
    badge_count: Option<u32>,
    badge_dirty_since: Option<DateTime<Utc>>,
    /// The bookkeeping changed since it was last stored.
    dirty: bool,
}

impl Engine {
    pub fn new(settings: ReminderSettings) -> Self {
        Self {
            settings,
            ..Self::default()
        }
    }

    pub fn settings(&self) -> &ReminderSettings {
        &self.settings
    }

    pub fn set_settings(&mut self, settings: ReminderSettings) {
        self.settings = settings;
    }

    /// Pick up the previous run's bookkeeping: its items wait, for
    /// [`ORPHAN_TTL_SECS`], to be asked again.
    pub fn load(&mut self, stored: Vec<Stored>, now: DateTime<Utc>) {
        self.orphans = stored;
        self.orphans_until = Some(now + secs(ORPHAN_TTL_SECS));
    }

    /// The bookkeeping to store, when it changed.
    pub fn take_dirty(&mut self) -> Option<Vec<Stored>> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        Some(self.stored())
    }

    pub fn stored(&self) -> Vec<Stored> {
        let mut out: Vec<Stored> = self.items.values().map(Tracked::stored).collect();
        // Not yet asked again: keep them for the rest of their window.
        out.extend(self.orphans.iter().cloned());
        out
    }

    pub fn count(&self) -> u32 {
        self.items.len() as u32
    }

    pub fn snapshot(&self) -> PendingSnapshot {
        let mut items: Vec<PendingItem> = self
            .items
            .values()
            .map(|t| view(&self.settings, t))
            .collect();
        items.sort_by(|a, b| a.asked_at.cmp(&b.asked_at).then_with(|| a.id.cmp(&b.id)));
        PendingSnapshot {
            count: items.len() as u32,
            items,
        }
    }

    /// A push for `id` finished: `delivered` if a device took it.
    pub fn note_delivery(&mut self, id: &str, delivered: bool) {
        let Some(t) = self.items.get_mut(id) else {
            return;
        };
        t.in_flight = false;
        if delivered && !t.phone_notified {
            t.phone_notified = true;
            self.dirty = true;
        }
    }

    fn take_orphan(&mut self, ask: &Ask, fingerprint: u64) -> Option<Stored> {
        let at = self.orphans.iter().position(|s| {
            s.id == ask.id
                || (s.conversation_id == ask.conversation_id
                    && s.kind == ask.kind
                    && s.fingerprint == fingerprint)
        })?;
        Some(self.orphans.swap_remove(at))
    }

    fn track(&mut self, ask: Ask, meta: SessionMeta, now: DateTime<Utc>) -> Tracked {
        let fingerprint = fingerprint(&ask);
        match self.take_orphan(&ask, fingerprint) {
            // The same ask as before a restart: it keeps its age and its
            // reminders, and the phone is not told twice.
            Some(s) => Tracked {
                asked_at: s.asked_at.min(ask.asked_at),
                first_push_done: s.phone_notified,
                phone_notified: s.phone_notified,
                in_flight: false,
                next_attempt: s.next_attempt.max(1),
                reminders_sent: s.reminders_sent,
                last_reminded_at: s.last_reminded_at,
                fingerprint,
                ask,
                meta,
            },
            None => {
                // Reminders already due when it is first seen are covered by
                // its first push.
                let next_attempt = self
                    .settings
                    .latest_due(ask.asked_at, 1, now)
                    .map_or(1, |k| k + 1);
                Tracked {
                    asked_at: ask.asked_at,
                    first_push_done: false,
                    phone_notified: false,
                    in_flight: false,
                    next_attempt,
                    reminders_sent: 0,
                    last_reminded_at: None,
                    fingerprint,
                    ask,
                    meta,
                }
            }
        }
    }

    /// One observation: what the live sessions hold now, who is looking.
    pub fn observe(
        &mut self,
        live: Vec<(Ask, SessionMeta)>,
        looking: &Looking,
        now: DateTime<Utc>,
    ) -> Pass {
        let mut pass = Pass::default();
        if self.orphans_until.is_some_and(|until| now >= until) {
            if !self.orphans.is_empty() {
                self.dirty = true;
            }
            self.orphans.clear();
            self.orphans_until = None;
        }

        // Membership: answered, cancelled and expired items leave.
        let live_ids: HashSet<String> = live.iter().map(|(ask, _)| ask.id.clone()).collect();
        let before = self.items.len();
        self.items.retain(|id, _| live_ids.contains(id));
        if self.items.len() != before {
            pass.list_changed = true;
            self.dirty = true;
        }
        self.last_first_push
            .retain(|_, at| now.signed_duration_since(*at) < secs(COOLDOWN_SECS));
        for (ask, meta) in live {
            if let Some(t) = self.items.get_mut(&ask.id) {
                if t.ask != ask || t.meta != meta {
                    t.ask = ask;
                    t.meta = meta;
                    pass.list_changed = true;
                }
                continue;
            }
            let tracked = self.track(ask, meta, now);
            self.items.insert(tracked.ask.id.clone(), tracked);
            pass.list_changed = true;
            self.dirty = true;
        }

        let quiet = self.settings.is_quiet(now);

        // First pushes.
        for t in self.items.values_mut() {
            if t.first_push_done {
                continue;
            }
            let root = t.meta.root_conversation_id;
            if self.last_first_push.contains_key(&root) {
                continue;
            }
            t.first_push_done = true;
            self.dirty = true;
            if t.seen(looking) {
                // On screen: the phone stays quiet, the catch-up covers it
                // if the user leaves without answering.
                continue;
            }
            self.last_first_push.insert(root, now);
            t.in_flight = true;
            pass.jobs.push(Job::Push {
                item: view(&self.settings, t),
                attempt: 0,
                reminder: false,
            });
        }

        // The desk emptied: tell the phone what it missed.
        let away = looking.away();
        if self.away == Some(false) && away && !quiet {
            for t in self.items.values_mut() {
                if t.first_push_done && !t.phone_notified && !t.in_flight && !t.seen(looking) {
                    t.in_flight = true;
                    pass.jobs.push(Job::Push {
                        item: view(&self.settings, t),
                        attempt: 0,
                        reminder: false,
                    });
                }
            }
        }
        self.away = Some(away);

        // Reminders.
        if self.settings.enabled {
            for t in self.items.values_mut() {
                if !t.first_push_done {
                    continue;
                }
                let Some(k) = self.settings.latest_due(t.asked_at, t.next_attempt, now) else {
                    continue;
                };
                if t.seen(looking) {
                    t.next_attempt = k + 1;
                    self.dirty = true;
                    pass.list_changed = true;
                    continue;
                }
                if quiet {
                    continue;
                }
                t.next_attempt = k + 1;
                t.reminders_sent += 1;
                t.last_reminded_at = Some(now);
                t.in_flight = true;
                self.dirty = true;
                pass.list_changed = true;
                let item = view(&self.settings, t);
                pass.reminders.push(PendingReminder {
                    id: format!("{}#{k}", t.ask.id),
                    attempt: k,
                    item: item.clone(),
                });
                pass.jobs.push(Job::Push {
                    item,
                    attempt: k,
                    reminder: true,
                });
            }
        }

        // The badge, once the count holds still.
        let count = self.items.len() as u32;
        if self.badge_count != Some(count) {
            self.badge_count = Some(count);
            self.badge_dirty_since = Some(now);
        }
        if self
            .badge_dirty_since
            .is_some_and(|since| now.signed_duration_since(since) >= secs(BADGE_SETTLE_SECS))
        {
            self.badge_dirty_since = None;
            pass.jobs.push(Job::Badge { count });
        }
        pass
    }
}
