//! `codeg-mcp`'s own flags print and exit, and touch nothing: the binary runs
//! with a cleared environment and a scratch HOME and data dir, which must stay
//! empty. (An integration test can only run its own package's binary, so this
//! one moved here from codeg's `tests/server_single_owner.rs`.)

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const MCP: &str = env!("CARGO_BIN_EXE_codeg-mcp");

/// Every path under `dir`, sorted.
fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).expect("read dir") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                pending.push(path.clone());
            }
            found.push(path);
        }
    }
    found.sort();
    found
}

fn describe(out: &Output) -> String {
    format!(
        "exit {:?}, stdout {:?}, stderr {:?}",
        out.status.code(),
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

#[test]
fn codeg_mcp_flags_print_and_exit() {
    let root = tempfile::tempdir().expect("temp dir");
    let run = |args: &[&str]| {
        Command::new(MCP)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", root.path().join("home"))
            .env("CODEG_DATA_DIR", root.path().join("data"))
            .stdin(std::process::Stdio::null())
            .args(args)
            .output()
            .expect("run codeg-mcp")
    };

    let version = run(&["--version"]);
    assert!(version.status.success(), "{}", describe(&version));
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        env!("CARGO_PKG_VERSION")
    );
    let help = run(&["-h"]);
    assert!(help.status.success(), "{}", describe(&help));
    assert!(String::from_utf8_lossy(&help.stdout).contains("Usage: codeg-mcp"));
    let unknown = run(&["--bogus"]);
    assert_eq!(unknown.status.code(), Some(2), "{}", describe(&unknown));
    let stderr = String::from_utf8_lossy(&unknown.stderr);
    assert!(stderr.contains("unknown arg: --bogus"), "{stderr}");
    assert!(stderr.contains("Usage: codeg-mcp"), "{stderr}");
    assert_eq!(walk(root.path()), Vec::<PathBuf>::new());
}
