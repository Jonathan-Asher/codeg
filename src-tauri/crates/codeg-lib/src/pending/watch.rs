//! The runtime around [`Engine`]: once a second, and at once after an event
//! that can add or clear an item, it reads every live session, asks the
//! engine what to do, publishes the list, raises the desktop reminders and
//! hands the pushes to a delivery task (an APNs retry must not hold the next
//! pass up). The dock badge follows the count on desktop.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use tokio::sync::{broadcast, mpsc};

use super::engine::{Job, Stored};
use super::{
    asks_of, load_reminder_settings, set_pending_count, with_engine, PendingItem, PendingKind,
    PendingSource, SessionMeta, PENDING_ITEMS_EVENT, PENDING_REMINDER_EVENT, REMINDER_STATE_KEY,
};
use crate::acp::manager::ConnectionManager;
use crate::acp::types::AcpEvent;
use crate::acp::InternalEventBus;
use crate::chat_channel::i18n::Lang;
use crate::db::service::app_metadata_service;
use crate::presence;
use crate::presence::Looking;
use crate::push::apns::ApnsSender;
use crate::push::payload::{
    NeedsKind, PendingPush, PermissionAction, PushKind, PushMessage, QuestionPush,
};
use crate::push::{self, fanout, wording, DeliveryReport, SendSetup};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// How often the watch reads the sessions when no event wakes it.
pub const TICK: Duration = Duration::from_secs(1);

/// How long a session's title and folder are reused before being read again.
const META_TTL: Duration = Duration::from_secs(60);

/// Where the engine's pushes go: APNs in the app, a recorder in the tests.
#[async_trait]
pub trait PushSink: Send + Sync {
    /// Push one item; whether a device took it.
    async fn push(&self, item: &PendingItem, attempt: u32, reminder: bool) -> bool;
    /// Bring every device's app badge to `count`.
    async fn badge(&self, count: u32);
}

/// Carry out one pass's jobs in order, reporting each push's outcome.
pub async fn run_jobs(
    sink: &dyn PushSink,
    jobs: Vec<Job>,
    mut delivered: impl FnMut(&str, bool) + Send,
) {
    for job in jobs {
        match job {
            Job::Push {
                item,
                attempt,
                reminder,
            } => {
                let ok = sink.push(&item, attempt, reminder).await;
                delivered(&item.id, ok);
            }
            Job::Badge { count } => sink.badge(count).await,
        }
    }
}

/// The notification for one item: the session's title, what it waits for
/// (or, for a reminder, how long it has), and what it asks.
pub fn pending_message(
    lang: Lang,
    item: &PendingItem,
    attempt: u32,
    reminder: bool,
    now: DateTime<Utc>,
) -> PushMessage {
    let agent = item.agent_label.as_str();
    let content = if reminder {
        let elapsed = wording::waited(lang, (now - item.asked_at).num_seconds());
        wording::reminder(lang, item.kind, agent, &elapsed)
    } else {
        match item.kind {
            PendingKind::Permission => wording::permission(lang, agent),
            PendingKind::Question => wording::question(lang, agent),
            PendingKind::Plan => wording::plan(lang, agent),
        }
    };
    let (title, mut body) = wording::session_title_and_body(
        item.title.as_deref(),
        item.folder_name.as_deref(),
        content,
    );
    let text = item.text.trim();
    if !text.is_empty() {
        body.push('\n');
        body.push_str(text);
    }
    let needs = match item.source {
        PendingSource::Permission => NeedsKind::Permission,
        PendingSource::Question => NeedsKind::Question,
        PendingSource::PlanApproval => NeedsKind::Plan,
    };
    let permission = (item.source == PendingSource::Permission).then(|| {
        PermissionAction::from_options(
            &item.connection_id,
            &item.request_id,
            item.options
                .iter()
                .map(|o| (o.id.as_str(), o.kind.as_deref().unwrap_or(""))),
        )
    });
    let question = match (item.source, &item.question) {
        (PendingSource::Question, Some(q)) => Some(QuestionPush {
            question_id: item.request_id.clone(),
            item_id: q.item_id.clone(),
            text: item.text.clone(),
            header: q.header.clone(),
            multi_select: q.multi_select,
            // The full labels: an answer carries one exactly.
            options: item.options.iter().map(|o| o.id.clone()).collect(),
            count: q.count,
        }),
        _ => None,
    };
    PushMessage {
        kind: PushKind::NeedsYou,
        title,
        body,
        conversation_id: Some(item.root_conversation_id),
        folder_id: item.folder_id,
        agent_type: item.agent_type.clone(),
        alert_id: uuid::Uuid::new_v4().simple().to_string(),
        critical_kind: None,
        needs: Some(needs),
        permission,
        sound: true,
        badge: None,
        pending: Some(PendingPush {
            id: item.id.clone(),
            kind: item.kind,
            since: item.asked_at,
            reminder,
            attempt,
            connection_id: item.connection_id.clone(),
            asking_conversation_id: item.conversation_id,
            question,
            approval_id: (item.source == PendingSource::PlanApproval)
                .then(|| item.request_id.clone()),
        }),
    }
}

