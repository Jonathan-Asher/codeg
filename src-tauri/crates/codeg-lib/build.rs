//! The library's build script. It does one thing: fingerprint the sources the
//! computer-use helper is built from (`CODEG_COMPUTER_SOURCE`), which both the
//! library and the `codeg-computer-helper` binary of this package compile in.
//! Everything Tauri needs at build time (tauri-build, the sidecar, framework
//! and interface placeholders) stays in the app package's `build.rs`.

fn main() {
    fingerprint_helper_sources();
}

/// A fingerprint of the sources `codeg-computer-helper` is built from,
/// compiled into it and into the library alike (`CODEG_COMPUTER_SOURCE`). A
/// development codeg refuses a helper whose fingerprint is not its own:
/// `pnpm tauri dev` builds the helper once, as it starts (not at all under
/// `CODEG_SKIP_SIDECAR=1`), and only codeg after that, so a helper left over
/// from before an edit would go on answering with the old code (see
/// `computer::local`). Changes elsewhere in the crate that the helper also
/// compiles in are not seen; they seldom touch it.
///
/// FNV-1a over each file's path and bytes, in path order — the same on every
/// toolchain, which `DefaultHasher` does not promise.
fn fingerprint_helper_sources() {
    use std::path::{Path, PathBuf};

    fn collect(path: &Path, files: &mut Vec<PathBuf>) {
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    collect(&entry.path(), files);
                }
            }
        } else if path.is_file() {
            files.push(path.to_path_buf());
        }
    }

    let mut files = Vec::new();
    for source in ["src/computer", "src/bin/codeg_computer_helper.rs"] {
        println!("cargo:rerun-if-changed={source}");
        collect(Path::new(source), &mut files);
    }
    files.sort();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for file in &files {
        feed(file.to_string_lossy().replace('\\', "/").as_bytes());
        feed(&[0]);
        feed(&std::fs::read(file).unwrap_or_default());
        feed(&[0]);
    }
    println!("cargo:rustc-env=CODEG_COMPUTER_SOURCE={hash:016x}");
}
