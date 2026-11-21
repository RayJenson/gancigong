use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

fn load_icon(app: &AppHandle) -> Option<tauri::image::Image<'_>> {
    // 构建时嵌入的品牌图标（icons/32x32.png），托盘按系统 DPI 自动缩放
    app.default_window_icon().cloned()
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "打开赶词工", true, None::<&str>)?;
    let review = MenuItem::with_id(app, "review", "立即复习一轮", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &review, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("ganci")
        .tooltip("赶词工 · 别让单词等你")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => crate::review_windows::show_main(app),
            "review" => {
                let _ = crate::flow::start_round(app, true, crate::rounds::PickScope::Mixed);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                crate::review_windows::show_main(tray.app_handle());
            }
        });

    if let Some(icon) = load_icon(app) {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

pub fn update_tooltip(app: &AppHandle, text: &str) {
    if let Some(tray) = app.tray_by_id("ganci") {
        let _ = tray.set_tooltip(Some(text));
    }
}
