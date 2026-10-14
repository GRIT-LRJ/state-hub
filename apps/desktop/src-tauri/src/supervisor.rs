use crate::startup_metrics::StartupMetrics;
use rand::RngCore;
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

const STARTUP_DEADLINE: Duration = Duration::from_secs(10);
const STABLE_RUN: Duration = Duration::from_secs(30);
const MAX_CONSECUTIVE_FAILURES: u32 = 5;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoreConnection {
    pub(crate) endpoint: String,
    pub(crate) admin_token: String,
    pub(crate) generation: u64,
}

#[derive(Default)]
pub(crate) struct CoreState {
    pub(crate) connection: Mutex<Option<CoreConnection>>,
    child: Mutex<Option<CommandChild>>,
    stopping: AtomicBool,
    generation: AtomicU64,
    exhausted: AtomicBool,
}

#[derive(Debug, Serialize, PartialEq)]
pub(crate) enum ConnectionError {
    #[serde(rename = "CORE_STARTING")]
    Starting,
    #[serde(rename = "CORE_RESTART_EXHAUSTED")]
    Exhausted,
    #[serde(rename = "CORE_INTERNAL_ERROR")]
    Internal,
}

impl CoreState {
    pub(crate) fn current_connection(&self) -> Result<CoreConnection, ConnectionError> {
        let connection = self.connection.lock().map_err(|_| ConnectionError::Internal)?;
        if self.exhausted.load(Ordering::SeqCst) { return Err(ConnectionError::Exhausted); }
        connection.clone().ok_or(ConnectionError::Starting)
    }
}

fn desktop_dev_origin(is_dev: bool, dev_url: Option<&tauri::Url>) -> String {
    if is_dev { dev_url.map(|url| url.origin().ascii_serialization()).unwrap_or_default() }
    else { String::new() }
}

#[derive(Default)]
struct RestartBudget {
    failures: u32,
}

impl RestartBudget {
    fn after_failure(&mut self, lifetime: Duration) -> Option<Duration> {
        if lifetime >= STABLE_RUN {
            self.failures = 0;
        }
        self.failures += 1;
        if self.failures >= MAX_CONSECUTIVE_FAILURES {
            return None;
        }
        Some(Duration::from_millis(250 * (1_u64 << (self.failures - 1))))
    }
}

fn private_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn ready_port(bytes: &[u8], expected_pid: u32) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    if value.get("type")?.as_str()? != "state-hub.ready"
        || value.get("pid")?.as_u64()? != u64::from(expected_pid)
        || value.get("instanceId")?.as_str()?.is_empty()
    {
        return None;
    }
    let port = value.get("port")?.as_u64()?;
    (1..=65_535).contains(&port).then_some(port as u16)
}

#[tauri::command]
pub(crate) fn core_connection(
    state: tauri::State<'_, CoreState>,
) -> Result<CoreConnection, ConnectionError> {
    state.current_connection()
}

pub(crate) fn shutdown_core(app: &AppHandle) {
    let state = app.state::<CoreState>();
    state.stopping.store(true, Ordering::SeqCst);
    if let Ok(mut connection) = state.connection.lock() {
        *connection = None;
    }
    if let Ok(mut slot) = state.child.lock() {
        if let Some(child) = slot.take() {
            let _ = child.kill();
        }
    };
}

pub(crate) fn start_supervisor(app: AppHandle) {
    tauri::async_runtime::spawn(async move { supervise(app).await });
}

