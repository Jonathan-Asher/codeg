//! Learning what waits on the user on each saved remote connection, whether
//! or not its workspace window is open: a small authenticated poll of the
//! server's `list_pending_items` (an in-memory snapshot there, no database
//! read), every few seconds while it answers and backing off while it does
//! not. When the connection's window is open, its event socket's
//! `app://pending-items` frames are applied as they arrive as well
//! ([`Remotes::apply_frame`]), so answering in that window clears the badge
//! at once instead of at the next poll.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::model::{RemoteSnapshot, RemoteSource, WaitingItem};
use crate::models::{RemoteWorkspaceHeader, ToHeaderMap};

/// How often a server that answers is asked.
pub const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// The longest wait between two tries at a server that does not answer.
pub const MAX_BACKOFF: Duration = Duration::from_secs(60);
/// How long one request may take.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Failed polls in a row after which a server's last answer stops counting:
/// a blip keeps the badge steady, a server gone for good (about 35 s at the
/// backoff below) no longer claims sessions nobody can open.
pub const STALE_AFTER_FAILURES: u32 = 3;

/// The wait before the next poll after `failures` failed polls in a row:
/// the interval while it answers, then doubling up to [`MAX_BACKOFF`].
pub fn retry_delay(failures: u32) -> Duration {
    if failures == 0 {
        return POLL_INTERVAL;
    }
    let factor = 1u64 << failures.min(6);
    Duration::from_secs(POLL_INTERVAL.as_secs().saturating_mul(factor)).min(MAX_BACKOFF)
}

/// What a saved connection needs to be asked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteTarget {
    pub connection_id: i32,
    pub name: String,
    pub base_url: String,
    pub token: String,
    pub headers: Vec<RemoteWorkspaceHeader>,
    /// What its server said it is, when it did.
    pub instance_id: Option<String>,
}

impl RemoteTarget {
    /// The same server with the same credentials: its poll state carries over
    /// a reload of the saved connections.
    fn same_endpoint(&self, other: &RemoteTarget) -> bool {
        self.base_url == other.base_url
            && self.token == other.token
            && self.headers == other.headers
    }
}

#[derive(Debug)]
pub enum FetchError {
    /// No answer: offline, asleep, refused, timed out.
    Unreachable(String),
    /// The token was refused.
    Unauthorized,
    /// Any other HTTP error (a server from before the list answers 404).
    Status(u16),
    /// An answer that is not the list.
    Malformed(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FetchError::Unreachable(detail) => write!(f, "unreachable: {detail}"),
            FetchError::Unauthorized => f.write_str("the token was refused"),
            FetchError::Status(status) => write!(f, "HTTP {status}"),
            FetchError::Malformed(detail) => write!(f, "not a pending list: {detail}"),
        }
    }
}

/// One poll: `POST {base}/api/list_pending_items` with the connection's
/// token and custom headers.
pub async fn fetch_pending(
    client: &reqwest::Client,
    target: &RemoteTarget,
) -> Result<Vec<WaitingItem>, FetchError> {
    let url = format!(
        "{}/api/list_pending_items",
        target.base_url.trim().trim_end_matches('/')
    );
    let response = client
        .post(url)
        .bearer_auth(target.token.trim())
        .headers(target.headers.to_header_map())
        .json(&serde_json::json!({}))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| FetchError::Unreachable(e.to_string()))?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(FetchError::Unauthorized);
    }
    if !status.is_success() {
        return Err(FetchError::Status(status.as_u16()));
    }
    response
        .json::<RemoteSnapshot>()
        .await
        .map(|snapshot| snapshot.items)
        .map_err(|e| FetchError::Malformed(e.to_string()))
}

#[derive(Debug, Clone)]
struct Slot {
    target: RemoteTarget,
    items: Vec<WaitingItem>,
    failures: u32,
    next_poll: Instant,
    /// The generation of the poll that is out, if one is.
    in_flight: Option<u64>,
    /// Bumped by every answer applied; a poll that started before the last
    /// one carries an older value and is dropped (see [`Remotes::apply_poll`]).
    generation: u64,
}

/// A poll to run: which connection, and the generation it started at.
#[derive(Debug, Clone)]
pub struct DuePoll {
    pub target: RemoteTarget,
    pub generation: u64,
}

/// Every saved connection's poll state and last answer, in the saved order.
#[derive(Debug, Default)]
pub struct Remotes {
    order: Vec<i32>,
    slots: HashMap<i32, Slot>,
}

