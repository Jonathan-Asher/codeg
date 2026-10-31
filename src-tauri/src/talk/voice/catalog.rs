//! The speech models Talk on this Mac downloads: the iPhone app's packs, with
//! the same files, URLs and checksums as codeg-ios
//! `CodegiOS/Resources/stt-models.json` (release `models-v2`), so the Mac
//! hears with exactly the models the phone does. `testdata/stt-models.json` is
//! a copy of that file (codeg-ios 74eefd4); a test keeps the two in step.
//!
//! - `he-zipformer-stream` (required, ~73 MB): the ivrit.ai streaming
//!   Zipformer that transcribes as you speak, with the Silero voice detector;
//! - `smart-turn-v3.2` (required, ~8.7 MB): end-of-turn detection;
//! - `he-turbo` (optional, recommended on a Mac, ~919 MB): the ivrit.ai
//!   whisper for the final transcript, better with English terms.
//!
//! Each pack downloads into a directory of its own under `<data dir>/talk/`,
//! checked file by file (`crate::tts::store::ModelStore`).

use serde::{Deserialize, Serialize};

use crate::tts::catalog::{validate, ModelFile};

/// The live transcriber and the voice detector.
pub const ZIPFORMER: &str = "he-zipformer-stream";
/// End of turn.
pub const SMART_TURN: &str = "smart-turn-v3.2";
/// The final transcriber.
pub const WHISPER: &str = "he-turbo";

/// Replaces the built-in packs with a JSON array of [`ModelPack`] (a mirror,
/// or a small test pack). Unset in normal use.
pub const CATALOG_ENV: &str = "CODEG_TALK_CATALOG";

/// One pack: the files one engine needs, in a directory of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPack {
    /// The iPhone catalog's id; also the pack's directory name.
    pub id: String,
    pub title: String,
    /// Talk cannot start without it.
    #[serde(default)]
    pub required: bool,
    /// Worth downloading on this Mac, though Talk works without it.
    #[serde(default)]
    pub recommended: bool,
    pub files: Vec<ModelFile>,
}

impl ModelPack {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().map(|f| f.size).sum()
    }
}

const RELEASES: &str = "https://github.com/Jonathan-Asher/codeg-ios/releases/download";

fn release_file(release: &str, path: &str, size: u64, sha256: &str) -> ModelFile {
    ModelFile {
        path: path.to_string(),
        url: format!("{RELEASES}/{release}/{path}"),
        size,
        sha256: sha256.to_string(),
    }
}

fn silero() -> ModelFile {
    release_file(
        "models-v1",
        "ggml-silero-v5.1.2.bin",
        885_098,
        "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
    )
}

/// The pinned packs, in the order the settings list them.
pub fn builtin() -> Vec<ModelPack> {
    vec![
        ModelPack {
            id: ZIPFORMER.to_string(),
            title: "ivrit.ai Hebrew streaming Zipformer".to_string(),
            required: true,
            recommended: true,
            files: vec![
                release_file(
                    "models-v2",
                    "zipformer2-66m-streaming-he-encoder.int8.onnx",
                    70_478_964,
                    "6c6febcb74a09435315a1d872a6539f6e7fc2c333533f14c74edc0e85c49ffcd",
                ),
                release_file(
                    "models-v2",
                    "zipformer2-66m-streaming-he-decoder.int8.onnx",
                    1_049_105,
                    "feb03e7c8aa761593a9284a6fa1e91259be3702de75f630062256c1a59c5a906",
                ),
                release_file(
                    "models-v2",
                    "zipformer2-66m-streaming-he-joiner.int8.onnx",
                    771_805,
                    "1d2c6d8e6dabc5eb52de52e95718e9bdfbffbfe7ead3808fb5ffd74e83bd9cae",
                ),
                release_file(
                    "models-v2",
                    "zipformer2-66m-streaming-he-tokens.txt",
                    17_086,
                    "e4ebb5e72a6aeef47437a55fa2308ebbedb7c51c557de7a89bf965c23ea9af4a",
                ),
                silero(),
            ],
        },
        ModelPack {
            id: SMART_TURN.to_string(),
            title: "Smart Turn v3.2".to_string(),
            required: true,
            recommended: true,
            files: vec![release_file(
                "models-v2",
                "smart-turn-v3.2-cpu.onnx",
                8_679_182,
                "2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f",
            )],
        },
        ModelPack {
            id: WHISPER.to_string(),
            title: "ivrit.ai Hebrew whisper".to_string(),
            required: false,
            recommended: true,
            files: vec![
                release_file(
                    "models-v1",
                    "ggml-ivrit-large-v3-turbo-q8_0.bin",
                    874_188_075,
                    "123a936e686b06d45b52dc1790251a1418841352ca94079ae643d57893ffc9a6",
                ),
                silero(),
                release_file(
                    "models-v1",
                    "ggml-tiny-q8_0.bin",
                    43_537_433,
                    "c2085835d3f50733e2ff6e4b41ae8a2b8d8110461e18821b09a15c40c42d1cca",
                ),
            ],
        },
    ]
}

