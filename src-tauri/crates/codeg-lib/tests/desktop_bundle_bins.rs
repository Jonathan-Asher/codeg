//! What `tauri build` puts in the desktop bundle besides codeg.
//!
//! The Tauri CLI bundles the binary targets of the app's own package (`codeg`,
//! src-tauri) whose `required-features` it builds with, and adds the
//! `default-run` one. In this layout that package has one binary, the app;
//! everything else — the standalone server, the command-line client, the
//! computer-use helper — is a binary of the library package (crates/codeg-lib),
//! which `tauri build` never bundles, and the MCP companion is a package of its
//! own (crates/codeg-mcp). The sidecars that do ship are the ones
//! `prepare-sidecars` builds without the desktop features.
use std::path::Path;

/// src-tauri, where the app package, the Tauri configuration and the build
/// scripts live.
fn root() -> &'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/../.."))
}

fn strings(value: Option<&toml::Value>) -> Vec<String> {
    value
        .and_then(toml::Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| item.as_str().expect("a feature name").to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// The features `tauri build` builds with: `tauri/custom-protocol`, and
/// whatever any Tauri configuration file names under `build.features`.
fn features_tauri_build_is_given() -> Vec<String> {
    let mut given = vec!["tauri/custom-protocol".to_string()];
    for entry in std::fs::read_dir(root()).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        if !(name.starts_with("tauri") && name.ends_with(".conf.json")) {
            continue;
        }
        let config: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root().join(&name)).unwrap()).unwrap();
        if let Some(features) = config["build"]["features"].as_array() {
            given.extend(
                features
                    .iter()
                    .map(|f| f.as_str().expect("a feature name").to_string()),
            );
        }
    }
    given
}

#[test]
fn only_codeg_is_a_binary_target_tauri_build_bundles() {
    let manifest: toml::Table = std::fs::read_to_string(root().join("Cargo.toml"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        manifest["package"]["default-run"].as_str(),
        Some("codeg"),
        "the binary tauri build bundles as the app"
    );
    let bins: Vec<&str> = manifest["bin"]
        .as_array()
        .expect("[[bin]] targets")
        .iter()
        .map(|bin| bin["name"].as_str().unwrap())
        .collect();
    assert_eq!(bins, ["codeg"], "the app package has the app alone");

    // The library's binaries each need a feature off by default and never
    // given to `tauri build`, so a plain build of the workspace compiles none
    // of them with the desktop's features.
    let library: toml::Table = std::fs::read_to_string(root().join("crates/codeg-lib/Cargo.toml"))
        .unwrap()
        .parse()
        .unwrap();
    let defaults = strings(library["features"].get("default"));
    let given = features_tauri_build_is_given();
    let bins = library["bin"].as_array().expect("[[bin]] targets");
    for bin in bins {
        let name = bin["name"].as_str().unwrap();
        let required = strings(bin.get("required-features"));
        assert!(
            required
                .iter()
                .any(|feature| !given.contains(feature) && !defaults.contains(feature)),
            "`{name}` requires no feature tauri build lacks ({required:?})"
        );
    }
    assert!(
        bins.len() >= 3,
        "codeg-server, the computer-use helper and codeg-cli"
    );
}

/// The desktop bundle carries `codeg-cli` as a sidecar, so the desktop user
/// needs no server package to have the command. Four places must agree: the
/// sidecar build, both bundle configurations, and the placeholders `build.rs`
/// writes for a build that skipped the sidecars.
#[test]
fn codeg_cli_is_a_sidecar_everywhere_the_desktop_build_looks() {
    let read = |file: &str| std::fs::read_to_string(root().join(file)).unwrap();
    let prepare = read("scripts/prepare-sidecars.mjs");
    let bin_names = prepare
        .lines()
        .find(|l| l.starts_with("const LIB_BIN_NAMES"))
        .expect("LIB_BIN_NAMES");
    assert!(bin_names.contains("\"codeg-cli\""), "{bin_names}");
    let features = prepare
        .lines()
        .find(|l| l.starts_with("const LIB_FEATURES"))
        .expect("LIB_FEATURES");
    for feature in ["computer-helper", "cli-bin"] {
        assert!(features.contains(feature), "{features} lacks {feature}");
    }
    for config in ["tauri.conf.json", "tauri.macos.conf.json"] {
        let json: serde_json::Value = serde_json::from_str(&read(config)).unwrap();
        let bins: Vec<&str> = json["bundle"]["externalBin"]
            .as_array()
            .expect("externalBin")
            .iter()
            .map(|b| b.as_str().unwrap())
            .collect();
        assert!(bins.contains(&"binaries/codeg-cli"), "{config}: {bins:?}");
    }
    let build = read("build.rs");
    assert!(
        build.contains("\"codeg-cli\""),
        "build.rs writes no codeg-cli placeholder"
    );
}

/// The release workflow gives `tauri build` no features of its own: one named
/// there would bring the binary target that requires it into the bundle.
#[test]
fn the_release_build_names_no_features() {
    let workflow =
        std::fs::read_to_string(root().join("../.github/workflows/release.yml")).unwrap();
    let mut tauri_args = 0;
    for line in workflow.lines() {
        let line = line.trim_start();
        if let Some(args) = line.strip_prefix("args:") {
            tauri_args += 1;
            assert!(!args.contains("--features"), "{line}");
        }
    }
    assert!(tauri_args >= 1, "the tauri-action steps pass their args");
}
