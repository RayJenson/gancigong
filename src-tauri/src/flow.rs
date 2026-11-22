use crate::db::log_event;
use crate::kiosk;
use crate::models::*;
use crate::review_windows;
use crate::rounds::{self, ActiveRound};
use crate::scheduler;
use crate::state::{lock, AppState};
use crate::util::now;
use serde_json::json;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

pub const ESCAPE_SHORTCUT: &str = "CommandOrControl+Alt+Escape";

pub fn notify_data_changed(app: &AppHandle) {
    let _ = app.emit("data:changed", ());
}

pub fn notify_schedule_changed(app: &AppHandle) {
    let _ = app.emit("schedule:changed", flow_status(app));
}

pub fn flow_status(app: &AppHandle) -> FlowStatus {
    let state = app.state::<AppState>();
    let (next, set_at, reason, active) = scheduler::status(&state);
    let (next, set_at, reason) = if state.is_learning() {
        (None, None, "learning".to_string())
    } else {
        (next, set_at, reason)
    };
    let session_round_id = lock(&state.session).as_ref().map(|s| s.round_id);
    let delay = {
        let s = state.settings();
        let conn = lock(&state.db);
        rounds::quota_state(&conn, &s)
    };
    FlowStatus {
        next_fire_at: next,
        schedule_set_at: set_at,
        reason,
        scheduler_active: active,
        session_round_id,
        kiosk_engaged: kiosk::is_engaged(app),
        escape_shortcut_ready: state.escape_ready.load(Ordering::SeqCst),
        escape_shortcut_combo: ESCAPE_SHORTCUT.into(),
        delay,
    }
}

pub fn start_round(app: &AppHandle, manual: bool, pick: rounds::PickScope) -> StartResult {
    let state = app.state::<AppState>();
    let running = if lock(&state.session).is_some() {
        true
    } else {
        !lock(&state.rounds).is_empty()
    };
    if running {
        return StartResult {
            ok: false,
            reason: Some("already_running".into()),
            round_id: None,
        };
    }

    let settings = state.settings();
    let opened = {
        let conn = lock(&state.db);
        rounds::open_round(
            &conn,
            state.dict(),
            &settings,
            settings.mode,
            now(),
            !manual,
            pick,
        )
    };
    let round = match opened {
        Ok(Some(r)) => r,
        Ok(None) => {
            // 自动轮次抽不到词不再当成词库空了，按当前到期情况重排
            if !manual {
                scheduler::recompute(&state);
            }
            notify_data_changed(app);
            return StartResult {
                ok: false,
                reason: Some(if manual { "no_words" } else { "out_of_words" }.into()),
                round_id: None,
            };
        }
        Err(err) => {
            let conn = lock(&state.db);
            log_event(&conn, "open_round_failed", Some(json!({ "message": err })));
            return StartResult {
                ok: false,
                reason: Some(err),
                round_id: None,
            };
        }
    };

    let round_id = round.id;
    lock(&state.rounds).insert(round_id, round);
    let handle = app.clone();
    std::thread::spawn(move || launch(&handle, round_id));
    StartResult {
        ok: true,
        reason: None,
        round_id: Some(round_id),
    }
}