impl Remotes {
    /// Take the saved connections as they are now. A connection that still
    /// points where it did keeps its state; a new or changed one is polled at
    /// once; a deleted one is forgotten. Whether anything shown changed.
    pub fn sync(&mut self, targets: Vec<RemoteTarget>, now: Instant) -> bool {
        let mut changed = false;
        let order: Vec<i32> = targets.iter().map(|t| t.connection_id).collect();
        let mut slots = HashMap::with_capacity(targets.len());
        for target in targets {
            let slot = match self.slots.remove(&target.connection_id) {
                Some(mut slot) if slot.target.same_endpoint(&target) => {
                    if slot.target.name != target.name
                        || slot.target.instance_id != target.instance_id
                    {
                        changed |= !slot.items.is_empty();
                    }
                    slot.target = target;
                    slot
                }
                previous => {
                    changed |= previous.as_ref().is_some_and(|slot| !slot.items.is_empty());
                    Slot {
                        target,
                        items: Vec::new(),
                        failures: 0,
                        next_poll: now,
                        in_flight: None,
                        // Past the old endpoint's: a poll of it still out
                        // must not land on the new one.
                        generation: previous.map_or(0, |slot| slot.generation + 1),
                    }
                }
            };
            slots.insert(slot.target.connection_id, slot);
        }
        changed |= self.slots.values().any(|slot| !slot.items.is_empty());
        changed |= order != self.order;
        self.order = order;
        self.slots = slots;
        changed
    }

    /// The polls due at `now`, marked in flight.
    pub fn take_due(&mut self, now: Instant) -> Vec<DuePoll> {
        let mut due = Vec::new();
        for id in &self.order {
            if let Some(slot) = self.slots.get_mut(id) {
                if slot.in_flight.is_none() && slot.next_poll <= now {
                    slot.in_flight = Some(slot.generation);
                    due.push(DuePoll {
                        target: slot.target.clone(),
                        generation: slot.generation,
                    });
                }
            }
        }
        due
    }

    /// When the next poll is due; `None` with no saved connection.
    pub fn next_due(&self) -> Option<Instant> {
        self.slots
            .values()
            .filter(|slot| slot.in_flight.is_none())
            .map(|slot| slot.next_poll)
            .min()
    }

    /// Apply a poll's outcome. Whether what is shown changed.
    pub fn apply_poll(
        &mut self,
        connection_id: i32,
        generation: u64,
        result: Result<Vec<WaitingItem>, FetchError>,
        now: Instant,
    ) -> bool {
        let Some(slot) = self.slots.get_mut(&connection_id) else {
            return false;
        };
        if slot.in_flight == Some(generation) {
            slot.in_flight = None;
        }
        if generation != slot.generation {
            // A frame landed while this poll was out (its answer predates
            // it), or the connection now points elsewhere (it asked the old
            // address). Polled again on schedule, unless a poll of the new
            // address is out already.
            if slot.in_flight.is_none() {
                slot.next_poll = now + POLL_INTERVAL;
            }
            return false;
        }
        match result {
            Ok(items) => {
                slot.failures = 0;
                slot.next_poll = now + POLL_INTERVAL;
                slot.generation += 1;
                let changed = slot.items != items;
                slot.items = items;
                changed
            }
            Err(err) => {
                slot.failures = slot.failures.saturating_add(1);
                slot.next_poll = now + retry_delay(slot.failures);
                if slot.failures == 1 || slot.failures == STALE_AFTER_FAILURES {
                    tracing::info!(
                        "[attention] {} ({connection_id}) did not answer ({} in a row): {err}",
                        slot.target.name,
                        slot.failures
                    );
                }
                if slot.failures >= STALE_AFTER_FAILURES && !slot.items.is_empty() {
                    slot.items.clear();
                    return true;
                }
                false
            }
        }
    }

    /// Apply the list a connection's event socket carried
    /// (`app://pending-items`): an answer as good as a poll's, and newer than
    /// any poll in flight. Whether what is shown changed.
    pub fn apply_frame(
        &mut self,
        connection_id: i32,
        items: Vec<WaitingItem>,
        now: Instant,
    ) -> bool {
        let Some(slot) = self.slots.get_mut(&connection_id) else {
            return false;
        };
        slot.failures = 0;
        slot.generation += 1;
        if slot.in_flight.is_none() {
            slot.next_poll = now + POLL_INTERVAL;
        }
        let changed = slot.items != items;
        slot.items = items;
        changed
    }

    /// What each connection's server last said, in the saved order.
    pub fn sources(&self) -> Vec<RemoteSource> {
        self.order
            .iter()
            .filter_map(|id| self.slots.get(id))
            .map(|slot| RemoteSource {
                connection_id: slot.target.connection_id,
                name: slot.target.name.clone(),
                instance_id: slot.target.instance_id.clone(),
                items: slot.items.clone(),
            })
            .collect()
    }
}

/// The client every poll goes through: the same redirect pinning as the
/// remote proxy's requests (a connection's custom headers are credentials
/// and must stay on its host).
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(REQUEST_TIMEOUT)
        .redirect(crate::commands::remote_proxy::connection_redirect_policy())
        .build()
        .unwrap_or_else(|e| {
            tracing::warn!("[attention] default HTTP client ({e})");
            reqwest::Client::new()
        })
}
