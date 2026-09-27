use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::sync::CancellationToken;

pub const WORKSPACE_TRANSFER_PROGRESS_EVENT: &str = "workspace://transfer-progress";

const DOWNLOAD_TICKET_TTL_SECS: u64 = 60;
const DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY: usize = 4;
const DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY: usize = 2;
const DEFAULT_WORKSPACE_ZIP_CONCURRENCY: usize = 2;
const DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY: usize = 2;
const DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS: u64 = 300;
/// A media capability dies after this long without a request. Players fetch
/// continuously while playing, so this only runs out on a preview left paused
/// (the viewer mints a fresh one when that happens).
const MEDIA_CAPABILITY_IDLE_TTL_SECS: u64 = 15 * 60;
/// Hard ceiling on a media capability, however busy it is.
const MEDIA_CAPABILITY_MAX_LIFETIME_SECS: u64 = 8 * 60 * 60;
/// Live media capabilities kept at once; the oldest is dropped past this.
const MEDIA_CAPABILITY_MAX_LIVE: usize = 256;
/// Client-chosen transfer ids are accepted only in this shape.
const MAX_CLIENT_TRANSFER_ID_LEN: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DownloadKind {
    File,
    Dir,
}

#[derive(Clone, Debug)]
pub struct DownloadTicketSpec {
    pub root_path: PathBuf,
    pub target_path: PathBuf,
    pub relative_path: String,
    pub kind: DownloadKind,
    pub filename: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTicketIssued {
    pub ticket: String,
    pub url: String,
    pub filename: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug)]
pub struct DownloadTicket {
    pub root_path: PathBuf,
    pub target_path: PathBuf,
    pub relative_path: String,
    pub kind: DownloadKind,
    pub filename: String,
    pub expires_at: Instant,
}

