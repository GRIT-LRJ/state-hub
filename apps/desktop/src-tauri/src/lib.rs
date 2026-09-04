use rand::RngCore;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Emitter, Manager,
};
use tauri_plugin_shell::{process::CommandChild, process::CommandEvent, ShellExt};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreConnection {
    endpoint: String,
    admin_token: String,
}

#[derive(Default)]
struct CoreState {
    connection: Mutex<Option<CoreConnection>>,
    child: Mutex<Option<CommandChild>>,
}

fn private_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tauri::command]
fn core_connection(state: tauri::State<'_, CoreState>) -> Result<CoreConnection, String> {
    state
        .connection
        .lock()
        .map_err(|_| "Core state lock is poisoned".to_string())?
        .clone()
        .ok_or_else(|| "Core is still starting".to_string())
}

#[tauri::command]
fn store_secret(reference: String, value: String) -> Result<(), String> {
    keyring::Entry::new("dev.statehub.desktop", &reference)
        .map_err(|error| error.to_string())?
        .set_password(&value)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_secret(reference: String) -> Result<(), String> {
    keyring::Entry::new("dev.statehub.desktop", &reference)
        .map_err(|error| error.to_string())?
        .delete_credential()
        .map_err(|error| error.to_string())
}

fn start_core(app: &tauri::AppHandle, admin_token: String) -> Result<(), String> {
    let command = app
        .shell()
        .sidecar("state-hub-core")
        .map_err(|error| error.to_string())?
        .env("STATE_HUB_ADMIN_TOKEN", &admin_token);
    let (mut receiver, child) = command.spawn().map_err(|error| error.to_string())?;
    let state = app.state::<CoreState>();
    *state.child.lock().map_err(|_| "Core child lock is poisoned")? = Some(child);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    if let Ok(line) = String::from_utf8(bytes) {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) {
                            if value.get("type").and_then(|item| item.as_str()) == Some("state-hub.ready") {
                                if let Some(port) = value.get("port").and_then(|item| item.as_u64()) {
                                    let connection = CoreConnection {
                                        endpoint: format!("http://127.0.0.1:{port}"),
                                        admin_token: admin_token.clone(),
                                    };
                                    if let Ok(mut slot) = handle.state::<CoreState>().connection.lock() {
                                        *slot = Some(connection.clone());
                                    }
                                    let _ = handle.emit("core-ready", connection);
                                }
                            }
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    if let Ok(mut slot) = handle.state::<CoreState>().connection.lock() {
                        *slot = None;
                    }
                    let _ = handle.emit("core-terminated", payload.code);
                }
                _ => {}
            }
        }
    });
    Ok(())
}

async fn set_paused(app: tauri::AppHandle, paused: bool) {
    let connection = app
        .state::<CoreState>()
        .connection
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    if let Some(connection) = connection {
        let _ = reqwest::Client::new()
            .post(format!("{}/api/v1/admin/outputs/pause", connection.endpoint))
            .bearer_auth(connection.admin_token)
            .json(&serde_json::json!({ "paused": paused }))
            .send()
            .await;
    }
}

fn create_tray(app: &tauri::App) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 State Hub", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "暂停所有输出", true, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "恢复输出", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &pause, &resume, &quit])?;
    let mut builder = TrayIconBuilder::with_id("state-hub")
        .tooltip("State Hub")
        .menu(&menu)
        .menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
            "pause" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move { set_paused(handle, true).await });
            }
            "resume" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move { set_paused(handle, false).await });
            }
            "quit" => {
                if let Ok(mut child) = app.state::<CoreState>().child.lock() {
                    if let Some(mut child) = child.take() {
                        let _ = child.kill();
                    }
                }
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CoreState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![core_connection, store_secret, delete_secret])
        .setup(|app| {
            start_core(app.handle(), private_token()).map_err(std::io::Error::other)?;
            create_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running State Hub");
}
