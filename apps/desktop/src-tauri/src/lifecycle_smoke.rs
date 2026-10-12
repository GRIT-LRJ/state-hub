// The command is harmless in production; process fault injection only exists in explicit smoke builds.
#[tauri::command]
pub(crate) fn record_connection(app: tauri::AppHandle, generation: u64) {
    #[cfg(feature = "lifecycle-smoke")]
    smoke::connected(&app, generation);
    #[cfg(not(feature = "lifecycle-smoke"))]
    let _ = (app, generation);
}

#[cfg(feature = "lifecycle-smoke")]
pub(crate) use smoke::{record_spawn, start};

#[cfg(feature = "lifecycle-smoke")]
mod smoke {
    use std::{sync::Mutex, time::{Duration, Instant}};
    use serde::Serialize;
    use tauri::{AppHandle, Listener, Manager};
    use crate::supervisor::{CoreState, crash_for_smoke};

    #[derive(Default, Serialize)]
    struct Evidence {
        spawned: Vec<(u64, u32)>,
        connected: Vec<u64>,
        exhausted: bool,
        phase: String,
    }
    #[derive(Default)]
    struct SmokeState(Mutex<Evidence>);

    fn save(app: &AppHandle) {
        if let Some(path) = std::env::var_os("STATE_HUB_LIFECYCLE_SMOKE_FILE") {
            if let Ok(state) = app.state::<SmokeState>().0.lock() {
                if let Ok(bytes) = serde_json::to_vec(&*state) {
                    let _ = std::fs::write(path, bytes);
                }
            };
        }
    }

    pub(crate) fn record_spawn(app: &AppHandle, generation: u64, pid: u32) {
        let Some(state) = app.try_state::<SmokeState>() else { return };
        if let Ok(mut evidence) = state.0.lock() { evidence.spawned.push((generation, pid)); }
        save(app);
    }

    pub(super) fn connected(app: &AppHandle, generation: u64) {
        let Some(state) = app.try_state::<SmokeState>() else { return };
        let core = app.state::<CoreState>();
        let valid = core.connection.lock().ok()
            .and_then(|connection| connection.clone()).is_some_and(|connection| connection.generation == generation);
        if !valid { return; }
        if let Ok(mut evidence) = state.0.lock() {
            if !evidence.connected.contains(&generation) { evidence.connected.push(generation); }
        }
        save(app);
    }

    pub(crate) fn start(app: AppHandle) {
        if std::env::var_os("STATE_HUB_LIFECYCLE_SMOKE_FILE").is_none() { return; }
        app.manage(SmokeState::default());
        let handle = app.clone();
        app.listen("core-restart-exhausted", move |_| {
            if let Ok(mut evidence) = handle.state::<SmokeState>().0.lock() { evidence.exhausted = true; }
            save(&handle);
        });
        tauri::async_runtime::spawn(async move {
            let mode = std::env::var("STATE_HUB_LIFECYCLE_SMOKE_MODE").unwrap_or_else(|_| "recovery".into());
            let started = Instant::now();
            let mut crashed = false;
            loop {
                let (connections, exhausted) = {
                    let state = app.state::<SmokeState>();
                    let evidence = state.0.lock().unwrap();
                    (evidence.connected.len(), evidence.exhausted)
                };
                let done = if mode == "startup-failure" { exhausted } else { connections >= 2 };
                let timed_out = started.elapsed() > Duration::from_secs(120);
                if done || timed_out {
                    if let Ok(mut evidence) = app.state::<SmokeState>().0.lock() {
                        evidence.phase = if done { "completed" } else { "timeout" }.into();
                    }
                    save(&app);
                    // Same Tauri exit path as tray Quit; the external runner checks every observed PID.
                    app.exit(if done { 0 } else { 1 });
                    break;
                }
                if connections == 1 && !crashed && mode == "recovery" {
                    crashed = true;
                    crash_for_smoke(&app);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });
    }
}
