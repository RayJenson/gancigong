use crate::state::{lock, AppState};
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

pub const BALL_LABEL: &str = "floatball";
pub const MENU_LABEL: &str = "floatmenu";

const BALL_SIZE: f64 = 72.0;
const MENU_WIDTH: f64 = 252.0;
const MENU_HEIGHT: f64 = 344.0;
/// 球与屏幕工作区边缘至少保留的逻辑像素
const EDGE_MARGIN: f64 = 10.0;
/// 拖动时位置落库的最小间隔，避免每秒几十次写盘
const SAVE_INTERVAL: Duration = Duration::from_millis(700);

static LAST_SAVE: Mutex<Option<Instant>> = Mutex::new(None);
/// 最近一次 Moved 的时间与待处理标记，供吸附线程判断位置是否已停稳
static LAST_MOVE: Mutex<Option<Instant>> = Mutex::new(None);
static CLAMP_PENDING: AtomicBool = AtomicBool::new(false);

/// 拖动中系统拖动循环会持续按指针摆窗口，此时再钳制会互相抢位置（表现为贴边抖动）；
/// 直接读全局左键状态判断是否还在拖
#[cfg(target_os = "windows")]
fn dragging() -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    unsafe { (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0 }
}

#[cfg(not(target_os = "windows"))]
fn dragging() -> bool {
    false
}

/// 当前窗口所在显示器的工作区（物理像素，已排除任务栏）
#[cfg(target_os = "windows")]
fn work_area(win: &WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    let hwnd = win.hwnd().ok()?;
    unsafe {
        let monitor = MonitorFromWindow(hwnd.0, MONITOR_DEFAULTTONEAREST);
        if monitor.is_null() {
            return None;
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(monitor, &mut info) == 0 {
            return None;
        }
        let r = info.rcWork;
        Some((r.left, r.top, r.right - r.left, r.bottom - r.top))
    }
}

#[cfg(not(target_os = "windows"))]
fn work_area(win: &WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let m = win.current_monitor().ok().flatten()?;
    Some((
        m.position().x,
        m.position().y,
        m.size().width as i32,
        m.size().height as i32,
    ))
}

fn ball_rect(win: &WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let pos = win.outer_position().ok()?;
    let size = win.outer_size().ok()?;
    Some((pos.x, pos.y, size.width as i32, size.height as i32))
}

/// 把球钳进工作区，返回钳制后的位置；需要移动时顺手 set_position
fn clamp_ball(win: &WebviewWindow) -> Option<(i32, i32, i32, i32)> {
    let (x, y, w, h) = ball_rect(win)?;
    let Some((wx, wy, ww, wh)) = work_area(win) else {
        return Some((x, y, w, h));
    };
    let scale = win.scale_factor().unwrap_or(1.0);
    let margin = (EDGE_MARGIN * scale).round() as i32;
    let lo_x = wx + margin;
    let hi_x = (wx + ww - w - margin).max(lo_x);
    let lo_y = wy + margin;
    let hi_y = (wy + wh - h - margin).max(lo_y);
    let nx = x.clamp(lo_x, hi_x);
    let ny = y.clamp(lo_y, hi_y);
    if (nx, ny) != (x, y) {
        let _ = win.set_position(PhysicalPosition::new(nx, ny));
    }
    Some((nx, ny, w, h))
}

fn default_position(app: &AppHandle) -> (f64, f64) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = if m.scale_factor() > 0.0 { m.scale_factor() } else { 1.0 };
        let px = m.position().x as f64 + m.size().width as f64 - (BALL_SIZE + 16.0) * scale;
        let py = m.position().y as f64 + m.size().height as f64 * 0.4;
        return (px / scale, py / scale);
    }
    (1200.0, 360.0)
}