fn launch(app: &AppHandle, round_id: i64) {
    let state = app.state::<AppState>();
    let escape_ready = state.escape_ready.load(Ordering::SeqCst);
    let mut degraded_escape = false;
    let (mode, mut lock_level) = {
        let mut map = lock(&state.rounds);
        let Some(round) = map.get_mut(&round_id) else {
            return;
        };
        if round.mode == ReviewMode::Fullscreen && !escape_ready {
            // 逃生键没注册上就绝不锁桌面，退回温和弹窗
            round.mode = ReviewMode::Gentle;
            degraded_escape = true;
        }
        (round.mode, round.lock_level)
    };
    if degraded_escape {
        let conn = lock(&state.db);
        let _ = conn.execute(
            "update rounds set mode = 'gentle' where id = ?1",
            [round_id],
        );
        log_event(
            &conn,
            "escape_missing_degraded",
            Some(json!({ "roundId": round_id })),
        );
    }

    if mode == ReviewMode::Fullscreen && lock_level == LockLevel::Kiosk {
        let app2 = app.clone();
        let result = kiosk::engage(app, move |_, reason, released| {
            if released {
                return;
            }
            crate::flow::on_kiosk_exit(&app2, round_id, &reason);
        });
        if let Err(err) = result {
            {
                let mut map = lock(&state.rounds);
                if let Some(round) = map.get_mut(&round_id) {
                    round.lock_level = LockLevel::App;
                }
            }
            lock_level = LockLevel::App;
            let conn = lock(&state.db);
            let _ = conn.execute(
                "update rounds set lock_level = 'app' where id = ?1",
                [round_id],
            );
            log_event(&conn, "kiosk_failed", Some(json!({ "error": err })));
        }
    }

    {
        let state = app.state::<AppState>();
        if !lock(&state.rounds).contains_key(&round_id) {
            return;
        }
        let lock_all = state.settings().lock_all_displays;
        let opened = review_windows::open(app, round_id, mode, lock_level, lock_all);
        if !opened {
            // 窗口没建起来就作废这一轮，否则内存里的活跃轮次会把后续复习全挡掉
            {
                let conn = lock(&state.db);
                rounds::abort_round(&conn, round_id, "window_open_failed");
            }
            lock(&state.rounds).remove(&round_id);
            review_windows::close_all(app);
            scheduler::recompute(&state);
        }
    }
    notify_data_changed(app);
    notify_schedule_changed(app);
}

fn on_kiosk_exit(app: &AppHandle, round_id: i64, reason: &str) {
    let state = app.state::<AppState>();
    if lock(&state.rounds).contains_key(&round_id) {
        finalize(app, round_id, true, false, &format!("kiosk_{reason}"));
    }
}

pub fn finalize(app: &AppHandle, round_id: i64, abort: bool, delay: bool, reason: &str) {
    let state = app.state::<AppState>();
    if lock(&state.rounds).contains_key(&round_id) {
        {
            let conn = lock(&state.db);
            if abort {
                rounds::abort_round(&conn, round_id, reason);
            } else {
                rounds::finish_round(&conn, round_id);
            }
        }
        lock(&state.rounds).remove(&round_id);
    }
    review_windows::close_all(app);
    kiosk::release(app);
    if delay {
        scheduler::apply_delay(&state);
    } else {
        scheduler::recompute_after_round(&state);
    }
    notify_data_changed(app);
}

pub fn request_delay(app: &AppHandle, round_id: i64, reason: &str) -> DelayResult {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let after = {
        let conn = lock(&state.db);
        rounds::consume_delay(&conn, &settings, round_id, reason)
    };
    let Some(after) = after else {
        let used = {
            let conn = lock(&state.db);
            rounds::quota_state(&conn, &settings).used
        };
        let _ = app.emit(
            "review:delay-denied",
            DelayDeniedPayload {
                round_id,
                used,
                quota: settings.delay_quota_per_day,
            },
        );
        notify_data_changed(app);
        return DelayResult {
            ok: false,
            left: 0,
            minutes: settings.delay_minutes,
        };
    };
    finalize(app, round_id, false, true, reason);
    DelayResult {
        ok: true,
        left: after.left,
        minutes: settings.delay_minutes,
    }
}

pub fn rate_card(app: &AppHandle, round_id: i64, word_id: i64, rating: i64) -> Option<RateResult> {
    let state = app.state::<AppState>();
    if !lock(&state.rounds).contains_key(&round_id) {
        return None;
    }
    let result = {
        let conn = lock(&state.db);
        rounds::rate(&conn, round_id, word_id, rating).ok()?
    };
    notify_data_changed(app);
    Some(result)
}

pub fn complete_round(app: &AppHandle, round_id: i64) {
    finalize(app, round_id, false, false, "completed");
}

pub fn abort_from_renderer(app: &AppHandle, round_id: i64) {
    finalize(app, round_id, true, false, "renderer_abort");
}

pub fn handle_escape(app: &AppHandle, reason: &str) {
    let state = app.state::<AppState>();
    if let Some(id) = review_windows::session_round(app) {
        if lock(&state.rounds).contains_key(&id) {
            finalize(app, id, true, false, reason);
            return;
        }
    }
    kiosk::release(app);
    scheduler::recompute(&state);
    notify_data_changed(app);
}

/// 仅供调度线程/启动流程使用：取当前活跃轮次
pub fn active_round(state: &AppState, round_id: i64) -> Option<ActiveRound> {
    lock(&state.rounds).get(&round_id).cloned()
}
