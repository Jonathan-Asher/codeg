fn main() {
    #[cfg(feature = "tauri-runtime")]
    {
        // The sidecars every platform bundles: the companion, built from its
        // own package (crates/codeg-mcp), the command-line client and the
        // computer-use helper, all by prepare-sidecars. (On macOS the helper
        // ships as an app of its own; the staged binary is what
        // `place_helper_for_development` copies for a development build.)
        for name in ["codeg-mcp", "codeg-cli", "codeg-computer-helper"] {
            ensure_sidecar_placeholder(name);
        }
        // macOS only: the natural-voice sidecar (`native/codeg-tts`) and Talk
        // on the Mac's helper (`native/codeg-talk`) with the whisper.framework
        // it links, listed in tauri.macos.conf.json. Built by the same
        // prepare-sidecars step.
        if std::env::var("TARGET").unwrap_or_default().contains("apple-darwin") {
            ensure_sidecar_placeholder("codeg-tts");
            ensure_sidecar_placeholder("codeg-talk");
            ensure_framework_placeholder("whisper");
        }
        ensure_interface_placeholder();
        place_helper_for_development();
        tauri_build::build();
    }
}

/// Tauri's bundler validates that every `bundle.externalBin` path resolves
/// to an existing file at build.rs time. The real sidecars — `codeg-mcp`,
/// `codeg-cli`, `codeg-computer-helper` and, on macOS, `codeg-tts` and
/// `codeg-talk` — are produced by `pnpm tauri:prepare-sidecars` (invoked from
/// `beforeBuildCommand` / `beforeDevCommand` and the CI release matrix) — but
/// plain `cargo check --features tauri-runtime` doesn't go through that path,
/// so without a backstop every contributor would hit
/// `resource path ... doesn't exist` on first compile.
///
/// We write a zero-byte placeholder when a sidecar is missing so
/// `cargo check` / clippy / rust-analyzer succeed. Production paths
/// overwrite the placeholder with the real binary before Tauri bundles it:
///   * `pnpm tauri build`  → `beforeBuildCommand` → `prepare-sidecars.mjs`
///   * release.yml         → explicit "Stage sidecars" step
///   * `pnpm tauri dev`    → `beforeDevCommand` → `prepare-sidecars.mjs`
///
/// If you ever bypass those wrappers (e.g. invoking the Tauri CLI directly
/// without beforeBuildCommand) you'd ship the placeholder, so emit a
/// cargo:warning that surfaces in any compile log to make that loud.
#[cfg(feature = "tauri-runtime")]
fn ensure_sidecar_placeholder(name: &str) {
    use std::fs;
    use std::path::PathBuf;

    let triple = std::env::var("TARGET").unwrap_or_default();
    if triple.is_empty() {
        return;
    }
    let ext = if triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let dir = PathBuf::from("binaries");
    let path = dir.join(format!("{name}-{triple}{ext}"));

    println!("cargo:rerun-if-changed={}", path.display());

    let needs_placeholder = match fs::metadata(&path) {
        Ok(meta) => meta.len() == 0,
        Err(_) => true,
    };

    if needs_placeholder {
        if let Err(e) = fs::create_dir_all(&dir) {
            panic!("failed to create {}: {e}", dir.display());
        }
        if let Err(e) = fs::write(&path, b"") {
            panic!(
                "failed to write sidecar placeholder {}: {e}",
                path.display()
            );
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
        }
        println!(
            "cargo:warning={name} sidecar missing at {}; wrote 0-byte placeholder. \
             Run `pnpm tauri:prepare-sidecars` before `tauri build` to ship a working binary.",
            path.display()
        );
    }
}

/// On macOS the computer-use helper is no sidecar: a bundle carries it as an
/// app of its own (`tauri.macos.conf.json`), so Tauri no longer copies it
/// next to the build as it does `bundle.externalBin`. This does, for a
/// development codeg, which is not bundled and looks for the helper beside
/// itself. The staged file is already watched by `ensure_sidecar_placeholder`.
#[cfg(feature = "tauri-runtime")]
fn place_helper_for_development() {
    use std::path::PathBuf;

    let triple = std::env::var("TARGET").unwrap_or_default();
    if !triple.contains("apple-darwin") {
        return;
    }
    let staged = PathBuf::from(format!("binaries/codeg-computer-helper-{triple}"));
    // `target/[<triple>/]<profile>/build/<pkg>-<hash>/out`, as tauri-build
    // finds the same directory: there is no other way to it from here.
    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").unwrap_or_default());
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        return;
    };
    let placed = profile_dir.join("codeg-computer-helper");
    // Through a new file renamed into place: a helper still running from the
    // old one keeps its own, where writing over it would kill it.
    let incoming = profile_dir.join("codeg-computer-helper.incoming");
    if let Err(e) =
        std::fs::copy(&staged, &incoming).and_then(|_| std::fs::rename(&incoming, &placed))
    {
        let _ = std::fs::remove_file(&incoming);
        println!(
            "cargo:warning=could not place {} at {}: {e}",
            staged.display(),
            placed.display()
        );
    }
}

/// tauri-build copies every `bundle.macOS.frameworks` entry into
/// `target/Frameworks` at build.rs time (for `tauri dev`) and fails when one
/// is missing. `binaries/whisper.framework` is staged by prepare-sidecars
/// (the real one, or a stub on builds without Talk on the Mac), so plain
/// `cargo check` / clippy get an empty placeholder directory, the framework
/// counterpart of the sidecar placeholder above. A bundle built from the
/// placeholder fails to sign, which makes skipping prepare-sidecars loud.
#[cfg(feature = "tauri-runtime")]
fn ensure_framework_placeholder(name: &str) {
    use std::fs;
    use std::path::PathBuf;

    let path = PathBuf::from("binaries").join(format!("{name}.framework"));
    println!("cargo:rerun-if-changed={}", path.display());
    if path.exists() {
        return;
    }
    if let Err(e) = fs::create_dir_all(&path) {
        panic!("failed to create framework placeholder {}: {e}", path.display());
    }
    println!(
        "cargo:warning={name}.framework missing at {}; created an empty placeholder. \
         Run `pnpm tauri:prepare-sidecars` before `tauri build` to ship Talk on the Mac.",
        path.display()
    );
}

/// `bundle.resources` maps the Next export (`../out`) into the bundle's
/// `web/`, and tauri-build fails at build.rs time when a resource path is
/// missing. The export only exists after `next build` (`beforeBuildCommand`),
/// so plain `cargo check` / clippy on a fresh checkout get an empty
/// placeholder directory, the interface counterpart of the placeholders
/// above. A bundle built from it opens the "cannot find its interface" page
/// rather than a blank window, which makes skipping `next build` loud.
#[cfg(feature = "tauri-runtime")]
fn ensure_interface_placeholder() {
    use std::fs;
    use std::path::Path;

    let path = Path::new("../out");
    if path.exists() {
        return;
    }
    if let Err(e) = fs::create_dir_all(path) {
        panic!("failed to create interface placeholder {}: {e}", path.display());
    }
    println!(
        "cargo:warning=interface export missing at {}; created an empty placeholder. \
         Run `next build` (pnpm build) before `tauri build` to ship the interface.",
        path.display()
    );
}
