use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum ReviewMode {
    #[default]
    Gentle,
    Fullscreen,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum PracticeMode {
    #[default]
    Auto,
    Spell,
    Choice,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum LockLevel {
    #[default]
    App,
    Kiosk,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeMode {
    Light,
    Dark,
    #[default]
    System,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemeAccent {
    #[default]
    Pine,
    Ocean,
    Sakura,
    Violet,
    Amber,
    Slate,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TimeWindow {
    pub id: String,
    pub start: String,
    pub end: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub windows: Vec<TimeWindow>,
    pub interval_minutes: i64,
    pub words_per_round: i64,
    pub daily_new_words: i64,
    pub mode: ReviewMode,
    pub practice_mode: PracticeMode,
    pub lock_level: LockLevel,
    pub lock_all_displays: bool,
    pub delay_quota_per_day: i64,
    pub delay_minutes: i64,
    pub tts_enabled: bool,
    pub autostart: bool,
    pub active_list_id: Option<i64>,
    pub theme_mode: ThemeMode,
    pub theme_accent: ThemeAccent,
    /// 数据目录 theme/ 下的文件名，空串表示没有自定义背景
    pub theme_background: String,
    /// 0–100，越大背景越清楚
    pub theme_scrim: i64,
    /// 桌面悬浮球常驻开关
    pub float_ball: bool,
    /// 悬浮球上次的位置（逻辑像素），None = 使用默认位置
    pub float_x: Option<i64>,
    pub float_y: Option<i64>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            windows: vec![TimeWindow {
                id: "w1".into(),
                start: "09:00".into(),
                end: "21:30".into(),
            }],
            interval_minutes: 20,
            words_per_round: 10,
            daily_new_words: 10,
            mode: ReviewMode::Gentle,
            practice_mode: PracticeMode::Auto,
            lock_level: LockLevel::App,
            lock_all_displays: true,
            delay_quota_per_day: 3,
            delay_minutes: 10,
            tts_enabled: true,
            autostart: false,
            active_list_id: None,
            theme_mode: ThemeMode::System,
            theme_accent: ThemeAccent::Pine,
            theme_background: String::new(),
            theme_scrim: 60,
            float_ball: true,
            float_x: None,
            float_y: None,
        }
    }
}

fn num(v: &Value, key: &str, min: i64, max: i64, def: i64) -> i64 {
    match v.get(key).and_then(|x| x.as_f64()) {
        Some(f) if f.is_finite() => (f.round() as i64).clamp(min, max),
        _ => def,
    }
}

fn text<'a>(v: &'a Value, key: &str, def: &'a str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or(def)
}

fn flag(v: &Value, key: &str, def: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(def)
}

impl Settings {
    /// 与 Electron 端 sanitize 同规则：非法/越界值回退默认
    pub fn from_value(v: &Value) -> Self {
        let d = Settings::default();
        let mut windows = Vec::new();
        if let Some(arr) = v.get("windows").and_then(|x| x.as_array()) {
            for (i, w) in arr.iter().enumerate() {
                let (Some(start), Some(end)) = (
                    w.get("start").and_then(|x| x.as_str()),
                    w.get("end").and_then(|x| x.as_str()),
                ) else {
                    continue;
                };
                if start.is_empty() || start == end {
                    continue;
                }
                let id = w
                    .get("id")
                    .and_then(|x| x.as_str())
                    .filter(|s| !s.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| format!("w{}", i + 1));
                windows.push(TimeWindow {
                    id,
                    start: start.to_string(),
                    end: end.to_string(),
                });
            }
        }
        if windows.is_empty() {
            windows = d.windows.clone();
        }
        let active_list = v
            .get("activeListId")
            .and_then(|x| x.as_f64())
            .filter(|f| f.is_finite() && f.fract() == 0.0)
            .map(|f| f as i64);
        Self {
            windows,
            interval_minutes: num(v, "intervalMinutes", 1, 240, d.interval_minutes),
            words_per_round: num(v, "wordsPerRound", 1, 60, d.words_per_round),
            daily_new_words: num(v, "dailyNewWords", 1, 100, d.daily_new_words),
            mode: match text(v, "mode", "gentle") {
                "fullscreen" => ReviewMode::Fullscreen,
                "gentle" => ReviewMode::Gentle,
                _ => d.mode,
            },
            practice_mode: match text(v, "practiceMode", "auto") {
                "spell" => PracticeMode::Spell,
                "choice" => PracticeMode::Choice,
                "auto" => PracticeMode::Auto,
                _ => d.practice_mode,
            },
            lock_level: match text(v, "lockLevel", "app") {
                "kiosk" => LockLevel::Kiosk,
                "app" => LockLevel::App,
                _ => d.lock_level,
            },
            lock_all_displays: flag(v, "lockAllDisplays", d.lock_all_displays),
            delay_quota_per_day: num(v, "delayQuotaPerDay", 0, 20, d.delay_quota_per_day),
            delay_minutes: num(v, "delayMinutes", 1, 120, d.delay_minutes),
            tts_enabled: flag(v, "ttsEnabled", d.tts_enabled),
            autostart: flag(v, "autostart", d.autostart),
            active_list_id: active_list,
            theme_mode: match text(v, "themeMode", "system") {
                "light" => ThemeMode::Light,
                "dark" => ThemeMode::Dark,
                "system" => ThemeMode::System,
                _ => d.theme_mode,
            },
            theme_accent: match text(v, "themeAccent", "pine") {
                "ocean" => ThemeAccent::Ocean,
                "sakura" => ThemeAccent::Sakura,
                "violet" => ThemeAccent::Violet,
                "amber" => ThemeAccent::Amber,
                "slate" => ThemeAccent::Slate,
                "pine" => ThemeAccent::Pine,
                _ => d.theme_accent,
            },
            theme_background: safe_file_name(text(v, "themeBackground", "")),
            theme_scrim: num(v, "themeScrim", 0, 100, d.theme_scrim),
            float_ball: flag(v, "floatBall", d.float_ball),
            float_x: opt_coord(v, "floatX"),
            float_y: opt_coord(v, "floatY"),
        }
    }
}

/// 悬浮球坐标：只接受有限数值，钳到 i32 范围内防止异常值
fn opt_coord(v: &Value, key: &str) -> Option<i64> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .filter(|f| f.is_finite())
        .map(|f| (f.round() as i64).clamp(-100_000, 100_000))
}

/// 只接受纯文件名，防止渲染层传入路径穿越
fn safe_file_name(name: &str) -> String {
    let ok = !name.is_empty()
        && name.len() <= 120
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !name.contains("..");
    if ok {
        name.to_string()
    } else {
        String::new()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WordInput {
    pub term: Option<String>,
    pub phonetic: Option<String>,
    pub meaning: Option<String>,
    pub example: Option<String>,
    pub tags: Option<String>,
    /// None = 不改；Some(0) = 移出单元；Some(id) = 归入单元
    pub unit_id: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct WordQuery {
    pub list_id: Option<i64>,
    /// 0 = 只看未分单元的单词
    pub unit_id: Option<i64>,
    pub query: Option<String>,
    pub need_meaning_only: Option<bool>,
    /// 打字练习取词范围：all / dueToday / learnedToday / learned / wrong
    pub scope: Option<String>,
    pub sort: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WordRow {
    pub id: i64,
    pub list_id: i64,
    pub unit_id: Option<i64>,
    pub unit_name: String,
    pub term: String,
    pub phonetic: String,
    pub meaning: String,
    pub example: String,
    pub tags: String,
    pub need_meaning: i64,
    pub created_at: i64,
    pub interval_days: i64,
    pub interval_minutes: i64,
    pub due_at: Option<i64>,
    pub reps: i64,
    pub lapses: i64,
    pub last_rating: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FormItem {
    pub form: String,
    pub label: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum CardMode {
    Spell,
    Choice,
    Reveal,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CardData {
    pub word_id: i64,
    pub term: String,
    pub phonetic: String,
    pub meaning: String,
    pub example: String,
    pub forms: Vec<FormItem>,
    pub mode: CardMode,
    pub options: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LearnRound {
    pub cards: Vec<CardData>,
    pub wrong_today: Vec<WrongWord>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LearnEntry {
    pub word_id: i64,
    pub rating: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LearnFinish {
    pub rated: i64,
    pub known: i64,
    pub wrong_today: Vec<WrongWord>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WrongWord {
    pub word_id: i64,
    pub term: String,
    pub phonetic: String,
    pub meaning: String,
}

/// 永久错词本条目：一旦答错就留在这里，只有手动移出才会删除
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WrongBookEntry {
    pub word_id: i64,
    pub term: String,
    pub phonetic: String,
    pub meaning: String,
    pub last_wrong_at: i64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WrongBookCounts {
    pub today: i64,
    pub total: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoundPlan {
    pub round_id: i64,
    pub mode: ReviewMode,
    pub lock_level: LockLevel,
    pub tts_enabled: bool,
    pub delay_quota_left: i64,
    pub cards: Vec<CardData>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ListInfo {
    pub id: i64,
    pub name: String,
    pub remark: String,
    pub word_count: i64,
    pub due_count: i64,
    pub unit_count: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UnitInfo {
    pub id: i64,
    pub list_id: i64,
    pub name: String,
    pub position: i64,
    pub word_count: i64,
    pub due_count: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UpsertResult {
    pub row: WordRow,
    pub from_dictionary: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct WordCounts {
    pub total: i64,
    pub mastered: i64,
    pub fresh: i64,
    pub need_meaning: i64,
    pub due_now: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct QuotaState {
    pub used: i64,
    pub quota: i64,
    pub left: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DayStat {
    pub day: String,
    pub words: i64,
    pub known: i64,
    pub rate: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RoundSummary {
    pub id: i64,
    pub planned_at: i64,
    pub mode: String,
    pub planned: i64,
    pub rated: i64,
    pub status: String,
    pub know_rate: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DashboardState {
    pub next_fire_at: Option<i64>,
    /// next_fire_at 被设定的时刻，null 表示当前没有排程
    pub schedule_set_at: Option<i64>,
    pub next_fire_reason: String,
    pub active_list_id: Option<i64>,
    pub active_list_name: String,
    pub due_today: i64,
    pub due_tomorrow: i64,
    pub due_after_tomorrow: i64,
    pub review_due: i64,
    pub mastered: i64,
    pub fresh: i64,
    pub daily_new_words: i64,
    pub new_today: i64,
    pub need_meaning: i64,
    pub total_words: i64,
    pub delay_used: i64,
    pub delay_quota: i64,
    pub delay_minutes: i64,
    pub mode: ReviewMode,
    pub lock_level: LockLevel,
    pub rounds_today: i64,
    pub words_today: i64,
    pub recent_rounds: Vec<RoundSummary>,
    pub windows: Vec<TimeWindow>,
    pub interval_minutes: i64,
    pub scheduler_active: bool,
    /// 今日错词（错词本里今天新增的）
    pub wrong_today: i64,
    /// 错词本里的全部错词
    pub wrong_total: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryStatus {
    pub loaded: bool,
    pub count: i64,
    pub source: String,
    pub generated_at: String,
    pub bytes: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SettingsBundle {
    pub settings: Settings,
    pub dictionary: DictionaryStatus,
    pub data_dir: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ThemeState {
    pub mode: ThemeMode,
    pub accent: ThemeAccent,
    pub background_url: Option<String>,
    pub scrim: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TopLapse {
    pub term: String,
    pub meaning: String,
    pub lapses: i64,
    pub reps: i64,
    pub interval_days: i64,
    pub interval_minutes: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatsOverview {
    pub counts: WordCounts,
    pub daily: Vec<DayStat>,
    pub top_lapses: Vec<TopLapse>,
    pub streak: i64,
    pub words_today: i64,
    pub know_rate_today: Option<i64>,
    pub delay: QuotaState,
    pub rounds_done: i64,
    pub next_fire_at: Option<i64>,
    pub settings: StatsSettings,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StatsSettings {
    pub mode: ReviewMode,
    pub lock_level: LockLevel,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FlowStatus {
    pub next_fire_at: Option<i64>,
    /// next_fire_at 被设定的时刻，null 表示当前没有排程
    pub schedule_set_at: Option<i64>,
    pub reason: String,
    pub scheduler_active: bool,
    pub session_round_id: Option<i64>,
    pub kiosk_engaged: bool,
    pub escape_shortcut_ready: bool,
    pub escape_shortcut_combo: String,
    pub delay: QuotaState,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StartResult {
    pub ok: bool,
    pub reason: Option<String>,
    pub round_id: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RateResult {
    pub next_due_at: i64,
    pub interval_days: i64,
    pub interval_minutes: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DelayResult {
    pub ok: bool,
    pub left: i64,
    pub minutes: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct KioskStatus {
    pub engaged: bool,
    pub pid: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LookupHit {
    pub term: String,
    pub phonetic: String,
    pub meaning: String,
    pub tags: Vec<String>,
    pub forms: Vec<FormItem>,
    pub matched_via: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CsvPick {
    pub path: String,
    pub name: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub count: i64,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub created: i64,
    pub updated: i64,
    pub skipped: i64,
    pub filled_from_dict: i64,
    pub missing_meaning: i64,
    pub total_rows: i64,
    pub errors: Vec<String>,
    pub file_name: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DelayDeniedPayload {
    pub round_id: i64,
    pub used: i64,
    pub quota: i64,
}
