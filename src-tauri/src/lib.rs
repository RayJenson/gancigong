mod autostart;
mod csv_io;
mod db;
mod dictionary;
mod floatball;
mod flow;
mod ipc;
mod kiosk;
mod models;
mod review_windows;
mod rounds;
mod scheduler;
mod settings;
mod state;
mod theme;
mod tray;
mod util;
mod words;

use crate::dictionary::Dictionary;
use crate::state::{lock, AppState};
use serde_json::json;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

pub static RUNNING: AtomicBool = AtomicBool::new(true);

fn boxed_error(message: String) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::new(std::io::ErrorKind::Other, message))
}

pub fn refresh_tray_tooltip(app: &AppHandle) {
    let status = flow::flow_status(app);
    let text = if status.reason == "learning" {
        "背单词中，复习提醒已暂停".to_string()
    } else {
        match status.next_fire_at {
            None => "当前不在复习时段".to_string(),
            Some(ts) => format!(
                "{} 提醒（{}）",
                util::to_hhmm(ts),
                util::format_countdown(Some(ts), util::now())
            ),
        }
    };
    tray::update_tooltip(app, &text);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 全局下发 WebView2 参数：逐窗口设置 additionalBrowserArgs 会让第二窗口建 WebView2 失败（0x8007139F）
    if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "--disable-gpu --enable-low-end-device-mode --js-flags=--max-old-space-size=128",
        );
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            review_windows::show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        flow::handle_escape(app, "shortcut");
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let state = AppState::new(&handle).map_err(boxed_error)?;
            let dict = Dictionary::load(&state.resource_dirs);
            let dict_status = dict.status();
            let _ = state.dict.set(dict);
            app.manage(state);

            {
                let state = app.state::<AppState>();
                let conn = lock(&state.db);
                let stale = conn
                    .execute(
                        "update rounds set status = 'aborted', finished_at = ?1 where status = 'open'",
                        [util::now()],
                    )
                    .unwrap_or(0);
                if stale > 0 {
                    db::log_event(&conn, "stale_rounds_cleaned", Some(json!({ "count": stale })));
                }
                words::ensure_default_list(&conn).map_err(boxed_error)?;
            }

            // 逃生快捷键是强制模式的前置条件：注册失败就不允许锁桌面
            let shortcut_ok = Shortcut::from_str(flow::ESCAPE_SHORTCUT)
                .map(|sc| app.global_shortcut().register(sc).is_ok())
                .unwrap_or(false);
            {
                let state = app.state::<AppState>();
                state.escape_ready.store(shortcut_ok, Ordering::SeqCst);
            }

            if let Some(win) = app.get_webview_window("main") {
                let handle2 = handle.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // 关窗不退出：常驻托盘是「软件主动来找你」的前提
                        api.prevent_close();
                        if let Some(w) = handle2.get_webview_window("main") {
                            let _ = w.hide();
                        }
                    }
                });
            }

            tray::init(&handle).map_err(|e| boxed_error(e.to_string()))?;

            {
                let state = app.state::<AppState>();
                let settings = state.settings();
                db::log_event(
                    &lock(&state.db),
                    "startup",
                    Some(json!({
                        "db": state.data_dir.join("gancigong.db").to_string_lossy(),
                        "dictionary": dict_status,
                        "escapeShortcutRegistered": shortcut_ok,
                        "mode": settings.mode,
                        "lockLevel": settings.lock_level,
                    })),
                );
                if settings.autostart {
                    autostart::apply(&handle, true);
                }
            }

            scheduler::start_ticker(handle.clone());
            refresh_tray_tooltip(&handle);
            if app.state::<AppState>().settings().float_ball {
                floatball::spawn(&handle);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ipc::settings_all,
            ipc::settings_set,
            ipc::theme_state,
            ipc::theme_background_pick,
            ipc::theme_background_clear,
            ipc::lists_list,
            ipc::lists_create,
            ipc::lists_rename,
            ipc::lists_delete,
            ipc::units_list,
            ipc::units_create,
            ipc::units_rename,
            ipc::units_delete,
            ipc::words_list,
            ipc::words_create,
            ipc::words_update,
            ipc::words_delete,
            ipc::words_move,
            ipc::words_pick_csv,
            ipc::words_import,
            ipc::words_export,
            ipc::open_data_dir,
            ipc::dict_lookup,
            ipc::learn_pause,
            ipc::learn_resume,
            ipc::learn_start,
            ipc::learn_wrong_list,
            ipc::learn_wrong_mark,
            ipc::wrongs_list,
            ipc::wrongs_counts,
            ipc::wrongs_remove,
            ipc::learn_finish,
            ipc::learn_progress_get,
            ipc::learn_progress_save,
            ipc::learn_progress_clear,
            ipc::dashboard_state,
            ipc::stats_overview,
            ipc::flow_status,
            ipc::review_start_now,
            ipc::review_plan,
            ipc::review_rate,
            ipc::review_finish,
            ipc::review_delay,
            ipc::review_abort,
            ipc::kiosk_status,
            floatball::float_menu_toggle,
            floatball::float_menu_close,
            floatball::open_main,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { api, code, .. } => {
                // 主窗口只是隐藏，真正常驻由托盘决定；没有显式退出码时不算退出
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            RunEvent::Exit => {
                RUNNING.store(false, Ordering::SeqCst);
                floatball::persist(app);
            }
            _ => {}
        });
}
