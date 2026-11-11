//! The desktop windows' asset provider: the interface read from the bundle.
//!
//! Tauri serves the app's windows from `tauri://localhost`
//! (`http://tauri.localhost` on Windows) through the context's [`Assets`]
//! provider. The provider `generate_context!` builds compiles every file of
//! `frontendDist` into the binary, so an interface change, and the version a
//! release stamps into tauri.conf.json, used to recompile the whole app.
//! `frontendDist` now names a one-page placeholder
//! (`src-tauri/frontend-placeholder`), and [`serve_bundled_interface`] swaps
//! in [`BundledAssets`]: the export the bundle already carries for the
//! embedded web server, which `bundle.resources` copies from `out/` to `web/`
//! in the resource directory (`Contents/Resources/web` on macOS, next to the
//! executable on Windows, `/usr/lib/codeg/web` in the Linux packages).
//!
//! What does not change:
//! - the origin. The scheme and host are Tauri's protocol, not the provider,
//!   so localStorage, IndexedDB, cookies and permissions stay where they are;
//! - the lookup. Tauri's protocol handler asks for the request path, then
//!   `path.html`, then `path/index.html`, and serves `index.html` for a route
//!   it does not know; the provider only answers "these bytes" or "no such
//!   file", as the embedded one did;
//! - the MIME types, which the same handler derives from the path and the
//!   bytes, which are the same;
//! - dev mode, whose windows load `devUrl` and never ask the provider.
//!
//! Not supplied: CSP hashes. tauri.conf.json sets no CSP, so Tauri never asks
//! for them; with one, the export's inline scripts would need the hashes
//! `generate_context!` computes for the files it embeds.

use std::borrow::Cow;
use std::path::{Path, PathBuf};

use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Runtime};

/// Serve the windows from the bundle's `web` folder instead of the
/// placeholder compiled into `context`.
///
/// The placeholder stays when the folder is missing: a broken install then
/// shows a page that says so, rather than a blank window. Dev builds keep it
/// too; their windows load `devUrl`.
pub fn serve_bundled_interface<R: Runtime>(context: &mut tauri::Context<R>) {
    if tauri::is_dev() {
        return;
    }
    let resource_dir = match tauri::utils::platform::resource_dir(
        context.package_info(),
        &tauri::Env::default(),
    ) {
        Ok(dir) => dir,
        Err(err) => {
            tracing::error!(
                "[WEB] no resource directory ({err}); the windows get the placeholder page"
            );
            return;
        }
    };
    let Some(root) = super::bundled_web_dir(&resource_dir) else {
        tracing::error!(
            "[WEB] no interface at {}; the windows get the placeholder page",
            resource_dir.join("web").display()
        );
        return;
    };
    if context.config().app.security.csp.is_some() {
        tracing::warn!(
            "[WEB] a CSP is configured, but the windows' assets come from disk and carry no \
             CSP hashes: inline scripts will be blocked"
        );
    }
    tracing::info!("[WEB] serving the app's windows from {}", root.display());
    context.set_assets(Box::new(BundledAssets::new(root)));
}

/// The files under one folder, as Tauri asset keys (`/` + the path below it).
pub struct BundledAssets {
    root: PathBuf,
}

impl BundledAssets {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The bytes of the regular file `key` names below the root, or `None`
    /// when there is none (Tauri then tries its next candidate).
    fn read(&self, key: &str) -> Option<Vec<u8>> {
        let path = resolve(&self.root, key)?;
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => {}
            // A directory: every route has one beside its `.html`, and the
            // first candidate for `/settings` is the folder `settings`.
            Ok(_) => return None,
            Err(err) => {
                if !is_absent(&err) {
                    tracing::warn!("[WEB] cannot read {}: {err}", path.display());
                }
                return None;
            }
        }
        match std::fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(err) => {
                tracing::warn!("[WEB] cannot read {}: {err}", path.display());
                None
            }
        }
    }

    /// Every file below the root with its key, read as the walk reaches it.
    fn entries(&self) -> impl Iterator<Item = (String, Vec<u8>)> + '_ {
        let root = self.root.as_path();
        walkdir::WalkDir::new(root)
            .follow_links(true)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .filter_map(move |entry| {
                let key = AssetKey::from(entry.path().strip_prefix(root).ok()?);
                let bytes = std::fs::read(entry.path()).ok()?;
                Some((String::from(key), bytes))
            })
    }
}

