use serde::Serialize;
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

pub(crate) fn configured(app: &AppHandle) -> bool {
    crate::updater_config::configured(app.config().plugins.0.get("updater"))
}

#[tauri::command]
pub(crate) fn updater_available(app: AppHandle) -> bool {
    configured(&app)
}

#[cfg(feature = "release-smoke")]
pub(crate) fn start_release_smoke(app: AppHandle) {
    if std::env::var("STATE_HUB_SMOKE_AUTO_UPDATE").ok().as_deref() != Some("1") {
        return;
    }
    let Some(result_file) = std::env::var_os("STATE_HUB_SMOKE_RESULT_FILE") else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let record = |phase: &str| {
            let _ = std::fs::write(&result_file, format!("{{\"phase\":\"{phase}\"}}"));
        };
        let Ok(updater) = app
            .updater_builder()
            .timeout(Duration::from_secs(15))
            .build()
        else {
            record("configuration-rejected");
            return;
        };
        let Ok(Some(update)) = updater.check().await else {
            record("manifest-rejected");
            return;
        };
        let update = update.restart_after_install(false);
        let Ok(bytes) = update.download(|_, _| {}, || {}).await else {
            record("download-or-signature-rejected");
            return;
        };
        record("signature-verified");
        if update.install(bytes).is_err() {
            record("install-rejected");
        } else {
            record("installed");
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvailableUpdate {
    version: String,
}

#[tauri::command]
pub(crate) async fn check_update(app: AppHandle) -> Result<Option<AvailableUpdate>, String> {
    if !configured(&app) { return Err("UPDATE_UNAVAILABLE".to_string()); }
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "UPDATE_CONFIGURATION_FAILED".to_string())?;
    updater
        .check()
        .await
        .map(|update| {
            update.map(|update| AvailableUpdate {
                version: update.version,
            })
        })
        .map_err(|_| "UPDATE_CHECK_FAILED".to_string())
}

#[tauri::command]
pub(crate) async fn install_update(app: AppHandle, expected_version: String) -> Result<(), String> {
    if !configured(&app) { return Err("UPDATE_UNAVAILABLE".to_string()); }
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "UPDATE_CONFIGURATION_FAILED".to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|_| "UPDATE_CHECK_FAILED".to_string())?
        .ok_or_else(|| "UPDATE_NOT_AVAILABLE".to_string())?;
    if update.version != expected_version {
        return Err("UPDATE_VERSION_CHANGED".to_string());
    }
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|_| "UPDATE_INSTALL_FAILED".to_string())
}
