use crate::rounds::{earliest_due_at, review_due_count};
use crate::state::{lock, AppState};
use crate::util::{clamp_into_window, next_grid_point, now};
use crate::words::word_counts;
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug)]
pub struct SchedState {
    pub next_fire_at: Option<i64>,
    /// next_fire_at 被设定的时刻，前端用它算「到下一轮」的进度比例
    pub set_at: Option<i64>,
    pub reason: String,
    pub active: bool,
}

impl Default for SchedState {
    fn default() -> Self {
        Self {
            next_fire_at: None,
            set_at: None,
            reason: "idle".into(),
            active: false,
        }
    }
}

fn set(state: &AppState, next: Option<i64>, reason: &str) {
    let mut s = lock(&state.sched);
    if s.next_fire_at != next {
        s.set_at = next.map(|_| now());
    }
    s.next_fire_at = next;
    s.reason = reason.to_string();
}

fn active_list(state: &AppState) -> Option<i64> {
    state.settings().active_list_id.filter(|id| *id != 0)
}

/// 下次提醒由「最早到期的复习词」驱动，而不是固定网格。
/// 复习时段只负责把到期时间钳回可提醒的窗口。
pub fn recompute(state: &AppState) {
    let settings = state.settings();
    let scope = active_list(state);
    let (total, due) = {
        let conn = lock(&state.db);
        (
            word_counts(&conn, scope).total,
            earliest_due_at(&conn, scope),
        )
    };
    if total == 0 {
        mark_out_of_words(state);
        return;
    }
    if settings.windows.is_empty() {
        set(state, None, "paused");
        return;
    }
    let Some(due) = due else {
        // 还没有排过复习的词，不预告下一次，等学完新词再排
        set(state, None, "no_due");
        return;
    };
    let from = now();
    // 已经到期还压着没复习（比如刚中断一轮）：至少隔一个网格点再提醒，避免立刻重弹
    let base = if due <= from {
        match next_grid_point(from + 1000, &settings.windows, settings.interval_minutes) {
            Some(point) => point,
            None => {
                set(state, None, "paused");
                return;
            }
        }
    } else {
        due
    };
    match clamp_into_window(base, &settings.windows, settings.interval_minutes) {
        Some(point) => set(state, Some(point), "scheduled"),
        None => set(state, None, "paused"),
    }
}

/// 延后：下一次触发点挪到 now + delayMinutes，落在时段外则钳回时段
pub fn apply_delay(state: &AppState) -> Option<i64> {
    let settings = state.settings();
    let target = now() + settings.delay_minutes * 60_000;
    let clamped = clamp_into_window(target, &settings.windows, settings.interval_minutes);
    match clamped {
        Some(_) => set(state, clamped, "delayed"),
        None => set(state, None, "paused"),
    }
    clamped
}

/// 词库空到抽不出任何词：停掉排程，直到有词录入再恢复
pub fn mark_out_of_words(state: &AppState) {
    set(state, None, "out_of_words");
}

/// 词数变化之后对齐排程
pub fn sync_word_availability(state: &AppState) {
    let total = {
        let conn = lock(&state.db);
        word_counts(&conn, active_list(state)).total
    };
    if total == 0 {
        // 时段本身没配时「已暂停」更重要，别用「没词」盖掉它
        let reason = lock(&state.sched).reason.clone();
        if reason != "paused" {
            mark_out_of_words(state);
        }
    } else {
        recompute(state);
    }
}

pub fn status(state: &AppState) -> (Option<i64>, Option<i64>, String, bool) {
    let s = lock(&state.sched);
    (s.next_fire_at, s.set_at, s.reason.clone(), s.active)
}

fn busy(state: &AppState) -> bool {
    if lock(&state.session).is_some() {
        return true;
    }
    !lock(&state.rounds).is_empty()
}

fn tick(app: &AppHandle) {
    let state = app.state::<AppState>();
    // 正在学新词时不打断；离开学习页后 learn_resume 会重排
    if state.is_learning() {
        return;
    }
    let (next, active) = {
        let s = lock(&state.sched);
        (s.next_fire_at, s.active)
    };
    if !active {
        return;
    }
    let Some(at) = next else { return };
    if now() < at {
        return;
    }
    if busy(&state) {
        return;
    }
    let due = {
        let conn = lock(&state.db);
        review_due_count(&conn, active_list(&state))
    };
    if due == 0 {
        // 到点却没有到期词：不弹复习窗口，直接接回下一次
        recompute(&state);
        crate::flow::notify_schedule_changed(app);
        crate::flow::notify_data_changed(app);
        return;
    }
    recompute(&state);
    if !crate::flow::start_round(app, false, crate::rounds::PickScope::Due).ok {
        recompute(&state);
    }
}

pub fn start_ticker(app: AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut s = lock(&state.sched);
        s.active = true;
    }
    recompute(&app.state::<AppState>());
    std::thread::spawn(move || {
        let mut ticks: u64 = 0;
        while crate::RUNNING.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            ticks += 1;
            tick(&app);
            if ticks % 20 == 0 {
                crate::refresh_tray_tooltip(&app);
            }
        }
    });
}
