use crate::models::TimeWindow;
use chrono::{Datelike, Local, TimeZone, Timelike};

pub const DAY_MS: i64 = 86_400_000;

pub fn now() -> i64 {
    Local::now().timestamp_millis()
}

pub fn start_of_day(ts: i64) -> i64 {
    let Some(dt) = Local.timestamp_millis_opt(ts).single() else {
        return ts;
    };
    let naive = dt.date_naive().and_hms_opt(0, 0, 0).unwrap();
    naive
        .and_local_timezone(Local)
        .earliest()
        .map(|d| d.timestamp_millis())
        .unwrap_or(ts)
}

pub fn day_key(ts: i64) -> String {
    match Local.timestamp_millis_opt(ts).single() {
        Some(d) => format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day()),
        None => String::new(),
    }
}

pub fn parse_hhmm(value: &str) -> Option<i64> {
    let s = value.trim();
    let (h, m) = s.split_once(':')?;
    let h: i64 = h.parse().ok()?;
    let m: i64 = m.parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

pub fn to_hhmm(ts: i64) -> String {
    match Local.timestamp_millis_opt(ts).single() {
        Some(d) => format!("{:02}:{:02}", d.hour(), d.minute()),
        None => String::new(),
    }
}

/// 有效时段：start < end，其余按非法丢弃
pub fn valid_windows(windows: &[TimeWindow]) -> Vec<(i64, i64)> {
    let mut out: Vec<(i64, i64)> = windows
        .iter()
        .filter_map(|w| {
            let start = parse_hhmm(&w.start)?;
            let end = parse_hhmm(&w.end)?;
            if end > start {
                Some((start, end))
            } else {
                None
            }
        })
        .collect();
    out.sort_by_key(|w| w.0);
    out
}

pub fn in_any_window(ts: i64, windows: &[TimeWindow]) -> bool {
    let mins = (ts - start_of_day(ts)) / 60_000;
    valid_windows(windows)
        .iter()
        .any(|(start, end)| mins >= *start && mins <= *end)
}

/// 从 from 起（含）往后找第一个落在时段网格上的触发点，网格以每个时段起点为基准
pub fn next_grid_point(from: i64, windows: &[TimeWindow], interval_minutes: i64) -> Option<i64> {
    let valid = valid_windows(windows);
    let step = interval_minutes.max(1) * 60_000;
    let floor = from.max(start_of_day(from));
    let base_day = start_of_day(from);
    for day_offset in 0..400 {
        let day_start = base_day + day_offset * DAY_MS;
        if day_start > floor + 400 * DAY_MS {
            break;
        }
        for (start, end) in &valid {
            let open_at = day_start + start * 60_000;
            let close_at = day_start + end * 60_000;
            let mut t = open_at;
            while t <= close_at {
                if t >= floor {
                    return Some(t);
                }
                t += step;
            }
        }
    }
    None
}

pub fn clamp_into_window(ts: i64, windows: &[TimeWindow], interval_minutes: i64) -> Option<i64> {
    if in_any_window(ts, windows) {
        Some(ts)
    } else {
        next_grid_point(ts + 1, windows, interval_minutes)
    }
}

pub fn format_countdown(target: Option<i64>, now_ts: i64) -> String {
    let Some(target) = target else {
        return "暂无排程".into();
    };
    let diff = target - now_ts;
    if diff <= 0 {
        return "现在".into();
    }
    let mins = diff / 60_000;
    if mins < 1 {
        return format!("{} 秒后", (diff / 1000).max(0));
    }
    if mins < 60 {
        return format!("{mins} 分钟后");
    }
    let hours = mins / 60;
    if hours < 24 {
        return format!("{} 小时 {} 分后", hours, mins % 60);
    }
    format!("{} 天后", hours / 24)
}

/// 艾宾浩斯复习阶梯（分钟）：5 分 → 30 分 → 12 小时 → 1/2/4/7/15/30/60 天
pub const REVIEW_LADDER_MINUTES: [i64; 10] = [
    5,
    30,
    720,
    1_440,
    2_880,
    5_760,
    10_080,
    21_600,
    43_200,
    86_400,
];

/// 间隔爬到 7 天视为已掌握
pub const MASTERED_FROM_MINUTES: i64 = 10_080;

pub fn interval_after_know(current_minutes: i64) -> i64 {
    REVIEW_LADDER_MINUTES
        .iter()
        .find(|v| **v > current_minutes)
        .copied()
        .unwrap_or(*REVIEW_LADDER_MINUTES.last().unwrap())
}

/// 遗忘回到阶梯起点，5 分钟后再见一次
pub fn interval_after_forget() -> i64 {
    REVIEW_LADDER_MINUTES[0]
}

pub fn apply_rating_minutes(current_minutes: i64, rating: i64) -> i64 {
    if rating == 1 {
        interval_after_know(current_minutes)
    } else {
        interval_after_forget()
    }
}
