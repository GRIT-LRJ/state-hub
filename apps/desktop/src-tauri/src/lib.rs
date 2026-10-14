mod credentials;
mod lifecycle_smoke;
mod updater_config;
mod startup_metrics;
mod supervisor;
mod support_bundle;
mod updates;

use supervisor::{shutdown_core, start_supervisor, CoreState};
use std::time::Instant;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

async fn set_paused(app: tauri::AppHandle, paused: bool) {
    let connection = app
        .state::<CoreState>()
        .connection
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    if let Some(connection) = connection {
        let _ = reqwest::Client::new()
            .post(format!(
                "{}/api/v1/admin/outputs/pause",
                connection.endpoint
            ))
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
        .show_menu_on_left_click(false)
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
                shutdown_core(app);
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
    run_from_process_entry(Instant::now());
}

pub fn run_from_process_entry(started: Instant) {
    tauri::Builder::default()
        .manage(CoreState::default())
        .manage(startup_metrics::StartupMetrics::new(started))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            supervisor::core_connection,
            lifecycle_smoke::record_connection,
            lifecycle_smoke::record_connection_failure,
            credentials::store_secret,
            credentials::secret_status,
            credentials::delete_secret,
            support_bundle::save_support_bundle,
            startup_metrics::record_first_paint,
            updates::updater_available,
            updates::check_update,
            updates::install_update
        ])
        .setup(|app| {
            app.state::<startup_metrics::StartupMetrics>()
                .version(app.package_info().version.to_string());
            if updates::configured(app.handle()) {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            create_tray(app)?;
            #[cfg(feature = "lifecycle-smoke")]
            lifecycle_smoke::start(app.handle().clone());
            start_supervisor(app.handle().clone());
            #[cfg(feature = "release-smoke")]
            updates::start_release_smoke(app.handle().clone());
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
        .build(tauri::generate_context!())
        .expect("error while building State Hub")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                shutdown_core(app);
            }
        });
}