/// Push one item through `sender`, worded in the push language.
pub async fn push_item(
    sender: &ApnsSender,
    db: &DatabaseConnection,
    setup: &SendSetup,
    what: (&PendingItem, u32, bool),
    looking: &Looking,
) -> DeliveryReport {
    let (item, attempt, reminder) = what;
    let lang = push::push_lang(db, &setup.settings).await;
    let message = pending_message(lang, item, attempt, reminder, Utc::now());
    push::deliver_with(sender, db, setup, &message, looking).await
}

/// The iPhones, through APNs with the stored settings.
pub struct ApnsSink {
    pub db: DatabaseConnection,
}

#[async_trait]
impl PushSink for ApnsSink {
    async fn push(&self, item: &PendingItem, attempt: u32, reminder: bool) -> bool {
        if !push::has_devices(&self.db).await {
            return false;
        }
        let Ok(setup) = push::load_send_setup(&self.db).await else {
            return false;
        };
        let report = push_item(
            push::apns::sender(),
            &self.db,
            &setup,
            (item, attempt, reminder),
            &presence::snapshot(),
        )
        .await;
        if report.delivered > 0 || report.removed > 0 || !report.failed.is_empty() {
            tracing::info!(
                "[pending] {} {} (attempt {attempt}) for conversation {}: {} delivered, {} removed, {} failed",
                if reminder { "reminder" } else { "push" },
                item.id,
                item.root_conversation_id,
                report.delivered,
                report.removed,
                report.failed.len()
            );
        }
        report.delivered > 0
    }

    async fn badge(&self, count: u32) {
        push::sync_badges(&self.db, count).await;
    }
}

async fn deliver_jobs(sink: ApnsSink, mut rx: mpsc::UnboundedReceiver<Vec<Job>>) {
    while let Some(jobs) = rx.recv().await {
        run_jobs(&sink, jobs, |id, ok| {
            with_engine(|e| e.note_delivery(id, ok));
        })
        .await;
    }
}

/// Where an item shows: the top of its delegation chain, with that
/// session's title, folder and agent.
async fn session_meta(db: &DatabaseConnection, conversation_id: i32) -> SessionMeta {
    let root = crate::commands::attention::root_of(db, conversation_id).await;
    match fanout::session_info(db, root).await {
        Some(info) => SessionMeta {
            root_conversation_id: root,
            folder_id: Some(info.folder_id),
            folder_name: info.folder_name,
            title: info.title,
            agent_type: Some(info.agent_type),
        },
        None => SessionMeta {
            root_conversation_id: root,
            ..SessionMeta::default()
        },
    }
}

#[derive(Default)]
struct MetaCache {
    entries: HashMap<i32, (SessionMeta, Instant)>,
}

impl MetaCache {
    async fn get(&mut self, db: &DatabaseConnection, conversation_id: i32) -> SessionMeta {
        if let Some((meta, at)) = self.entries.get(&conversation_id) {
            if at.elapsed() < META_TTL {
                return meta.clone();
            }
        }
        let meta = session_meta(db, conversation_id).await;
        self.entries
            .insert(conversation_id, (meta.clone(), Instant::now()));
        meta
    }

    fn keep(&mut self, ids: HashSet<i32>) {
        self.entries.retain(|id, _| ids.contains(id));
    }
}

/// Events after which an item may have come or gone.
fn touches_pending(event: &AcpEvent) -> bool {
    matches!(
        event,
        AcpEvent::PermissionRequest { .. }
            | AcpEvent::PermissionResolved { .. }
            | AcpEvent::PermissionQueueDepth { .. }
            | AcpEvent::QuestionRequest { .. }
            | AcpEvent::QuestionResolved { .. }
            | AcpEvent::PlanApprovalRequest { .. }
            | AcpEvent::PlanApprovalResolved { .. }
            | AcpEvent::TurnComplete { .. }
            | AcpEvent::UserMessage { .. }
            | AcpEvent::ConversationLinked { .. }
            | AcpEvent::StatusChanged { .. }
    )
}

/// The previous run's bookkeeping. Missing or unreadable reads as none.
async fn load_stored(db: &DatabaseConnection) -> Vec<Stored> {
    match app_metadata_service::get_value(db, REMINDER_STATE_KEY).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!("[pending] unreadable reminder state ({e}); starting without");
            Vec::new()
        }),
        Ok(None) => Vec::new(),
        Err(e) => {
            tracing::warn!("[pending] failed to load the reminder state ({e})");
            Vec::new()
        }
    }
}