/// 更新内存里的位置并按节流间隔落库；返回是否改了坐标
fn remember_position(app: &AppHandle, win: &WebviewWindow, x: i32, y: i32) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let lx = (x as f64 / scale).round() as i64;
    let ly = (y as f64 / scale).round() as i64;
    {
        let state = app.state::<AppState>();
        let mut s = lock(&state.settings);
        if s.float_x == Some(lx) && s.float_y == Some(ly) {
            return;
        }
        s.float_x = Some(lx);
        s.float_y = Some(ly);
    }
    let now = Instant::now();
    {
        let mut last = lock(&LAST_SAVE);
        if let Some(t) = *last {
            if now.duration_since(t) < SAVE_INTERVAL {
                return;
            }
        }
        *last = Some(now);
    }
    let handle = app.clone();
    std::thread::spawn(move || persist(&handle));
}

/// 把当前设置整份写回数据库（拖动不记 settings_changed 日志，避免刷屏）
pub fn persist(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let conn = lock(&state.db);
    crate::settings::save(&conn, &settings);
}

fn attach_ball_events(app: &AppHandle, win: &WebviewWindow) {
    win.on_window_event(move |event| {
        if let WindowEvent::Moved(_) = event {
            *lock(&LAST_MOVE) = Some(Instant::now());
            CLAMP_PENDING.store(true, Ordering::SeqCst);
        }
    });

    let handle = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(80));
            if !CLAMP_PENDING.swap(false, Ordering::SeqCst) {
                continue;
            }
            // 仍按着左键 = 拖动未结束，交给系统拖动循环，松手后再吸附
            if dragging() {
                CLAMP_PENDING.store(true, Ordering::SeqCst);
                continue;
            }
            let settled = match *lock(&LAST_MOVE) {
                Some(t) => t.elapsed() >= Duration::from_millis(120),
                None => true,
            };
            if !settled {
                CLAMP_PENDING.store(true, Ordering::SeqCst);
                continue;
            }
            let Some(w) = handle.get_webview_window(BALL_LABEL) else {
                break;
            };
            if let Some((x, y, _, _)) = clamp_ball(&w) {
                remember_position(&handle, &w, x, y);
            }
        }
    });
}

pub fn spawn(app: &AppHandle) {
    if app.get_webview_window(BALL_LABEL).is_some() {
        return;
    }
    let saved = {
        let state = app.state::<AppState>();
        let s = state.settings();
        (s.float_x, s.float_y)
    };
    let (x, y) = match saved {
        (Some(x), Some(y)) => (x as f64, y as f64),
        _ => default_position(app),
    };

    let builder = WebviewWindowBuilder::new(
        app,
        BALL_LABEL,
        WebviewUrl::App("index.html#/float".into()),
    )
    .title("赶词工悬浮球")
    .inner_size(BALL_SIZE, BALL_SIZE)
    .position(x, y)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .focusable(false)
    .visible(false);

    let win = match builder.build() {
        Ok(w) => w,
        Err(err) => {
            let state = app.state::<AppState>();
            crate::db::log_event(
                &lock(&state.db),
                "floatball_window_error",
                Some(json!({ "message": err.to_string() })),
            );
            return;
        }
    };

    attach_ball_events(app, &win);

    // 先按保存位置摆好、钳进屏幕，再显示，避免开机时闪一下错位
    let h = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(80));
        if let Some(w) = h.get_webview_window(BALL_LABEL) {
            // 创建时 DPI 还不知道，窗口可能被撑宽；这里按逻辑像素再钉一次
            let _ = w.set_size(LogicalSize::new(BALL_SIZE, BALL_SIZE));
            clamp_ball(&w);
            let _ = w.show();
            if let Some((x, y, _, _)) = clamp_ball(&w) {
                remember_position(&h, &w, x, y);
            }
        }
    });
}

/// 开关悬浮球。窗口的创建/销毁不能在调用方自己的 IPC 回调里同步做，
/// 否则 WebView2 关自己时主线程会卡死（菜单里点“隐藏悬浮球”同理）。
pub fn set_enabled(app: &AppHandle, enabled: bool) {
    let handle = app.clone();
    std::thread::spawn(move || {
        if enabled {
            spawn(&handle);
        } else {
            destroy(&handle);
        }
    });
}

