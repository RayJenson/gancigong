use crate::db::log_event;
use crate::models::Settings;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

const KEYS: [&str; 20] = [
    "windows",
    "intervalMinutes",
    "wordsPerRound",
    "dailyNewWords",
    "mode",
    "practiceMode",
    "lockLevel",
    "lockAllDisplays",
    "delayQuotaPerDay",
    "delayMinutes",
    "ttsEnabled",
    "autostart",
    "activeListId",
    "themeMode",
    "themeAccent",
    "themeBackground",
    "themeScrim",
    "floatBall",
    "floatX",
    "floatY",
];

pub fn load(conn: &Connection) -> Settings {
    let defaults = serde_json::to_value(Settings::default()).unwrap_or_else(|_| json!({}));
    let mut obj = defaults.as_object().cloned().unwrap_or_default();
    for key in KEYS {
        let stored: Option<String> = match conn
            .query_row("select value_json from settings where key = ?1", [key], |r| r.get(0))
            .optional()
        {
            Ok(v) => v,
            Err(_) => None,
        };
        if let Some(raw) = stored {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                obj.insert(key.to_string(), value);
            }
        }
    }
    Settings::from_value(&Value::Object(obj))
}

pub fn save(conn: &Connection, s: &Settings) {
    let Ok(Value::Object(map)) = serde_json::to_value(s) else {
        return;
    };
    let _ = conn.execute_batch("begin");
    for (key, value) in map {
        let _ = conn.execute(
            "insert into settings (key, value_json) values (?1, ?2)
             on conflict(key) do update set value_json = excluded.value_json",
            rusqlite::params![key, value.to_string()],
        );
    }
    let _ = conn.execute_batch("commit");
}

/// 只覆盖 patch 里出现的字段，再做一遍 sanitize
pub fn merge(current: &Settings, patch: &Value) -> Settings {
    let Ok(Value::Object(mut base)) = serde_json::to_value(current) else {
        return current.clone();
    };
    if let Value::Object(p) = patch {
        for (k, v) in p {
            base.insert(k.clone(), v.clone());
        }
    }
    Settings::from_value(&Value::Object(base))
}

pub fn change_requires_recompute(before: &Settings, after: &Settings) -> bool {
    serde_json::to_string(&before.windows).ok() != serde_json::to_string(&after.windows).ok()
        || before.interval_minutes != after.interval_minutes
        || before.active_list_id != after.active_list_id
}

pub fn log_change(conn: &Connection, before: &Settings, after: &Settings) {
    log_event(
        conn,
        "settings_changed",
        Some(json!({
            "before": before,
            "after": after,
        })),
    );
}
