//! `stat_paths`: whether a batch of files exists, in one request.
//!
//! A client that wants to know whether the files a conversation names are
//! still there used to list every directory they sit in. This stats up to
//! [`STAT_PATHS_MAX`] absolute paths instead and answers, per path, whether it
//! exists, its kind, size and modification time.
//!
//! The path rules are the download API's (`workspace_files`): the caller names
//! the roots (its `rootPath`), and a path must be absolute, free of `..` and
//! lexically under one of them. On top of that the path is resolved, and the
//! result must still lie inside a root (or a folder linked into one, see
//! `folder_links`): a symlink leading out of the roots is reported
//! `allowed: false` and its target is never stat'ed. A path outside every
//! root is likewise `allowed: false`, never `exists: false`. codeg's uploads
//! directory is always a root, so an attachment can be checked without
//! naming it.

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::paths::codeg_uploads_root;

/// Paths per request.
pub const STAT_PATHS_MAX: usize = 200;
/// Roots per request.
pub const STAT_ROOTS_MAX: usize = 32;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatPathsRequest {
    /// One allowed root, as the download API's `rootPath`.
    #[serde(default)]
    pub root_path: Option<String>,
    /// More allowed roots.
    #[serde(default)]
    pub root_paths: Vec<String>,
    /// Absolute paths to check, at most [`STAT_PATHS_MAX`].
    pub paths: Vec<String>,
}

/// Why a path was not checked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StatDenial {
    /// Not absolute, contains `..`, or empty.
    InvalidPath,
    /// Not under any allowed root.
    OutsideRoots,
    /// Under a root, but a symlink on the way leads out of the roots.
    SymlinkEscape,
}

/// One path's answer. `exists`, `isFile`, `isDir` are `null` when the path
/// was not allowed (`reason`) or could not be checked (`error`); `size` is
/// set for files only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathStat {
    /// The path as sent.
    pub path: String,
    pub allowed: bool,
    pub exists: Option<bool>,
    pub is_file: Option<bool>,
    pub is_dir: Option<bool>,
    pub size: Option<u64>,
    /// Modification time, milliseconds since the Unix epoch.
    pub modified_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<StatDenial>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl PathStat {
    fn blank(path: &str, allowed: bool) -> Self {
        Self {
            path: path.to_string(),
            allowed,
            exists: None,
            is_file: None,
            is_dir: None,
            size: None,
            modified_ms: None,
            reason: None,
            error: None,
        }
    }

    fn denied(path: &str, reason: StatDenial) -> Self {
        Self {
            reason: Some(reason),
            ..Self::blank(path, false)
        }
    }

    fn missing(path: &str) -> Self {
        Self {
            exists: Some(false),
            ..Self::blank(path, true)
        }
    }

    fn failed(path: &str, err: &std::io::Error) -> Self {
        Self {
            error: Some(err.to_string()),
            ..Self::blank(path, true)
        }
    }

    fn found(path: &str, meta: &std::fs::Metadata) -> Self {
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .and_then(|d| i64::try_from(d.as_millis()).ok());
        Self {
            exists: Some(true),
            is_file: Some(meta.is_file()),
            is_dir: Some(meta.is_dir()),
            size: meta.is_file().then_some(meta.len()),
            modified_ms,
            ..Self::blank(path, true)
        }
    }
}

/// An allowed root: as named (for the lexical check) and resolved (for the
/// symlink check; `None` when it does not exist).
#[derive(Debug, Clone)]
pub(crate) struct StatRoot {
    lexical: PathBuf,
    canonical: Option<PathBuf>,
}

impl StatRoot {
    pub(crate) fn new(lexical: PathBuf) -> Self {
        let canonical = std::fs::canonicalize(&lexical).ok();
        Self { lexical, canonical }
    }
}