async fn store(db: &DatabaseConnection, stored: &[Stored]) {
    let raw = match serde_json::to_string(stored) {
        Ok(raw) => raw,
        Err(e) => {
            tracing::warn!("[pending] failed to serialize the reminder state: {e}");
            return;
        }
    };
    if let Err(e) = app_metadata_service::upsert_value(db, REMINDER_STATE_KEY, &raw).await {
        tracing::warn!("[pending] failed to store the reminder state: {e}");
    }
}

/// The dock badge (macOS; where the platform has one).
#[cfg(feature = "tauri-runtime")]
fn set_dock_badge(emitter: &EventEmitter, count: u32) {
    use tauri::Manager;
    let EventEmitter::Tauri(app) = emitter else {
        return;
    };
    let window = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    if let Some(window) = window {
        let badge = (count > 0).then_some(i64::from(count));
        if let Err(e) = window.set_badge_count(badge) {
            tracing::debug!("[pending] could not set the dock badge: {e}");
        }
    }
}

#[cfg(not(feature = "tauri-runtime"))]
fn set_dock_badge(_emitter: &EventEmitter, _count: u32) {}

/// One pass at a time over the live sessions, into the process-wide engine.
pub(crate) struct Watch {
    manager: ConnectionManager,
    db: DatabaseConnection,
    emitter: EventEmitter,
    jobs: mpsc::UnboundedSender<Vec<Job>>,
    metas: MetaCache,
    /// The count last published (the dock badge); `None` before the first.
    published: Option<u32>,
}

impl Watch {
    pub(crate) fn new(
        manager: ConnectionManager,
        db: DatabaseConnection,
        emitter: EventEmitter,
        jobs: mpsc::UnboundedSender<Vec<Job>>,
    ) -> Self {
        Self {
            manager,
            db,
            emitter,
            jobs,
            metas: MetaCache::default(),
            published: None,
        }
    }

    async fn pass(&mut self) {
        self.pass_at(Utc::now(), &presence::snapshot()).await;
    }

    /// One pass, at `now`, with `looking` (the tests' clock and presence).
    pub(crate) async fn pass_at(&mut self, now: DateTime<Utc>, looking: &Looking) {
        let mut live = Vec::new();
        for state in self.manager.session_states().await {
            let asks = {
                let s = state.read().await;
                asks_of(&s)
            };
            for ask in asks {
                let meta = self.metas.get(&self.db, ask.conversation_id).await;
                live.push((ask, meta));
            }
        }
        self.metas
            .keep(live.iter().map(|(ask, _)| ask.conversation_id).collect());
        let first = self.published.is_none();
        let (pass, snapshot, stored) = with_engine(|e| {
            let pass = e.observe(live, looking, now);
            let snapshot = (pass.list_changed || first).then(|| e.snapshot());
            (pass, snapshot, e.take_dirty())
        });
        if let Some(snapshot) = snapshot {
            set_pending_count(snapshot.count);
            if self.published != Some(snapshot.count) {
                self.published = Some(snapshot.count);
                set_dock_badge(&self.emitter, snapshot.count);
            }
            emit_event(&self.emitter, PENDING_ITEMS_EVENT, &snapshot);
        }
        for reminder in &pass.reminders {
            tracing::info!(
                "[pending] reminder {} for conversation {}",
                reminder.id,
                reminder.item.root_conversation_id
            );
            emit_event(&self.emitter, PENDING_REMINDER_EVENT, reminder);
        }
        if !pass.jobs.is_empty() && self.jobs.send(pass.jobs).is_err() {
            tracing::warn!("[pending] the delivery task is gone");
        }
        if let Some(stored) = stored {
            store(&self.db, &stored).await;
        }
    }
}

/// The watch. Subscribes to the bus synchronously (no event between spawn and
/// the first poll is lost) and returns the future to spawn — in the desktop
/// setup and in `codeg-server`, next to the critical watchdog.
pub fn pending_watch_task(
    bus: Arc<InternalEventBus>,
    manager: ConnectionManager,
    db: DatabaseConnection,
    emitter: EventEmitter,
) -> impl Future<Output = ()> + Send + 'static {
    let mut rx = bus.subscribe();
    tracing::Instrument::instrument(async move {
        let settings = load_reminder_settings(&db).await.effective();
        let stored = load_stored(&db).await;
        let now = Utc::now();
        with_engine(|e| {
            e.set_settings(settings);
            e.load(stored, now);
        });
        let (jobs, jobs_rx) = mpsc::unbounded_channel();
        tokio::spawn(deliver_jobs(ApnsSink { db: db.clone() }, jobs_rx));
        let mut watch = Watch::new(manager, db, emitter, jobs);
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Ok(envelope) => {
                        if !touches_pending(&envelope.payload) {
                            continue;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = tick.tick() => {}
            }
            watch.pass().await;
        }
    }, tracing::info_span!("bg", task = "pending-watch"))
}