impl<R: Runtime> Assets<R> for BundledAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        self.read(key.as_ref()).map(Cow::Owned)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(
            self.entries()
                .map(|(key, bytes)| (Cow::Owned(key), Cow::Owned(bytes))),
        )
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// The path an asset key names below `root`, or `None` for a key that could
/// reach outside it.
///
/// Keys are what Tauri builds from the request: `/`, then the path,
/// percent-decoded, so a `%2e%2e` arrives here as `..`. Only plain names are
/// joined: an empty segment (which would make the rest absolute), `.`, `..`,
/// a backslash (a separator on Windows), a colon (a drive or a stream on
/// Windows) or a NUL refuses the whole key. The embedded provider never
/// needed this: a key was only ever looked up in a map.
fn resolve(root: &Path, key: &str) -> Option<PathBuf> {
    let relative = key.strip_prefix('/').unwrap_or(key);
    let mut path = root.to_path_buf();
    for segment in relative.split('/') {
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains(['\\', ':', '\0'])
        {
            return None;
        }
        path.push(segment);
    }
    Some(path)
}

/// No file there: Tauri asks for candidates that do not exist all the time.
fn is_absent(err: &std::io::Error) -> bool {
    matches!(
        err.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An export-shaped folder: a route's `.html` beside its directory, a
    /// nested asset, and a file outside the root the keys must not reach.
    fn fixture() -> (tempfile::TempDir, BundledAssets) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("web");
        std::fs::create_dir_all(root.join("settings")).unwrap();
        std::fs::create_dir_all(root.join("_next/static/chunks")).unwrap();
        std::fs::write(root.join("index.html"), "<html>home</html>").unwrap();
        std::fs::write(root.join("settings.html"), "<html>settings</html>").unwrap();
        std::fs::write(root.join("settings/general.txt"), "rsc").unwrap();
        std::fs::write(root.join("_next/static/chunks/app.js"), "js").unwrap();
        std::fs::write(dir.path().join("secret.txt"), "outside").unwrap();
        (dir, BundledAssets::new(root))
    }

    #[test]
    fn keys_name_files_below_the_root() {
        let (_dir, assets) = fixture();
        assert_eq!(
            assets.read("/index.html").as_deref(),
            Some(&b"<html>home</html>"[..])
        );
        assert_eq!(
            assets.read("/_next/static/chunks/app.js").as_deref(),
            Some(&b"js"[..])
        );
        assert_eq!(
            assets.read("/settings/general.txt").as_deref(),
            Some(&b"rsc"[..])
        );
    }

    /// `/settings` is a folder and `/nope` nothing at all: both are "no such
    /// asset", which sends Tauri on to `settings.html` and to `index.html`.
    #[test]
    fn folders_and_missing_files_are_not_assets() {
        let (_dir, assets) = fixture();
        assert_eq!(assets.read("/settings"), None);
        assert_eq!(assets.read("/nope"), None);
        assert_eq!(assets.read("/index.html/nope"), None);
        assert_eq!(
            assets.read("/settings.html").as_deref(),
            Some(&b"<html>settings</html>"[..])
        );
    }

    /// The keys Tauri's lookup produces for a window route and its fallbacks
    /// resolve to the export's files.
    #[test]
    fn tauri_keys_resolve_like_the_embedded_ones() {
        let (_dir, assets) = fixture();
        let key = AssetKey::from("settings.html");
        assert_eq!(key.as_ref(), "/settings.html");
        assert!(assets.read(key.as_ref()).is_some());
        assert!(assets.read(AssetKey::from("index.html").as_ref()).is_some());
    }

    #[test]
    fn keys_cannot_leave_the_root() {
        let (_dir, assets) = fixture();
        for key in [
            "/../secret.txt",
            "/settings/../../secret.txt",
            "/./index.html",
            "//index.html",
            "/settings//general.txt",
            "/settings\\general.txt",
            "/c:/secret.txt",
            "/index.html:stream",
            "/index\0.html",
            "/",
            "",
        ] {
            assert_eq!(assets.read(key), None, "{key:?}");
        }
    }

    #[test]
    fn iterates_every_file_with_its_key() {
        let (_dir, assets) = fixture();
        let mut keys: Vec<String> = assets.entries().map(|(key, _)| key).collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "/_next/static/chunks/app.js",
                "/index.html",
                "/settings.html",
                "/settings/general.txt",
            ]
        );
    }

    /// The bundle's folder counts only with its `index.html`; without one the
    /// windows keep the placeholder.
    #[test]
    fn the_bundled_folder_needs_an_index() {
        let (dir, _assets) = fixture();
        assert_eq!(
            super::super::bundled_web_dir(dir.path()),
            Some(dir.path().join("web"))
        );
        std::fs::remove_file(dir.path().join("web/index.html")).unwrap();
        assert_eq!(super::super::bundled_web_dir(dir.path()), None);
    }
}