/// A pack id names a directory: ASCII letters, digits, `.`, `-`, `_`, and
/// never `.` or `..` alone.
fn is_safe_pack_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id != "."
        && id != ".."
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// Check a set of packs before trusting it with the file system.
pub fn validate_packs(packs: &[ModelPack]) -> Result<(), String> {
    if packs.is_empty() {
        return Err("the Talk model catalog is empty".into());
    }
    let mut seen = std::collections::HashSet::new();
    for pack in packs {
        if !is_safe_pack_id(&pack.id) {
            return Err(format!("unsafe pack id {:?}", pack.id));
        }
        if !seen.insert(pack.id.as_str()) {
            return Err(format!("pack {} is listed twice", pack.id));
        }
        validate(&pack.files).map_err(|e| format!("pack {}: {e}", pack.id))?;
    }
    Ok(())
}

/// The packs to use: the JSON file [`CATALOG_ENV`] names when set, otherwise
/// [`builtin`].
pub fn load() -> Result<Vec<ModelPack>, String> {
    let Some(path) = std::env::var_os(CATALOG_ENV).filter(|v| !v.is_empty()) else {
        return Ok(builtin());
    };
    let raw = std::fs::read(&path).map_err(|e| {
        format!(
            "cannot read {CATALOG_ENV} ({}): {e}",
            std::path::Path::new(&path).display()
        )
    })?;
    let mut packs: Vec<ModelPack> = serde_json::from_slice(&raw)
        .map_err(|e| format!("{CATALOG_ENV} is not a JSON list of model packs: {e}"))?;
    for file in packs.iter_mut().flat_map(|p| p.files.iter_mut()) {
        file.sha256 = file.sha256.to_ascii_lowercase();
    }
    validate_packs(&packs)?;
    Ok(packs)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The iPhone's catalog, as shipped.
    const IOS_CATALOG: &str = include_str!("testdata/stt-models.json");

    #[derive(Deserialize)]
    struct IosCatalog {
        models: Vec<IosModel>,
    }

    #[derive(Deserialize)]
    struct IosModel {
        id: String,
        title: String,
        files: Vec<ModelFile>,
    }

    #[test]
    fn the_packs_match_the_iphone_catalog_file_for_file() {
        let ios: IosCatalog = serde_json::from_str(IOS_CATALOG).unwrap();
        for pack in builtin() {
            let model = ios
                .models
                .iter()
                .find(|m| m.id == pack.id)
                .unwrap_or_else(|| panic!("{} is not in stt-models.json", pack.id));
            assert_eq!(pack.title, model.title, "{}", pack.id);
            assert_eq!(pack.files, model.files, "{}", pack.id);
        }
    }

    #[test]
    fn the_required_packs_are_the_live_transcriber_and_end_of_turn() {
        let packs = builtin();
        let required: Vec<&str> = packs
            .iter()
            .filter(|p| p.required)
            .map(|p| p.id.as_str())
            .collect();
        assert_eq!(required, vec![ZIPFORMER, SMART_TURN]);
        let whisper = packs.iter().find(|p| p.id == WHISPER).unwrap();
        assert!(!whisper.required && whisper.recommended);
        // Sizes the settings show: ~73 MB, ~8.7 MB and ~919 MB.
        let mb = |id: &str| packs.iter().find(|p| p.id == id).unwrap().total_bytes() / 1_000_000;
        assert_eq!(mb(ZIPFORMER), 73);
        assert_eq!(mb(SMART_TURN), 8);
        assert_eq!(mb(WHISPER), 918);
    }

    #[test]
    fn the_builtin_catalog_is_valid() {
        validate_packs(&builtin()).unwrap();
    }

    #[test]
    fn unsafe_or_duplicate_packs_are_refused() {
        let mut packs = builtin();
        packs[0].id = "../escape".into();
        assert!(validate_packs(&packs).is_err());
        let mut packs = builtin();
        packs[1].id = packs[0].id.clone();
        assert!(validate_packs(&packs).is_err());
        assert!(validate_packs(&[]).is_err());
    }
}
