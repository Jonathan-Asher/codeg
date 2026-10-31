//! Talk's speech models on this Mac: one [`ModelStore`] per pack, under
//! `<data dir>/talk/<pack id>/`, downloaded on request and checked file by
//! file against the pinned checksums (see [`super::catalog`]). Nothing
//! downloads until someone asks; a pack's progress shows in [`TalkModels::status`].

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tokio_util::sync::CancellationToken;

use super::catalog::ModelPack;
use crate::tts::store::{ModelStore, Progress, StoreError};
use crate::tts::DownloadState;

/// One pack as the settings show it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackStatus {
    pub id: String,
    pub title: String,
    pub required: bool,
    pub recommended: bool,
    /// Every file is on disk and verified.
    pub installed: bool,
    pub download: DownloadState,
    pub pack_bytes: u64,
    /// What of it is on disk now (partial files included).
    pub bytes_on_disk: u64,
    pub dir: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TalkModelsStatus {
    pub packs: Vec<PackStatus>,
    /// Every required pack is installed: Talk can start.
    pub ready: bool,
    /// The catalog could not be read (a bad `CODEG_TALK_CATALOG`).
    pub catalog_error: Option<String>,
    pub dir: String,
}

#[derive(Debug, thiserror::Error)]
pub enum ModelsError {
    #[error("{0}")]
    Catalog(String),
    #[error("unknown model pack {0:?}")]
    UnknownPack(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

/// Told the new status whenever a pack starts or stops downloading, or is
/// deleted, so every window learns about it without asking.
pub type ModelsListener = Arc<dyn Fn(TalkModelsStatus) + Send + Sync>;

struct PackSlot {
    pack: ModelPack,
    store: ModelStore,
    download: Mutex<DownloadState>,
    cancel: Mutex<Option<CancellationToken>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl PackSlot {
    fn status(&self) -> PackStatus {
        PackStatus {
            id: self.pack.id.clone(),
            title: self.pack.title.clone(),
            required: self.pack.required,
            recommended: self.pack.recommended,
            installed: self.store.is_installed(),
            download: self.download.lock().unwrap().clone(),
            pack_bytes: self.store.total_bytes(),
            bytes_on_disk: self.store.bytes_on_disk(),
            dir: self.store.dir().display().to_string(),
        }
    }
}

pub struct TalkModels {
    root: PathBuf,
    packs: Vec<Arc<PackSlot>>,
    catalog_error: Option<String>,
    http: OnceLock<reqwest::Client>,
    listener: OnceLock<ModelsListener>,
}

impl TalkModels {
    /// The packs of `catalog`, each in `root/<pack id>`.
    pub fn new(root: PathBuf, catalog: Result<Vec<ModelPack>, String>) -> Self {
        let (packs, catalog_error) = match catalog {
            Ok(packs) => (
                packs
                    .into_iter()
                    .map(|pack| {
                        let store = ModelStore::new(root.join(&pack.id), pack.files.clone());
                        Arc::new(PackSlot {
                            pack,
                            store,
                            download: Mutex::new(DownloadState::Idle),
                            cancel: Mutex::new(None),
                            task: Mutex::new(None),
                        })
                    })
                    .collect(),
                None,
            ),
            Err(e) => (Vec::new(), Some(e)),
        };
        Self {
            root,
            packs,
            catalog_error,
            http: OnceLock::new(),
            listener: OnceLock::new(),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Who hears about changes. The first listener stays.
    pub fn on_change(&self, listener: impl FnOnce() -> ModelsListener) {
        self.listener.get_or_init(listener);
    }

    fn announce(&self) {
        if let Some(listener) = self.listener.get() {
            listener(self.status());
        }
    }

    fn http(&self) -> &reqwest::Client {
        self.http.get_or_init(|| {
            reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(120))
                .user_agent(concat!("codeg/", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default()
        })
    }

    pub fn status(&self) -> TalkModelsStatus {
        let packs: Vec<PackStatus> = self.packs.iter().map(|slot| slot.status()).collect();
        let ready = self.catalog_error.is_none()
            && packs.iter().filter(|p| p.required).all(|p| p.installed);
        TalkModelsStatus {
            packs,
            ready,
            catalog_error: self.catalog_error.clone(),
            dir: self.root.display().to_string(),
        }
    }

    /// Every required pack is installed.
    pub fn ready(&self) -> bool {
        self.catalog_error.is_none()
            && self
                .packs
                .iter()
                .filter(|slot| slot.pack.required)
                .all(|slot| slot.store.is_installed())
    }

    /// The installed packs' directories, by pack id.
    pub fn installed_dirs(&self) -> BTreeMap<String, String> {
        self.packs
            .iter()
            .filter(|slot| slot.store.is_installed())
            .map(|slot| (slot.pack.id.clone(), slot.store.dir().display().to_string()))
            .collect()
    }

    /// The packs `ids` names; every required pack when it names none.
    fn select(
        &self,
        ids: &[String],
        all_when_empty: bool,
    ) -> Result<Vec<Arc<PackSlot>>, ModelsError> {
        if let Some(e) = &self.catalog_error {
            return Err(ModelsError::Catalog(e.clone()));
        }
        if ids.is_empty() {
            return Ok(self
                .packs
                .iter()
                .filter(|slot| all_when_empty || slot.pack.required)
                .cloned()
                .collect());
        }
        ids.iter()
            .map(|id| {
                self.packs
                    .iter()
                    .find(|slot| &slot.pack.id == id)
                    .cloned()
                    .ok_or_else(|| ModelsError::UnknownPack(id.clone()))
            })
            .collect()
    }

    /// Start downloading the packs `ids` names (the required ones when it
    /// names none), each in the background. A pack already installed or
    /// downloading is left alone.
    pub fn start_download(
        self: &Arc<Self>,
        ids: &[String],
    ) -> Result<TalkModelsStatus, ModelsError> {
        let slots = self.select(ids, false)?;
        let mut started = false;
        for slot in slots {
            {
                let mut state = slot.download.lock().unwrap();
                if matches!(*state, DownloadState::Downloading { .. }) || slot.store.is_installed()
                {
                    continue;
                }
                *state = DownloadState::Downloading {
                    bytes_done: slot.store.bytes_on_disk(),
                    bytes_total: slot.store.total_bytes(),
                };
            }
            started = true;
            let token = CancellationToken::new();
            *slot.cancel.lock().unwrap() = Some(token.clone());
            let this = self.clone();
            let task_slot = slot.clone();
            let task = tokio::spawn(async move {
                let slot = task_slot;
                let progress = |p: Progress| {
                    *slot.download.lock().unwrap() = DownloadState::Downloading {
                        bytes_done: p.bytes_done,
                        bytes_total: p.bytes_total,
                    };
                };
                let next = match slot.store.download(this.http(), &token, &progress).await {
                    Ok(()) => {
                        tracing::info!("[talk-voice] model pack {} downloaded", slot.pack.id);
                        DownloadState::Idle
                    }
                    Err(StoreError::Cancelled) => DownloadState::Idle,
                    Err(e) => {
                        tracing::warn!("[talk-voice] model pack {} failed: {e}", slot.pack.id);
                        DownloadState::Failed {
                            message: e.to_string(),
                        }
                    }
                };
                *slot.download.lock().unwrap() = next;
                slot.cancel.lock().unwrap().take();
                this.announce();
            });
            *slot.task.lock().unwrap() = Some(task);
        }
        if started {
            self.announce();
        }
        Ok(self.status())
    }

    /// Stop the downloads of `ids` (all when it names none); what arrived
    /// stays on disk for the next attempt.
    pub async fn cancel_download(&self, ids: &[String]) -> Result<TalkModelsStatus, ModelsError> {
        let slots = self.select(ids, true)?;
        for slot in slots {
            if let Some(token) = slot.cancel.lock().unwrap().take() {
                token.cancel();
            }
            let task = slot.task.lock().unwrap().take();
            if let Some(task) = task {
                let _ = task.await;
            }
            let mut state = slot.download.lock().unwrap();
            if matches!(*state, DownloadState::Downloading { .. }) {
                *state = DownloadState::Idle;
            }
        }
        self.announce();
        Ok(self.status())
    }

    /// Remove the packs `ids` names (all when it names none), partial files
    /// included.
    pub async fn delete(&self, ids: &[String]) -> Result<TalkModelsStatus, ModelsError> {
        let slots = self.select(ids, true)?;
        let ids: Vec<String> = slots.iter().map(|s| s.pack.id.clone()).collect();
        self.cancel_download(&ids).await?;
        for slot in slots {
            slot.store.delete()?;
            *slot.download.lock().unwrap() = DownloadState::Idle;
        }
        self.announce();
        Ok(self.status())
    }
}

#[cfg(test)]
impl TalkModels {
    /// Lay out the packs `ids` names as installed placeholders.
    pub(crate) fn install_placeholders_for_tests(&self, ids: &[&str]) {
        for slot in &self.packs {
            if ids.contains(&slot.pack.id.as_str()) {
                slot.store.install_placeholder_for_tests();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::talk::voice::catalog::{self, SMART_TURN, WHISPER, ZIPFORMER};
    use crate::tts::catalog::ModelFile;

    fn tiny_pack(id: &str, required: bool) -> ModelPack {
        ModelPack {
            id: id.to_string(),
            title: id.to_string(),
            required,
            recommended: true,
            files: vec![ModelFile {
                path: format!("{id}.bin"),
                url: "https://example.invalid/x".into(),
                size: 4,
                sha256: "0".repeat(64),
            }],
        }
    }

    #[test]
    fn talk_is_ready_once_every_required_pack_is_installed() {
        let dir = tempfile::tempdir().unwrap();
        let models = TalkModels::new(dir.path().to_path_buf(), Ok(catalog::builtin()));
        assert!(!models.ready());
        assert!(!models.status().ready);
        models.install_placeholders_for_tests(&[ZIPFORMER]);
        assert!(!models.ready(), "Smart Turn is required too");
        models.install_placeholders_for_tests(&[SMART_TURN]);
        assert!(models.ready(), "whisper is optional");
        let status = models.status();
        assert!(status.ready);
        let whisper = status.packs.iter().find(|p| p.id == WHISPER).unwrap();
        assert!(!whisper.installed && !whisper.required && whisper.recommended);
        let dirs = models.installed_dirs();
        assert_eq!(dirs.len(), 2);
        assert!(dirs[ZIPFORMER].ends_with(ZIPFORMER));
        assert_eq!(
            Path::new(&dirs[SMART_TURN]),
            dir.path().join(SMART_TURN).as_path()
        );
    }

    #[test]
    fn each_pack_lives_in_its_own_directory() {
        let dir = tempfile::tempdir().unwrap();
        let models = TalkModels::new(dir.path().to_path_buf(), Ok(catalog::builtin()));
        let status = models.status();
        assert_eq!(status.packs.len(), 3);
        for pack in &status.packs {
            assert_eq!(Path::new(&pack.dir), dir.path().join(&pack.id).as_path());
            assert_eq!(pack.download, DownloadState::Idle);
        }
    }

    #[tokio::test]
    async fn deleting_a_pack_removes_only_that_pack() {
        let dir = tempfile::tempdir().unwrap();
        let models = TalkModels::new(
            dir.path().to_path_buf(),
            Ok(vec![tiny_pack("a", true), tiny_pack("b", false)]),
        );
        models.install_placeholders_for_tests(&["a", "b"]);
        assert!(models.ready());
        let status = models.delete(&["b".to_string()]).await.unwrap();
        assert!(status.packs.iter().find(|p| p.id == "a").unwrap().installed);
        assert!(!status.packs.iter().find(|p| p.id == "b").unwrap().installed);
        assert!(!dir.path().join("b").exists());
        let status = models.delete(&[]).await.unwrap();
        assert!(!status.ready);
    }

    #[tokio::test]
    async fn an_unknown_pack_or_a_bad_catalog_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let models = Arc::new(TalkModels::new(
            dir.path().to_path_buf(),
            Ok(vec![tiny_pack("a", true)]),
        ));
        assert!(matches!(
            models.start_download(&["nope".to_string()]),
            Err(ModelsError::UnknownPack(_))
        ));
        let broken = Arc::new(TalkModels::new(
            dir.path().to_path_buf(),
            Err("bad catalog".into()),
        ));
        assert!(!broken.ready());
        assert_eq!(
            broken.status().catalog_error.as_deref(),
            Some("bad catalog")
        );
        assert!(matches!(
            broken.start_download(&[]),
            Err(ModelsError::Catalog(_))
        ));
    }

    #[tokio::test]
    async fn an_installed_pack_is_not_downloaded_again() {
        let dir = tempfile::tempdir().unwrap();
        let models = Arc::new(TalkModels::new(
            dir.path().to_path_buf(),
            Ok(vec![tiny_pack("a", true)]),
        ));
        models.install_placeholders_for_tests(&["a"]);
        let announced = Arc::new(Mutex::new(0));
        let count = announced.clone();
        models.on_change(|| Arc::new(move |_| *count.lock().unwrap() += 1));
        let status = models.start_download(&[]).unwrap();
        assert_eq!(status.packs[0].download, DownloadState::Idle);
        assert_eq!(*announced.lock().unwrap(), 0, "nothing started");
    }
}