async fn supervise(app: AppHandle) {
    let mut budget = RestartBudget::default();
    let dev_origin = desktop_dev_origin(tauri::is_dev(), app.config().build.dev_url.as_ref());
    loop {
        let state = app.state::<CoreState>();
        if state.stopping.load(Ordering::SeqCst) {
            break;
        }
        let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let token = private_token();
        let started = Instant::now();
        let spawned = app.shell().sidecar("state-hub-core").and_then(|command| {
            command
                .env("STATE_HUB_ADMIN_TOKEN", &token)
                .env("STATE_HUB_SUPERVISED", "1")
                // Explicitly clear inherited development settings in packaged builds.
                .env("STATE_HUB_DESKTOP_DEV_ORIGIN", &dev_origin)
                .spawn()
        });
        match spawned {
            Ok((mut receiver, child)) => {
                if state.stopping.load(Ordering::SeqCst) {
                    let _ = child.kill();
                    break;
                }
                let pid = child.pid();
                #[cfg(feature = "lifecycle-smoke")]
                crate::lifecycle_smoke::record_spawn(&app, generation, pid);
                match state.child.lock() {
                    Ok(mut slot) => *slot = Some(child),
                    Err(_) => {
                        // A poisoned state cannot safely supervise another process.
                        let _ = child.kill();
                        break;
                    }
                }
                if state.stopping.load(Ordering::SeqCst) {
                    shutdown_core(&app);
                    break;
                }
                let deadline = Instant::now() + STARTUP_DEADLINE;
                let mut ready = false;
                loop {
                    let event = if ready {
                        receiver.recv().await
                    } else {
                        let remaining = deadline.saturating_duration_since(Instant::now());
                        if remaining.is_zero() {
                            break;
                        }
                        match tokio::time::timeout(remaining, receiver.recv()).await {
                            Ok(event) => event,
                            Err(_) => break,
                        }
                    };
                    match event {
                        Some(CommandEvent::Stdout(bytes)) if !ready => {
                            for line in bytes.split(|byte| *byte == b'\n') {
                                if let Some(port) = ready_port(line, pid) {
                                    let connection = CoreConnection {
                                        endpoint: format!("http://127.0.0.1:{port}"),
                                        admin_token: token.clone(),
                                        generation,
                                    };
                                    let accepted = if let Ok(mut slot) = state.connection.lock() {
                                        if state.stopping.load(Ordering::SeqCst) {
                                            false
                                        } else {
                                            *slot = Some(connection.clone());
                                            true
                                        }
                                    } else {
                                        false
                                    };
                                    if accepted {
                                        ready = true;
                                        app.state::<StartupMetrics>().core_ready();
                                        let _ = app.emit(
                                            "core-ready",
                                            serde_json::json!({ "generation": generation }),
                                        );
                                    }
                                    break;
                                }
                            }
                        }
                        Some(CommandEvent::Terminated(_)) | Some(CommandEvent::Error(_)) | None => {
                            break;
                        }
                        _ => {}
                    }
                    if state.stopping.load(Ordering::SeqCst) {
                        break;
                    }
                }
                if let Ok(mut slot) = state.child.lock() {
                    if let Some(child) = slot.take() {
                        let _ = child.kill();
                    }
                }
                if let Ok(mut connection) = state.connection.lock() {
                    *connection = None;
                }
                if state.stopping.load(Ordering::SeqCst) {
                    break;
                }
                let _ = app.emit(
                    "core-terminated",
                    serde_json::json!({ "reasonCode": "CORE_TERMINATED" }),
                );
            }
            Err(_) => {
                let _ = app.emit(
                    "core-terminated",
                    serde_json::json!({ "reasonCode": "CORE_START_FAILED" }),
                );
            }
        }
        match budget.after_failure(started.elapsed()) {
            Some(delay) => tokio::time::sleep(delay).await,
            None => {
                state.exhausted.store(true, Ordering::SeqCst);
                let _ = app.emit(
                    "core-restart-exhausted",
                    serde_json::json!({ "attempts": MAX_CONSECUTIVE_FAILURES }),
                );
                break;
            }
        }
    }
}

#[cfg(feature = "lifecycle-smoke")]
pub(crate) fn crash_for_smoke(app: &AppHandle) {
    let state = app.state::<CoreState>();
    if let Ok(mut slot) = state.child.lock() {
        if let Some(child) = slot.take() {
            let _ = child.kill();
        }
    };
}

#[cfg(test)]
mod tests {
    use super::{desktop_dev_origin, ready_port, ConnectionError, CoreState, RestartBudget};
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    #[test]
    fn development_origin_follows_resource_mode_not_debug_profile() {
        let url = tauri::Url::parse("http://localhost:1420/some/page").unwrap();
        assert_eq!(desktop_dev_origin(true, Some(&url)), "http://localhost:1420");
        assert_eq!(desktop_dev_origin(false, Some(&url)), "");
        assert_eq!(desktop_dev_origin(true, None), "");
    }

    #[test]
    fn exhaustion_is_readable_after_the_event_has_been_missed() {
        let state = CoreState::default();
        assert!(matches!(state.current_connection(), Err(ConnectionError::Starting)));
        state.exhausted.store(true, Ordering::SeqCst);
        assert!(matches!(state.current_connection(), Err(ConnectionError::Exhausted)));
        assert_eq!(serde_json::to_string(&ConnectionError::Exhausted).unwrap(), "\"CORE_RESTART_EXHAUSTED\"");
    }

    #[test]
    fn limits_start_failures_and_resets_after_a_stable_run() {
        let mut budget = RestartBudget::default();
        assert_eq!(
            budget.after_failure(Duration::ZERO),
            Some(Duration::from_millis(250))
        );
        assert_eq!(
            budget.after_failure(Duration::ZERO),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            budget.after_failure(Duration::ZERO),
            Some(Duration::from_millis(1_000))
        );
        assert_eq!(
            budget.after_failure(Duration::ZERO),
            Some(Duration::from_millis(2_000))
        );
        assert_eq!(budget.after_failure(Duration::ZERO), None);
        assert_eq!(
            budget.after_failure(Duration::from_secs(31)),
            Some(Duration::from_millis(250))
        );
    }

    #[test]
    fn ignores_stale_or_invalid_ready_lines() {
        assert_eq!(
            ready_port(
                br#"{"type":"state-hub.ready","pid":42,"port":43100,"instanceId":"current"}"#,
                42
            ),
            Some(43100)
        );
        assert_eq!(
            ready_port(
                br#"{"type":"state-hub.ready","pid":41,"port":43100,"instanceId":"old"}"#,
                42
            ),
            None
        );
        assert_eq!(
            ready_port(
                br#"{"type":"state-hub.ready","pid":42,"port":0,"instanceId":"bad"}"#,
                42
            ),
            None
        );
        assert_eq!(ready_port(b"not-json", 42), None);
    }
}