/// An absolute path with `.` dropped, or `None` when it is relative, empty,
/// holds a NUL, or climbs with `..`.
fn normalize_absolute(raw: &str) -> Option<PathBuf> {
    if raw.is_empty() || raw.contains('\0') {
        return None;
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => return None,
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

fn is_missing(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

fn inside_roots(roots: &[StatRoot], canonical: &Path) -> bool {
    roots.iter().any(|root| {
        root.canonical
            .as_deref()
            .is_some_and(|c| crate::commands::folders::is_within_workspace(c, canonical))
    })
}

fn stat_one(roots: &[StatRoot], raw: &str) -> PathStat {
    let Some(path) = normalize_absolute(raw) else {
        return PathStat::denied(raw, StatDenial::InvalidPath);
    };
    let matching: Vec<&StatRoot> = roots
        .iter()
        .filter(|root| path.starts_with(&root.lexical))
        .collect();
    if matching.is_empty() {
        return PathStat::denied(raw, StatDenial::OutsideRoots);
    }
    match std::fs::canonicalize(&path) {
        Ok(canonical) => {
            if !inside_roots(roots, &canonical) {
                return PathStat::denied(raw, StatDenial::SymlinkEscape);
            }
            match std::fs::metadata(&canonical) {
                Ok(meta) => PathStat::found(raw, &meta),
                Err(e) if is_missing(&e) => PathStat::missing(raw),
                Err(e) => PathStat::failed(raw, &e),
            }
        }
        Err(e) if is_missing(&e) => {
            // The path is not there. What is there on the way to it must
            // still be inside the roots, or "missing" would describe a place
            // a symlink leads to outside them.
            let existing = path
                .ancestors()
                .skip(1)
                .take_while(|ancestor| {
                    matching
                        .iter()
                        .any(|root| ancestor.starts_with(&root.lexical))
                })
                .find_map(|ancestor| std::fs::canonicalize(ancestor).ok());
            match existing {
                Some(canonical) if !inside_roots(roots, &canonical) => {
                    PathStat::denied(raw, StatDenial::SymlinkEscape)
                }
                _ => PathStat::missing(raw),
            }
        }
        Err(e) => PathStat::failed(raw, &e),
    }
}

/// Stat `paths` against `roots`, blocking. One answer per path, in order.
pub(crate) fn stat_paths_blocking(roots: &[StatRoot], paths: &[String]) -> Vec<PathStat> {
    paths.iter().map(|raw| stat_one(roots, raw)).collect()
}

/// Validate the request's roots: absolute, no `..`.
fn request_roots(request: &StatPathsRequest) -> Result<Vec<PathBuf>, AppCommandError> {
    let named: Vec<&String> = request
        .root_path
        .iter()
        .chain(request.root_paths.iter())
        .collect();
    if named.len() > STAT_ROOTS_MAX {
        return Err(AppCommandError::invalid_input(format!(
            "At most {STAT_ROOTS_MAX} roots per request"
        )));
    }
    named
        .into_iter()
        .map(|raw| {
            normalize_absolute(raw).ok_or_else(|| {
                AppCommandError::invalid_input("Root path must be absolute, without '..'")
                    .with_detail(raw.clone())
            })
        })
        .collect()
}

/// Shared by the `stat_paths` Tauri command and `POST /api/stat_paths`.
pub async fn stat_paths_core(request: StatPathsRequest) -> Result<Vec<PathStat>, AppCommandError> {
    if request.paths.len() > STAT_PATHS_MAX {
        return Err(AppCommandError::invalid_input(format!(
            "At most {STAT_PATHS_MAX} paths per request"
        ))
        .with_detail(format!("paths={}", request.paths.len())));
    }
    let mut roots = request_roots(&request)?;
    roots.push(codeg_uploads_root());
    let paths = request.paths;
    tokio::task::spawn_blocking(move || {
        let roots: Vec<StatRoot> = roots.into_iter().map(StatRoot::new).collect();
        stat_paths_blocking(&roots, &paths)
    })
    .await
    .map_err(|e| {
        AppCommandError::task_execution_failed("stat_paths task failed").with_detail(e.to_string())
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn stat_paths(
    root_path: Option<String>,
    root_paths: Option<Vec<String>>,
    paths: Vec<String>,
) -> Result<Vec<PathStat>, AppCommandError> {
    stat_paths_core(StatPathsRequest {
        root_path,
        root_paths: root_paths.unwrap_or_default(),
        paths,
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(p: &Path) -> String {
        p.to_string_lossy().to_string()
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        outside: PathBuf,
    }

    /// `<tmp>/root/{a.txt (5 bytes), sub/}` and `<tmp>/outside/secret.txt`.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("a.txt"), b"hello").unwrap();
        std::fs::write(outside.join("secret.txt"), b"secret").unwrap();
        Fixture {
            _dir: dir,
            root,
            outside,
        }
    }

    fn stat(roots: &[&Path], path: &Path) -> PathStat {
        let roots: Vec<StatRoot> = roots
            .iter()
            .map(|r| StatRoot::new(r.to_path_buf()))
            .collect();
        stat_paths_blocking(&roots, &[s(path)]).remove(0)
    }

    #[test]
    fn a_file_inside_the_root_reports_kind_size_and_time() {
        let f = fixture();
        let st = stat(&[&f.root], &f.root.join("a.txt"));
        assert!(st.allowed);
        assert_eq!(st.exists, Some(true));
        assert_eq!(st.is_file, Some(true));
        assert_eq!(st.is_dir, Some(false));
        assert_eq!(st.size, Some(5));
        assert!(st.modified_ms.unwrap_or(0) > 0);
        assert_eq!(st.reason, None);
    }

    #[test]
    fn a_directory_has_no_size() {
        let f = fixture();
        let st = stat(&[&f.root], &f.root.join("sub"));
        assert_eq!(st.exists, Some(true));
        assert_eq!(st.is_dir, Some(true));
        assert_eq!(st.is_file, Some(false));
        assert_eq!(st.size, None);
    }

    #[test]
    fn a_missing_file_inside_the_root_is_allowed_and_absent() {
        let f = fixture();
        for path in [f.root.join("gone.png"), f.root.join("no/such/dir/x.png")] {
            let st = stat(&[&f.root], &path);
            assert!(st.allowed, "{path:?}");
            assert_eq!(st.exists, Some(false), "{path:?}");
        }
        // A file used as a directory is not there either.
        let st = stat(&[&f.root], &f.root.join("a.txt/inner"));
        assert_eq!(st.exists, Some(false));
    }

    #[test]
    fn a_path_outside_every_root_is_not_allowed_rather_than_missing() {
        let f = fixture();
        for path in [f.outside.join("secret.txt"), f.outside.join("nothing.txt")] {
            let st = stat(&[&f.root], &path);
            assert!(!st.allowed);
            assert_eq!(st.reason, Some(StatDenial::OutsideRoots));
            assert_eq!(st.exists, None, "never exists=false outside the roots");
            assert_eq!(st.size, None);
        }
        // A sibling whose name merely starts with the root's is outside too.
        let sibling = PathBuf::from(format!("{}-other/a.txt", s(&f.root)));
        assert_eq!(
            stat(&[&f.root], &sibling).reason,
            Some(StatDenial::OutsideRoots)
        );
    }

    #[test]
    fn relative_and_climbing_paths_are_invalid() {
        let f = fixture();
        let roots = [StatRoot::new(f.root.clone())];
        let climbing = format!("{}/sub/../../outside/secret.txt", s(&f.root));
        let answers = stat_paths_blocking(
            &roots,
            &[
                "a.txt".to_string(),
                "~/a.txt".to_string(),
                String::new(),
                climbing,
            ],
        );
        for st in answers {
            assert!(!st.allowed, "{}", st.path);
            assert_eq!(st.reason, Some(StatDenial::InvalidPath), "{}", st.path);
        }
    }

    #[test]
    fn current_dir_components_are_ignored() {
        let f = fixture();
        let path = PathBuf::from(format!("{}/./sub/../a.txt", s(&f.root)));
        // `..` is refused even when it would stay inside.
        assert_eq!(
            stat(&[&f.root], &path).reason,
            Some(StatDenial::InvalidPath)
        );
        let path = PathBuf::from(format!("{}/./a.txt", s(&f.root)));
        assert_eq!(stat(&[&f.root], &path).exists, Some(true));
    }

    #[test]
    fn answers_keep_the_request_order_and_echo_the_path() {
        let f = fixture();
        let roots = [StatRoot::new(f.root.clone())];
        let paths = vec![
            s(&f.root.join("a.txt")),
            s(&f.outside.join("secret.txt")),
            s(&f.root.join("gone")),
        ];
        let answers = stat_paths_blocking(&roots, &paths);
        let echoed: Vec<&str> = answers.iter().map(|a| a.path.as_str()).collect();
        assert_eq!(echoed, paths.iter().map(String::as_str).collect::<Vec<_>>());
        assert_eq!(answers[0].exists, Some(true));
        assert!(!answers[1].allowed);
        assert_eq!(answers[2].exists, Some(false));
    }

    #[test]
    fn several_roots_each_allow_their_own_files() {
        let f = fixture();
        let st = stat(&[&f.root, &f.outside], &f.outside.join("secret.txt"));
        assert!(st.allowed);
        assert_eq!(st.exists, Some(true));
    }

    #[test]
    fn a_root_that_does_not_exist_holds_nothing() {
        let f = fixture();
        let ghost = f.root.join("ghost-root");
        let st = stat(&[&ghost], &ghost.join("x.mp4"));
        assert!(st.allowed);
        assert_eq!(st.exists, Some(false));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_roots_is_not_followed() {
        use std::os::unix::fs::symlink;
        let f = fixture();
        symlink(f.outside.join("secret.txt"), f.root.join("leak.txt")).unwrap();
        symlink(&f.outside, f.root.join("leakdir")).unwrap();

        let st = stat(&[&f.root], &f.root.join("leak.txt"));
        assert!(!st.allowed);
        assert_eq!(st.reason, Some(StatDenial::SymlinkEscape));
        assert_eq!(st.size, None, "the target's size must not leak");

        let st = stat(&[&f.root], &f.root.join("leakdir/secret.txt"));
        assert_eq!(st.reason, Some(StatDenial::SymlinkEscape));

        // Not even whether something is missing beyond the link.
        let st = stat(&[&f.root], &f.root.join("leakdir/nothing.txt"));
        assert_eq!(st.reason, Some(StatDenial::SymlinkEscape));
        assert_eq!(st.exists, None);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_that_stays_inside_is_followed() {
        use std::os::unix::fs::symlink;
        let f = fixture();
        symlink(f.root.join("a.txt"), f.root.join("sub/alias.txt")).unwrap();
        let st = stat(&[&f.root], &f.root.join("sub/alias.txt"));
        assert!(st.allowed);
        assert_eq!(st.is_file, Some(true));
        assert_eq!(st.size, Some(5));

        // A link into another allowed root is fine as well.
        symlink(f.outside.join("secret.txt"), f.root.join("shared.txt")).unwrap();
        let st = stat(&[&f.root, &f.outside], &f.root.join("shared.txt"));
        assert!(st.allowed);
        assert_eq!(st.size, Some(6));
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_is_missing() {
        use std::os::unix::fs::symlink;
        let f = fixture();
        symlink(f.root.join("never.txt"), f.root.join("dangling.txt")).unwrap();
        let st = stat(&[&f.root], &f.root.join("dangling.txt"));
        assert!(st.allowed);
        assert_eq!(st.exists, Some(false));
    }

    #[tokio::test]
    async fn the_core_caps_paths_and_validates_roots() {
        let too_many = StatPathsRequest {
            root_path: Some("/".into()),
            root_paths: vec![],
            paths: vec!["/x".to_string(); STAT_PATHS_MAX + 1],
        };
        assert!(stat_paths_core(too_many).await.is_err());

        let relative_root = StatPathsRequest {
            root_path: Some("work".into()),
            root_paths: vec![],
            paths: vec![],
        };
        assert!(stat_paths_core(relative_root).await.is_err());

        let f = fixture();
        let ok = StatPathsRequest {
            root_path: None,
            root_paths: vec![s(&f.root)],
            paths: vec![s(&f.root.join("a.txt"))],
        };
        let answers = stat_paths_core(ok).await.unwrap();
        assert_eq!(answers.len(), 1);
        assert_eq!(answers[0].size, Some(5));
    }

    #[test]
    fn the_wire_shape_is_camel_case_and_omits_empty_reasons() {
        let f = fixture();
        let st = stat(&[&f.root], &f.root.join("a.txt"));
        let json = serde_json::to_value(&st).unwrap();
        assert_eq!(json["isFile"], true);
        assert_eq!(json["modifiedMs"], st.modified_ms.unwrap());
        assert!(json.get("reason").is_none());
        let denied = serde_json::to_value(stat(&[&f.root], &f.outside.join("x"))).unwrap();
        assert_eq!(denied["reason"], "outsideRoots");
        assert_eq!(denied["exists"], serde_json::Value::Null);
    }
}
