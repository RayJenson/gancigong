use crate::models::Settings;
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
    recompute_with(state, false);
}

/// 一轮复习结束后的重排：作答耗时不计入等待，从结束时刻起至少再隔一个完整间隔，
/// 否则拖得越久，下一轮离结束就越近，容易刚关窗又弹出来。
pub fn recompute_after_round(state: &AppState) {
    recompute_with(state, true);
}

fn recompute_with(state: &AppState, after_round: bool) {
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
    match schedule_point(due, now(), &settings, after_round) {
        Some(point) => set(state, Some(point), "scheduled"),
        None => set(state, None, "paused"),
    }
}

/// 算出下一次触发时刻。after_round 时以「结束时刻 + 完整间隔」为下限，
/// 让弹窗停留、作答耗时不会吃掉下一轮的等待时间。
fn schedule_point(due: i64, from: i64, settings: &Settings, after_round: bool) -> Option<i64> {
    // 已经到期还压着没复习（比如刚中断一轮）：至少隔一个网格点再提醒，避免立刻重弹
    let base = if due <= from {
        next_grid_point(from + 1000, &settings.windows, settings.interval_minutes)?
    } else {
        due
    };
    let mut point = clamp_into_window(base, &settings.windows, settings.interval_minutes);
    if after_round {
        let floor = from + settings.interval_minutes.max(1) * 60_000;
        if let Some(floor) = clamp_into_window(floor, &settings.windows, settings.interval_minutes) {
            point = Some(point.map_or(floor, |p| p.max(floor)));
        }
    }
    point
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TimeWindow;
    use crate::util::{start_of_day, DAY_MS};
    use chrono::Local;

    fn settings_with(start: &str, end: &str, interval: i64) -> Settings {
        Settings {
            windows: vec![TimeWindow {
                id: "w".into(),
                start: start.into(),
                end: end.into(),
            }],
            interval_minutes: interval,
            ..Settings::default()
        }
    }

    fn at(hour: u32, minute: u32) -> i64 {
        Local::now()
            .date_naive()
            .and_hms_opt(hour, minute, 0)
            .unwrap()
            .and_local_timezone(Local)
            .earliest()
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn after_round_waits_full_interval_even_if_due_soon() {
        let s = settings_with("00:00", "23:59", 20);
        let from = at(10, 0);
        let next = schedule_point(from + 5 * 60_000, from, &s, true).unwrap();
        assert_eq!(next, from + 20 * 60_000);
    }

    #[test]
    fn after_round_keeps_later_due() {
        let s = settings_with("00:00", "23:59", 20);
        let from = at(10, 0);
        let due = from + 12 * 3_600_000;
        assert_eq!(schedule_point(due, from, &s, true), Some(due));
    }

    #[test]
    fn after_round_floor_is_clamped_into_next_window() {
        let s = settings_with("08:00", "12:00", 20);
        let from = at(11, 50);
        let due = from - 60 * 60_000;
        let next = schedule_point(due, from, &s, true).unwrap();
        assert_eq!(next, start_of_day(from) + DAY_MS + 8 * 3_600_000);
    }

    #[test]
    fn normal_recompute_still_uses_grid_for_overdue_words() {
        let s = settings_with("00:00", "23:59", 20);
        let from = at(10, 5);
        let next = schedule_point(from - 5 * 60_000, from, &s, false).unwrap();
        assert_eq!(next, at(10, 20));
    }
}
