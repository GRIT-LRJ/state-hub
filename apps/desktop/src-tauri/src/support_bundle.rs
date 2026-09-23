use std::path::Path;
use tauri_plugin_dialog::DialogExt;

fn write_bundle(path: &Path, bundle: &str) -> Result<(), String> {
    if bundle.len() > 8_000_000 {
        return Err("SUPPORT_BUNDLE_TOO_LARGE".into());
    }
    let parsed: serde_json::Value =
        serde_json::from_str(bundle).map_err(|_| "INVALID_SUPPORT_BUNDLE")?;
    if parsed
        .get("schemaVersion")
        .and_then(serde_json::Value::as_u64)
        != Some(1)
    {
        return Err("INVALID_SUPPORT_BUNDLE".into());
    }
    std::fs::write(path, bundle).map_err(|_| "SUPPORT_BUNDLE_WRITE_FAILED".into())
}

#[tauri::command]
pub async fn save_support_bundle(app: tauri::AppHandle, bundle: String) -> Result<bool, String> {
    if bundle.len() > 8_000_000 {
        return Err("SUPPORT_BUNDLE_TOO_LARGE".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_file_name("state-hub-support-bundle.json")
            .add_filter("JSON", &["json"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(false);
        };
        let path = selected
            .into_path()
            .map_err(|_| "SUPPORT_BUNDLE_PATH_FAILED")?;
        write_bundle(&path, &bundle)?;
        Ok(true)
    })
    .await
    .map_err(|_| "SUPPORT_BUNDLE_WRITE_FAILED")?
}

#[cfg(test)]
mod tests {
    use super::write_bundle;

    #[test]
    fn accepts_only_bounded_versioned_json_and_writes_it() {
        let path = std::env::temp_dir().join(format!(
            "state-hub-support-{}-{}.json",
            std::process::id(),
            rand::random::<u64>()
        ));
        assert!(write_bundle(&path, "not json").is_err());
        assert!(write_bundle(&path, r#"{"schemaVersion":2}"#).is_err());
        assert!(!path.exists());
        write_bundle(&path, r#"{"schemaVersion":1,"runtime":{}}"#).unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            r#"{"schemaVersion":1,"runtime":{}}"#
        );
        std::fs::remove_file(path).unwrap();
    }
}