/// One file a `<video>` element may stream, and how long it may do so.
#[derive(Clone, Debug)]
pub struct MediaCapability {
    pub root_path: PathBuf,
    pub relative_path: String,
    pub filename: String,
    issued_at: Instant,
    idle_deadline: Instant,
    hard_deadline: Instant,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTransferProgress {
    pub transfer_id: String,
    pub direction: TransferDirection,
    pub loaded: u64,
    pub total: Option<u64>,
    pub state: TransferState,
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Running,
    Done,
    Cancelled,
    Error,
}

pub struct WorkspaceTransferManager {
    tickets: Mutex<HashMap<String, DownloadTicket>>,
    cancels: Mutex<HashMap<String, CancellationToken>>,
    media_caps: Mutex<HashMap<String, MediaCapability>>,
    ticket_ttl: Duration,
    media_idle_ttl: Duration,
    media_max_lifetime: Duration,
    pub workspace_upload_semaphore: Semaphore,
    pub remote_upload_semaphore: Semaphore,
    pub zip_semaphore: Semaphore,
    pub remote_download_semaphore: Semaphore,
    pub idle_timeout: Duration,
}

impl WorkspaceTransferManager {
    pub fn new_from_env() -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            media_caps: Mutex::new(HashMap::new()),
            ticket_ttl: Duration::from_secs(DOWNLOAD_TICKET_TTL_SECS),
            media_idle_ttl: Duration::from_secs(MEDIA_CAPABILITY_IDLE_TTL_SECS),
            media_max_lifetime: Duration::from_secs(MEDIA_CAPABILITY_MAX_LIFETIME_SECS),
            workspace_upload_semaphore: Semaphore::new(env_usize(
                "CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
                DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY,
            )),
            remote_upload_semaphore: Semaphore::new(env_usize(
                "CODEG_REMOTE_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
                DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY,
            )),
            zip_semaphore: Semaphore::new(env_usize(
                "CODEG_WORKSPACE_ZIP_MAX_CONCURRENCY",
                DEFAULT_WORKSPACE_ZIP_CONCURRENCY,
            )),
            remote_download_semaphore: Semaphore::new(env_usize(
                "CODEG_REMOTE_WORKSPACE_DOWNLOAD_MAX_CONCURRENCY",
                DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY,
            )),
            idle_timeout: env_duration_secs(
                "CODEG_WORKSPACE_TRANSFER_IDLE_TIMEOUT_SECS",
                DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS,
            ),
        }
    }

    pub fn new_for_tests(ticket_ttl: Duration) -> Self {
        Self {
            tickets: Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            media_caps: Mutex::new(HashMap::new()),
            ticket_ttl,
            media_idle_ttl: Duration::from_secs(MEDIA_CAPABILITY_IDLE_TTL_SECS),
            media_max_lifetime: Duration::from_secs(MEDIA_CAPABILITY_MAX_LIFETIME_SECS),
            workspace_upload_semaphore: Semaphore::new(DEFAULT_WORKSPACE_UPLOAD_CONCURRENCY),
            remote_upload_semaphore: Semaphore::new(DEFAULT_REMOTE_WORKSPACE_UPLOAD_CONCURRENCY),
            zip_semaphore: Semaphore::new(DEFAULT_WORKSPACE_ZIP_CONCURRENCY),
            remote_download_semaphore: Semaphore::new(
                DEFAULT_REMOTE_WORKSPACE_DOWNLOAD_CONCURRENCY,
            ),
            idle_timeout: Duration::from_secs(DEFAULT_TRANSFER_IDLE_TIMEOUT_SECS),
        }
    }

    /// Test hook: shorten the media capability lifetimes.
    #[cfg(test)]
    pub fn with_media_ttl(mut self, idle: Duration, max_lifetime: Duration) -> Self {
        self.media_idle_ttl = idle;
        self.media_max_lifetime = max_lifetime;
        self
    }

    pub async fn register_transfer(&self) -> (String, CancellationToken) {
        self.register_transfer_with_id(None).await
    }

    /// Register a transfer under the id the client picked, so the UI can show
    /// (and cancel) it before the first progress event arrives. A missing,
    /// malformed or already-live id falls back to a fresh server-side one.
    pub async fn register_transfer_with_id(
        &self,
        requested: Option<String>,
    ) -> (String, CancellationToken) {
        let token = CancellationToken::new();
        let mut cancels = self.cancels.lock().await;
        let transfer_id = requested
            .filter(|id| is_valid_client_transfer_id(id) && !cancels.contains_key(id))
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        cancels.insert(transfer_id.clone(), token.clone());
        (transfer_id, token)
    }

    pub async fn finish_transfer(&self, transfer_id: &str) {
        self.cancels.lock().await.remove(transfer_id);
    }

    pub async fn cancel(&self, transfer_id: &str) -> bool {
        let token = self.cancels.lock().await.remove(transfer_id);
        if let Some(token) = token {
            token.cancel();
            true
        } else {
            false
        }
    }

    pub async fn issue_download_ticket(&self, spec: DownloadTicketSpec) -> DownloadTicketIssued {
        self.cleanup_expired_tickets().await;

        let ticket = uuid::Uuid::new_v4().simple().to_string();
        let expires_at_instant = Instant::now() + self.ticket_ttl;
        let expires_at = SystemTime::now()
            .checked_add(self.ticket_ttl)
            .unwrap_or(SystemTime::now())
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        self.tickets.lock().await.insert(
            ticket.clone(),
            DownloadTicket {
                root_path: spec.root_path,
                target_path: spec.target_path,
                relative_path: spec.relative_path,
                kind: spec.kind,
                filename: spec.filename.clone(),
                expires_at: expires_at_instant,
            },
        );

        DownloadTicketIssued {
            url: ticket.clone(),
            ticket,
            filename: spec.filename,
            expires_at,
        }
    }

    pub async fn consume_download_ticket(&self, ticket: &str) -> Option<DownloadTicket> {
        self.cleanup_expired_tickets().await;
        let found = self.tickets.lock().await.remove(ticket);
        found.filter(|ticket| Instant::now() <= ticket.expires_at)
    }

    /// Mint a capability for streaming one file. The caller has already
    /// validated `root_path`/`relative_path` with the download path rules;
    /// the byte endpoint re-validates them on every request anyway.
    pub async fn issue_media_capability(
        &self,
        root_path: PathBuf,
        relative_path: String,
        filename: String,
    ) -> String {
        let now = Instant::now();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mut caps = self.media_caps.lock().await;
        caps.retain(|_, cap| cap.is_live(now));
        if caps.len() >= MEDIA_CAPABILITY_MAX_LIVE {
            let oldest = caps
                .iter()
                .min_by_key(|(_, cap)| cap.issued_at)
                .map(|(key, _)| key.clone());
            if let Some(oldest) = oldest {
                caps.remove(&oldest);
            }
        }
        caps.insert(
            token.clone(),
            MediaCapability {
                root_path,
                relative_path,
                filename,
                issued_at: now,
                idle_deadline: now + self.media_idle_ttl,
                hard_deadline: now + self.media_max_lifetime,
            },
        );
        token
    }

    /// Look up a live capability and push its idle deadline out. Unlike a
    /// download ticket it is not consumed: a player issues many range
    /// requests over the life of one preview.
    pub async fn resolve_media_capability(&self, token: &str) -> Option<MediaCapability> {
        let now = Instant::now();
        let idle_ttl = self.media_idle_ttl;
        let mut caps = self.media_caps.lock().await;
        let live = caps.get(token).is_some_and(|cap| cap.is_live(now));
        if !live {
            caps.remove(token);
            return None;
        }
        caps.get_mut(token).map(|cap| {
            cap.idle_deadline = (now + idle_ttl).min(cap.hard_deadline);
            cap.clone()
        })
    }

    pub async fn revoke_media_capability(&self, token: &str) -> bool {
        self.media_caps.lock().await.remove(token).is_some()
    }

    /// Seconds a freshly minted capability stays valid without being used.
    pub fn media_idle_ttl_secs(&self) -> u64 {
        self.media_idle_ttl.as_secs()
    }

    pub async fn cleanup_expired_tickets(&self) {
        let now = Instant::now();
        self.tickets
            .lock()
            .await
            .retain(|_, ticket| ticket.expires_at > now);
    }
}

