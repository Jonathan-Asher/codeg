//! Settings › General › "Run without a window" (`crate::windowless`).
//!
//! Both runtimes answer, so a remote client can switch the machine it is
//! connected to: that is how an always-on Mac nobody sits at gets switched.
//! Only the macOS desktop app reports the switch as supported; codeg-server
//! has no window to do without, and says so.

use std::path::Path;

use sea_orm::DatabaseConnection;

use crate::app_error::AppCommandError;
use crate::windowless::{self, WindowlessSettingsView};

async fn web_service_auto_start(conn: &DatabaseConnection) -> bool {
    match crate::web::load_web_service_config(conn).await {
        Ok(config) => config.auto_start,
        Err(err) => {
            tracing::warn!("[windowless] could not read the web service settings: {err}");
            false
        }
    }
}

pub async fn get_windowless_settings_core(
    conn: &DatabaseConnection,
    data_dir: &Path,
) -> WindowlessSettingsView {
    windowless::settings_view(data_dir, web_service_auto_start(conn).await)
}

/// Turn the persisted switch on or off. It takes effect the next time codeg
/// starts; the running process keeps its mode.
pub async fn update_windowless_settings_core(
    conn: &DatabaseConnection,
    data_dir: &Path,
    enabled: bool,
) -> Result<WindowlessSettingsView, AppCommandError> {
    if !windowless::supported() {
        return Err(AppCommandError::invalid_input(
            "Only the codeg app on macOS can run without a window",
        ));
    }
    windowless::write_switch_file(data_dir, enabled).map_err(AppCommandError::io)?;
    tracing::info!(
        "[windowless] switch turned {} in {}; takes effect at the next start",
        if enabled { "on" } else { "off" },
        data_dir.display()
    );
    Ok(get_windowless_settings_core(conn, data_dir).await)
}

#[cfg(feature = "tauri-runtime")]
fn desktop_data_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppCommandError> {
    use tauri::Manager;
    let base = app.path().app_data_dir().map_err(|e| {
        AppCommandError::io_error("Failed to resolve the app data directory").with_detail(e.to_string())
    })?;
    Ok(crate::paths::resolve_effective_data_dir(&base))
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn get_windowless_settings(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<WindowlessSettingsView, AppCommandError> {
    Ok(get_windowless_settings_core(&db.conn, &desktop_data_dir(&app)?).await)
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn update_windowless_settings(
    app: tauri::AppHandle,
    db: tauri::State<'_, crate::db::AppDatabase>,
    enabled: bool,
) -> Result<WindowlessSettingsView, AppCommandError> {
    update_windowless_settings_core(&db.conn, &desktop_data_dir(&app)?, enabled).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    #[tokio::test]
    async fn the_switch_is_written_where_it_is_read() {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().expect("tempdir");

        let view = get_windowless_settings_core(&db.conn, dir.path()).await;
        assert_eq!(view.supported, windowless::supported());
        assert!(!view.enabled);
        // A fresh database has the web service's automatic start off.
        assert!(!view.web_service_auto_start);

        let result = update_windowless_settings_core(&db.conn, dir.path(), true).await;
        if windowless::supported() {
            let view = result.expect("turn on");
            assert!(view.enabled);
            assert!(windowless::switch_file_present(dir.path()));
            // It is the next launch that changes; this one keeps its mode.
            assert!(!view.active);

            let view = update_windowless_settings_core(&db.conn, dir.path(), false)
                .await
                .expect("turn off");
            assert!(!view.enabled);
            assert!(!windowless::switch_file_present(dir.path()));
        } else {
            assert!(result.is_err());
            assert!(!windowless::switch_file_present(dir.path()));
        }
    }

    #[tokio::test]
    async fn the_view_reports_the_web_service_auto_start() {
        let db = fresh_in_memory_db().await;
        let dir = tempfile::tempdir().expect("tempdir");
        crate::db::service::app_metadata_service::upsert_value(
            &db.conn,
            "web_service_auto_start",
            "true",
        )
        .await
        .expect("seed");
        assert!(
            get_windowless_settings_core(&db.conn, dir.path())
                .await
                .web_service_auto_start
        );
    }
}
