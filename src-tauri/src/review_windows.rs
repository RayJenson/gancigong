use crate::models::{LockLevel, ReviewMode};
use crate::state::{lock, AppState};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[derive(Clone, Debug)]
pub struct SessionInfo {
    pub round_id: i64,
    pub labels: Vec<String>,
}

pub fn session_round(app: &AppHandle) -> Option<i64> {
    let state = app.state::<AppState>();
    let s = lock(&state.session);
    s.as_ref().map(|s| s.round_id)
}

fn logical_rect(m: &tauri::Monitor) -> (f64, f64, f64, f64) {
    let scale = if m.scale_factor() > 0.0 { m.scale_factor() } else { 1.0 };
    (
        m.position().x as f64 / scale,
        m.position().y as f64 / scale,
        m.size().width as f64 / scale,
        m.size().height as f64 / scale,
    )
}

fn lock_str(level: LockLevel) -> &'static str {
    match level {
        LockLevel::App => "app",
        LockLevel::Kiosk => "kiosk",
    }
}

struct Spec {
    label: String,
    url: String,
    gentle: bool,
    fullscreen: bool,
    rect: Option<(f64, f64, f64, f64)>,
}

pub fn open(app: &AppHandle, round_id: i64, mode: ReviewMode, lock_level: LockLevel, lock_all: bool) -> bool {
    close_all(app);
    // 复习期间收起悬浮球，避免挡住弹窗或成为绕过入口
    crate::floatball::set_visible(app, false);

    let mut specs: Vec<Spec> = Vec::new();
    match mode {
        ReviewMode::Gentle => {
            let rect = app.primary_monitor().ok().flatten().map(|m| logical_rect(&m));
            let (x, y) = match rect {
                Some((mx, my, mw, _)) => (mx + mw - 420.0 - 24.0, my + 24.0),
                None => (80.0, 80.0),
            };
            specs.push(Spec {
                label: format!("review-{round_id}"),
                url: format!("index.html#/review?round={round_id}&mode=gentle"),
                gentle: true,
                fullscreen: false,
                rect: Some((x, y, 420.0, 300.0)),
            });
        }
        ReviewMode::Fullscreen => {
            let primary_pos = app
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| *m.position());
            let monitors = app.available_monitors().unwrap_or_default();
            let mut targets: Vec<(usize, tauri::Monitor)> = monitors
                .into_iter()
                .enumerate()
                .map(|(i, m)| (i, m))
                .collect();
            if !lock_all {
                targets.retain(|(_, m)| Some(*m.position()) == primary_pos);
            }
            if targets.is_empty() {
                if let Ok(Some(m)) = app.primary_monitor() {
                    targets.push((0, m));
                }
            }
            if targets.is_empty() {
                specs.push(Spec {
                    label: format!("review-{round_id}"),
                    url: format!(
                        "index.html#/review?round={round_id}&mode=fullscreen&lock={}",
                        lock_str(lock_level)
                    ),
                    gentle: false,
                    fullscreen: true,
                    rect: None,
                });
            }
            let mut primary_assigned = false;
            for (i, m) in targets {
                let is_primary = Some(*m.position()) == primary_pos && !primary_assigned;
                if is_primary {
                    primary_assigned = true;
                }
                let (label, url) = if is_primary || primary_pos.is_none() && i == 0 {
                    (
                        format!("review-{round_id}"),
                        format!(
                            "index.html#/review?round={round_id}&mode=fullscreen&lock={}",
                            lock_str(lock_level)
                        ),
                    )
                } else {
                    (
                        format!("cover-{round_id}-{i}"),
                        format!("index.html#/cover?round={round_id}"),
                    )
                };
                specs.push(Spec {
                    label,
                    url,
                    gentle: false,
                    fullscreen: true,
                    rect: Some(logical_rect(&m)),
                });
            }
        }
    }

    let labels: Vec<String> = specs.iter().map(|s| s.label.clone()).collect();
    {
        let state = app.state::<AppState>();
        *lock(&state.session) = Some(SessionInfo {
            round_id,
            labels: labels.clone(),
        });
    }

    let mut all_ok = true;
    for spec in specs {
        if !build_window(app, round_id, spec) {
            all_ok = false;
        }
    }
    all_ok
}

fn build_window(app: &AppHandle, round_id: i64, spec: Spec) -> bool {
    let mut builder = WebviewWindowBuilder::new(app, spec.label.clone(), WebviewUrl::App(spec.url.into()))
        .title("赶词工")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(spec.gentle)
        .focused(true);

    if spec.fullscreen {
        builder = builder.fullscreen(true);
    } else {
        builder = builder.inner_size(420.0, 300.0);
    }
    if let Some((x, y, w, h)) = spec.rect {
        builder = builder.position(x, y);
        if !spec.fullscreen {
            builder = builder.inner_size(w, h);
        }
    }

    let win = match builder.build() {
        Ok(w) => w,
        Err(err) => {
            let state = app.state::<AppState>();
            crate::db::log_event(
                &lock(&state.db),
                "review_window_error",
                Some(serde_json::json!({ "message": err.to_string() })),
            );
            return false;
        }
    };

    let handle = app.clone();
    let label = spec.label.clone();
    let fullscreen = spec.fullscreen;
    win.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            // 关闭意图统一由主进程裁决：折算成一次「延后」，额度用尽就关不掉
            api.prevent_close();
            let h = handle.clone();
            std::thread::spawn(move || {
                crate::flow::request_delay(&h, round_id, "close_button");
            });
        }
        WindowEvent::Focused(false) if fullscreen => {
            let h = handle.clone();
            let l = label.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(120));
                if crate::review_windows::session_round(&h).is_some() {
                    if let Some(w) = h.get_webview_window(&l) {
                        let _ = w.set_focus();
                    }
                }
            });
        }
        _ => {}
    });
    true
}

pub fn close_all(app: &AppHandle) {
    let state = app.state::<AppState>();
    let taken = lock(&state.session).take();
    let had_session = taken.is_some();
    if let Some(session) = taken {
        for label in session.labels {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
        }
    }
    // 兜底清理游离的复习窗口
    for (label, win) in app.webview_windows() {
        if label.starts_with("review-") || label.starts_with("cover-") {
            let _ = win.destroy();
        }
    }
    // 一轮复习结束（而不是刚开始的预清理）才把悬浮球放回来
    if had_session {
        let enabled = app.state::<AppState>().settings().float_ball;
        crate::floatball::set_visible(app, enabled);
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}
