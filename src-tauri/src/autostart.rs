use crate::db::log_event;
use crate::state::{lock, AppState};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;

/// 开机自启只对打包后的应用有意义；开发模式下静默跳过
pub fn apply(app: &AppHandle, enabled: bool) {
    if cfg!(debug_assertions) {
        let state = app.state::<AppState>();
        let conn = lock(&state.db);
        log_event(
            &conn,
            "autostart_skipped_dev",
            Some(json!({ "enabled": enabled })),
        );
        return;
    }
    let launcher = app.autolaunch();
    if enabled {
        let _ = launcher.enable();
    } else {
        let _ = launcher.disable();
    }
}