pub fn destroy(app: &AppHandle) {
    close_menu(app);
    if let Some(win) = app.get_webview_window(BALL_LABEL) {
        let _ = win.destroy();
    }
}

pub fn set_visible(app: &AppHandle, visible: bool) {
    if !visible {
        // 从菜单发起复习时，这里不能同步销毁菜单自己
        let handle = app.clone();
        std::thread::spawn(move || close_menu(&handle));
    }
    if let Some(win) = app.get_webview_window(BALL_LABEL) {
        if visible {
            let _ = win.show();
        } else {
            let _ = win.hide();
        }
    }
}

pub fn close_menu(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MENU_LABEL) {
        let _ = win.destroy();
    }
}

fn open_menu(app: &AppHandle) {
    close_menu(app);

    let Some(ball) = app.get_webview_window(BALL_LABEL) else {
        return;
    };
    let Some((bx, by, bw, bh)) = ball_rect(&ball) else {
        return;
    };
    let Some((wx, wy, ww, wh)) = work_area(&ball) else {
        return;
    };
    let scale = ball.scale_factor().unwrap_or(1.0);
    let mw = (MENU_WIDTH * scale).round() as i32;
    let mh = (MENU_HEIGHT * scale).round() as i32;
    let gap = (8.0 * scale).round() as i32;
    let margin = (EDGE_MARGIN * scale).round() as i32;

    // 优先出现在球的左侧，左边放不下再翻到右侧
    let left_x = bx - mw - gap;
    let x = if left_x >= wx + margin {
        left_x
    } else {
        bx + bw + gap
    };
    let hi_x = (wx + ww - mw - margin).max(wx + margin);
    let x = x.clamp(wx + margin, hi_x);

    let center_y = by + bh / 2;
    let hi_y = (wy + wh - mh - margin).max(wy + margin);
    let y = (center_y - mh / 2).clamp(wy + margin, hi_y);

    let builder = WebviewWindowBuilder::new(
        app,
        MENU_LABEL,
        WebviewUrl::App("index.html#/float-menu".into()),
    )
    .title("赶词工快捷菜单")
    .inner_size(MENU_WIDTH, MENU_HEIGHT)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .maximizable(false)
    .minimizable(false)
    .closable(false)
    .focused(true)
    .visible(false);

    let win = match builder.build() {
        Ok(w) => w,
        Err(err) => {
            let state = app.state::<AppState>();
            crate::db::log_event(
                &lock(&state.db),
                "floatball_menu_error",
                Some(json!({ "message": err.to_string() })),
            );
            return;
        }
    };

    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.show();
    let _ = win.set_focus();

    // 点菜单外任意位置即收起；刚创建时的失焦事件忽略
    let born = Instant::now();
    let handle = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            if born.elapsed() < Duration::from_millis(250) {
                return;
            }
            let h = handle.clone();
            std::thread::spawn(move || close_menu(&h));
        }
    });
}

pub fn toggle_menu(app: &AppHandle) {
    if app.get_webview_window(MENU_LABEL).is_some() {
        close_menu(app);
    } else {
        open_menu(app);
    }
}

#[tauri::command]
pub fn float_menu_toggle(app: AppHandle) {
    // 同样挪到后台线程：菜单可能是被自己页面的点击打开的，别在主线程里建/毁窗口
    std::thread::spawn(move || toggle_menu(&app));
}

#[tauri::command]
pub fn float_menu_close(app: AppHandle) {
    std::thread::spawn(move || close_menu(&app));
}

/// 显示主窗口并跳到指定路由（悬浮球菜单用）
#[tauri::command]
pub fn open_main(app: AppHandle, path: Option<String>) {
    crate::review_windows::show_main(&app);
    let Some(path) = path else {
        return;
    };
    if !path.starts_with('/') || path.len() > 120 {
        return;
    }
    let _ = app.emit_to("main", "app:navigate", path);
}