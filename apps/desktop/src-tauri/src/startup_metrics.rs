use serde::Serialize;
use std::{fs, path::PathBuf, sync::Mutex, time::Instant};
use tauri::{AppHandle, Manager};

pub(crate) struct StartupMetrics {
    started: Instant,
    file: Option<PathBuf>,
    values: Mutex<Measurements>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Measurements {
    version: Option<String>,
    core_ready_ms: Option<u128>,
    ui_first_paint_ms: Option<u128>,
}

impl StartupMetrics {
    pub(crate) fn new(started: Instant) -> Self {
        Self {
            started,
            file: std::env::var_os("STATE_HUB_STARTUP_METRICS_FILE").map(PathBuf::from),
            values: Mutex::new(Measurements::default()),
        }
    }

    fn record(&self, core: bool) {
        let Ok(mut values) = self.values.lock() else {
            return;
        };
        let elapsed = self.started.elapsed().as_millis();
        if core {
            if values.core_ready_ms.is_some() {
                return;
            }
            values.core_ready_ms = Some(elapsed);
        } else {
            if values.ui_first_paint_ms.is_some() {
                return;
            }
            values.ui_first_paint_ms = Some(elapsed);
        }
        if let Some(file) = &self.file {
            if let Ok(bytes) = serde_json::to_vec(&*values) {
                let _ = fs::write(file, bytes);
            }
        }
    }

    pub(crate) fn core_ready(&self) {
        self.record(true);
    }
    fn ui_first_paint(&self) {
        self.record(false);
    }

    pub(crate) fn version(&self, version: String) {
        if let Ok(mut values) = self.values.lock() {
            values.version = Some(version);
        }
    }
}

#[tauri::command]
pub(crate) fn record_first_paint(app: AppHandle) {
    app.state::<StartupMetrics>().ui_first_paint();
}
