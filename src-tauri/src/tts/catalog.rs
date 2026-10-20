//! The model files natural read-aloud downloads: BlueTTS 2.5, RenikudPlus and
//! the voices, pinned to exact revisions and checksums. The same list as the
//! iPhone app's `VoiceModelStore.swift` and BlueTTSKit's
//! `scripts/models.sha256`, so both speak with identical models.
//!
//! The weights are downloaded, never bundled: the BlueTTS 2.5 weights carry no
//! stated licence.

use std::path::{Component, Path};

use serde::{Deserialize, Serialize};

/// One file of the model pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelFile {
    /// Where it goes inside the models directory, `/`-separated.
    pub path: String,
    pub url: String,
    pub size: u64,
    /// Lowercase hex sha256.
    pub sha256: String,
}

/// The pack's directory under `<data dir>/tts/`. A new set of pinned files
/// gets a new name, so an old pack is never mistaken for the new one.
pub const PACK_DIR: &str = "bluetts-2.5";

/// The voices in the pack. `noa` is the iPhone app's default.
pub const VOICES: &[&str] = &["noa", "adam", "daniel", "lily"];
pub const DEFAULT_VOICE: &str = "noa";

/// Replaces the built-in list with a JSON array of [`ModelFile`] (a mirror,
/// or a small test pack). Unset in normal use.
pub const CATALOG_ENV: &str = "CODEG_TTS_CATALOG";

const BLUE_REV: &str = "468da64b4a51795a7594a3637727dbaf876b6df2";
const RENIKUD_REV: &str = "679c56ca449d41873fb8ff7711ddf7563d28198f";
const VOICES_REV: &str = "0e38dbf08ed53f85863d1eab092bd9572c53a503";

fn hf(repo: &str, rev: &str, file: &str) -> String {
    format!("https://huggingface.co/{repo}/resolve/{rev}/{file}")
}

fn gh(repo: &str, rev: &str, file: &str) -> String {
    format!("https://raw.githubusercontent.com/{repo}/{rev}/{file}")
}

fn file(path: &str, url: String, size: u64, sha256: &str) -> ModelFile {
    ModelFile {
        path: path.to_string(),
        url,
        size,
        sha256: sha256.to_string(),
    }
}

/// The pinned pack, ~575 MB.
pub fn builtin() -> Vec<ModelFile> {
    let blue = |name: &str| hf("notmax123/BlueTTS2.5-onnx", BLUE_REV, name);
    let voice = |name: &str| gh("maxmelichov/Light-BlueTTS", VOICES_REV, name);
    vec![
        file(
            "bluetts/duration_predictor_style.onnx",
            blue("duration_predictor_style.onnx"),
            1_508_749,
            "3d0347cfc09234b78a20d5fa50b5c402d338fb99825f40ada8c70301edbb60ea",
        ),
        file(
            "bluetts/text_encoder.onnx",
            blue("text_encoder.onnx"),
            27_419_694,
            "f971aa25315b93efff1850b39fe293aa93ae85df69fabf5e5022318cc632973c",
        ),
        file(
            "bluetts/vector_estimator.onnx",
            blue("vector_estimator.onnx"),
            132_475_789,
            "50557b34acfafa4b34f21dae263faa74d3f3169f114ff927599a1eff110d0b6e",
        ),
        file(
            "bluetts/vocoder.onnx",
            blue("vocoder.onnx"),
            101_411_919,
            "b0709df316ff44cc263c04fbf9d17371b16897071a48b79d3634d5f379fb3067",
        ),
        file(
            "bluetts/tts.json",
            blue("tts.json"),
            9_260,
            "862d44194197de4873eccc8bfdab1835d15f98e469a90489df6da8f92a48c7ea",
        ),
        file(
            "bluetts/vocab.json",
            blue("vocab.json"),
            3_157,
            "13fba5e735222fcf30d9c062d898982a1ba86d481f11560fbbdf6e0af79417b3",
        ),
        file(
            "bluetts/stats.npz",
            blue("stats.npz"),
            1_920,
            "20d44fae010d46b859ee6238609780eb7bd5bf82320bad17b826a5dcfa4ed658",
        ),
        file(
            "bluetts/uncond.npz",
            blue("uncond.npz"),
            52_732,
            "1c71c2b2836fd97f4c56eb21e258227650bbe0dcd906f64e2bba58e6ac09e76b",
        ),
        file(
            "renikud/model_int8.onnx",
            hf("notmax123/RenikudPlus", RENIKUD_REV, "model_int8.onnx"),
            311_605_741,
            "0337468fad56eadf5ecc7becfdf21648a4d668de41de5bc27e860141b5afcadd",
        ),
        file(
            "voices/noa.json",
            voice("voices/noa.json"),
            288_898,
            "c233f066a7d505306892509649bc80abeb7d0a565687f143e277ec93874a47c8",
        ),
        file(
            "voices/adam.json",
            voice("voices/adam.json"),
            288_774,
            "c2c7b7daf9d77aad0f76e91ad9ae634a17158a291d6920eb4eb705e522dcc0b2",
        ),
        file(
            "voices/daniel.json",
            voice("voices/daniel.json"),
            289_020,
            "9f5364c856383de27f5f276557b6160343125dcf80a6019e882cc90d7cbf2d84",
        ),
        file(
            "voices/lily.json",
            voice("voices/lily.json"),
            289_090,
            "b96c1b0255334e83f1a23a9fe9e599b8af44058308c64775e216fbcb8415f916",
        ),
    ]
}