impl MediaCapability {
    fn is_live(&self, now: Instant) -> bool {
        now <= self.idle_deadline && now <= self.hard_deadline
    }
}

fn is_valid_client_transfer_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_CLIENT_TRANSFER_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default)
}

pub fn env_duration_secs(name: &str, default_secs: u64) -> Duration {
    Duration::from_secs(
        std::env::var(name)
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(default_secs),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    #[test]
    fn env_usize_uses_default_for_missing_invalid_and_zero() {
        temp_env::with_var_unset("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", || {
            assert_eq!(env_usize("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
        });
        temp_env::with_var(
            "CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY",
            Some("nope"),
            || {
                assert_eq!(env_usize("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
            },
        );
        temp_env::with_var("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", Some("0"), || {
            assert_eq!(env_usize("CODEG_WORKSPACE_UPLOAD_MAX_CONCURRENCY", 4), 4);
        });
    }

    #[tokio::test]
    async fn ticket_is_single_use_and_expires() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_millis(20));
        let ticket = manager
            .issue_download_ticket(DownloadTicketSpec {
                root_path: PathBuf::from("/tmp/root"),
                target_path: PathBuf::from("/tmp/root/file.txt"),
                relative_path: "file.txt".to_string(),
                kind: DownloadKind::File,
                filename: "file.txt".to_string(),
            })
            .await;
        assert!(manager
            .consume_download_ticket(&ticket.ticket)
            .await
            .is_some());
        assert!(manager
            .consume_download_ticket(&ticket.ticket)
            .await
            .is_none());

        let expired = manager
            .issue_download_ticket(DownloadTicketSpec {
                root_path: PathBuf::from("/tmp/root"),
                target_path: PathBuf::from("/tmp/root/old.txt"),
                relative_path: "old.txt".to_string(),
                kind: DownloadKind::File,
                filename: "old.txt".to_string(),
            })
            .await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(manager
            .consume_download_ticket(&expired.ticket)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn client_transfer_id_is_used_when_well_formed_and_free() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_secs(60));
        let (id, _) = manager
            .register_transfer_with_id(Some("dl-abc_123".to_string()))
            .await;
        assert_eq!(id, "dl-abc_123");
        // Already live: a second registration gets its own id.
        let (dup, _) = manager
            .register_transfer_with_id(Some("dl-abc_123".to_string()))
            .await;
        assert_ne!(dup, "dl-abc_123");
        // Malformed ids never become map keys.
        let (bad, _) = manager
            .register_transfer_with_id(Some("../x".to_string()))
            .await;
        assert_ne!(bad, "../x");
        let (long, _) = manager
            .register_transfer_with_id(Some("a".repeat(65)))
            .await;
        assert_eq!(long.len(), 32);
        assert!(manager.cancel("dl-abc_123").await);
    }

    #[tokio::test]
    async fn media_capability_is_reusable_until_idle_or_revoked() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_secs(60))
            .with_media_ttl(Duration::from_millis(400), Duration::from_secs(60));
        let token = manager
            .issue_media_capability(
                PathBuf::from("/tmp/root"),
                "clip.mp4".to_string(),
                "clip.mp4".to_string(),
            )
            .await;
        // Many range requests share one capability.
        for _ in 0..3 {
            let cap = manager.resolve_media_capability(&token).await.unwrap();
            assert_eq!(cap.relative_path, "clip.mp4");
        }
        // Use keeps it alive past the idle window.
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(manager.resolve_media_capability(&token).await.is_some());
        tokio::time::sleep(Duration::from_millis(250)).await;
        assert!(manager.resolve_media_capability(&token).await.is_some());
        // Left idle, it expires.
        tokio::time::sleep(Duration::from_millis(600)).await;
        assert!(manager.resolve_media_capability(&token).await.is_none());

        let revoked = manager
            .issue_media_capability(
                PathBuf::from("/tmp/root"),
                "b.mp4".to_string(),
                "b.mp4".to_string(),
            )
            .await;
        assert!(manager.revoke_media_capability(&revoked).await);
        assert!(manager.resolve_media_capability(&revoked).await.is_none());
        assert!(manager.resolve_media_capability("unknown").await.is_none());
    }

    #[tokio::test]
    async fn media_capability_has_a_hard_lifetime() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_secs(60))
            .with_media_ttl(Duration::from_secs(60), Duration::from_millis(30));
        let token = manager
            .issue_media_capability(
                PathBuf::from("/tmp/root"),
                "clip.mp4".to_string(),
                "clip.mp4".to_string(),
            )
            .await;
        assert!(manager.resolve_media_capability(&token).await.is_some());
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(manager.resolve_media_capability(&token).await.is_none());
    }

    #[tokio::test]
    async fn cancel_marks_token_and_removes_entry() {
        let manager = WorkspaceTransferManager::new_for_tests(Duration::from_secs(60));
        let (id, token) = manager.register_transfer().await;
        assert!(!token.is_cancelled());
        assert!(manager.cancel(&id).await);
        assert!(token.is_cancelled());
        assert!(!manager.cancel(&id).await);
    }
}