/// Every entry must be a relative path inside the pack, with a size and a
/// well-formed sha256 — a catalog can never write outside the models dir.
pub fn validate(files: &[ModelFile]) -> Result<(), String> {
    if files.is_empty() {
        return Err("the catalog lists no files".into());
    }
    for f in files {
        let path = Path::new(&f.path);
        let inside = !f.path.is_empty()
            && !f.path.contains('\\')
            && path.components().all(|c| matches!(c, Component::Normal(_)));
        if !inside {
            return Err(format!(
                "catalog path {:?} leaves the models directory",
                f.path
            ));
        }
        if f.path.ends_with(".part") {
            return Err(format!(
                "catalog path {:?} uses the reserved .part suffix",
                f.path
            ));
        }
        if f.size == 0 {
            return Err(format!("catalog entry {} has no size", f.path));
        }
        if f.sha256.len() != 64 || !f.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(format!("catalog entry {} has a malformed sha256", f.path));
        }
        if !(f.url.starts_with("https://") || f.url.starts_with("http://")) {
            return Err(format!("catalog entry {} has no http(s) url", f.path));
        }
    }
    Ok(())
}

/// The catalog in effect: `CODEG_TTS_CATALOG` when set, else [`builtin`].
pub fn load() -> Result<Vec<ModelFile>, String> {
    let Some(path) = std::env::var_os(CATALOG_ENV).filter(|v| !v.is_empty()) else {
        return Ok(builtin());
    };
    let raw = std::fs::read(&path).map_err(|e| {
        format!(
            "cannot read {CATALOG_ENV} ({}): {e}",
            Path::new(&path).display()
        )
    })?;
    let mut files: Vec<ModelFile> = serde_json::from_slice(&raw)
        .map_err(|e| format!("{CATALOG_ENV} is not a JSON list of model files: {e}"))?;
    for f in &mut files {
        f.sha256 = f.sha256.to_ascii_lowercase();
    }
    validate(&files)?;
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_pack_matches_the_iphone_app() {
        let files = builtin();
        validate(&files).unwrap();
        assert_eq!(files.len(), 13);
        let total: u64 = files.iter().map(|f| f.size).sum();
        // ~575 MB, as the iPhone app and BlueTTSKit's README say.
        assert_eq!(total, 575_644_743);
        for voice in VOICES {
            assert!(
                files
                    .iter()
                    .any(|f| f.path == format!("voices/{voice}.json")),
                "{voice} missing"
            );
        }
        assert!(files
            .iter()
            .any(|f| f.path == "renikud/model_int8.onnx" && f.url.contains(RENIKUD_REV)));
        assert!(VOICES.contains(&DEFAULT_VOICE));
    }

    #[test]
    fn validate_rejects_paths_outside_the_pack() {
        let good = builtin().remove(0);
        for bad in ["../evil", "/abs/path", "a/../../b", "", "a\\b", "x.part"] {
            let mut f = good.clone();
            f.path = bad.to_string();
            assert!(validate(&[f]).is_err(), "{bad} accepted");
        }
        let mut f = good.clone();
        f.sha256 = "zz".into();
        assert!(validate(&[f]).is_err());
        let mut f = good.clone();
        f.size = 0;
        assert!(validate(&[f]).is_err());
        let mut f = good;
        f.url = "file:///etc/passwd".into();
        assert!(validate(&[f]).is_err());
        assert!(validate(&[]).is_err());
    }
}
