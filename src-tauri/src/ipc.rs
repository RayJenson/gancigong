use crate::autostart;
use crate::csv_io;
use crate::flow;
use crate::models::*;
use crate::rounds;
use crate::scheduler;
use crate::settings;
use crate::state::{lock, AppState};
use crate::words;
use rusqlite::OptionalExtension;
use serde_json::Value;
use std::path::Path;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub fn theme_state(state: State<'_, AppState>) -> Result<ThemeState, String> {
    let settings = state.settings();
    Ok(ThemeState {
        mode: settings.theme_mode,
        accent: settings.theme_accent,
        background_url: crate::theme::read_data_url(&state.data_dir, &settings.theme_background),
        scrim: settings.theme_scrim,
    })
}

#[tauri::command]
pub async fn theme_background_pick(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let handle = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        handle
            .dialog()
            .file()
            .set_title("选择背景图片")
            .add_filter("图片", &["png", "jpg", "jpeg", "webp", "bmp", "gif"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };

    let (name, url) = crate::theme::store_image(&state.data_dir, &path)?;
    let before = state.settings();
    let mut next = before.clone();
    next.theme_background = name;
    {
        let conn = lock(&state.db);
        settings::save(&conn, &next);
        settings::log_change(&conn, &before, &next);
    }
    *lock(&state.settings) = next;
    flow::notify_data_changed(&app);
    Ok(Some(url))
}

#[tauri::command]
pub fn theme_background_clear(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let before = state.settings();
    crate::theme::clear(&state.data_dir);
    if before.theme_background.is_empty() {
        return Ok(true);
    }
    let mut next = before.clone();
    next.theme_background = String::new();
    {
        let conn = lock(&state.db);
        settings::save(&conn, &next);
        settings::log_change(&conn, &before, &next);
    }
    *lock(&state.settings) = next;
    flow::notify_data_changed(&app);
    Ok(true)
}

#[tauri::command]
pub fn settings_all(state: State<'_, AppState>) -> Result<SettingsBundle, String> {
    Ok(SettingsBundle {
        settings: state.settings(),
        dictionary: state.dict().status(),
        data_dir: state.data_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub fn settings_set(app: AppHandle, state: State<'_, AppState>, patch: Value) -> Result<Settings, String> {
    let before = state.settings();
    let next = settings::merge(&before, &patch);
    {
        let conn = lock(&state.db);
        settings::save(&conn, &next);
        settings::log_change(&conn, &before, &next);
    }
    *lock(&state.settings) = next.clone();
    if next.autostart != before.autostart {
        autostart::apply(&app, next.autostart);
    }
    if next.float_ball != before.float_ball {
        crate::floatball::set_enabled(&app, next.float_ball);
    }
    if settings::change_requires_recompute(&before, &next) {
        scheduler::recompute(&state);
    }
    flow::notify_schedule_changed(&app);
    flow::notify_data_changed(&app);
    Ok(next)
}

#[tauri::command]
pub fn lists_list(state: State<'_, AppState>) -> Result<Vec<ListInfo>, String> {
    let conn = lock(&state.db);
    words::list_lists(&conn)
}

#[tauri::command(rename_all = "camelCase")]
pub fn lists_create(state: State<'_, AppState>, name: String, remark: Option<String>) -> Result<i64, String> {
    let conn = lock(&state.db);
    words::create_list(&conn, &name, remark.as_deref().unwrap_or(""))
}

#[tauri::command(rename_all = "camelCase")]
pub fn lists_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    name: String,
    remark: Option<String>,
) -> Result<bool, String> {
    {
        let conn = lock(&state.db);
        words::rename_list(&conn, id, &name, remark.as_deref())?;
    }
    flow::notify_data_changed(&app);
    Ok(true)
}

#[tauri::command]
pub fn lists_delete(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<i64, String> {
    let removed = {
        let conn = lock(&state.db);
        words::delete_list(&conn, id)?
    };
    let active = state.settings().active_list_id;
    if active == Some(id) {
        let mut next = state.settings();
        next.active_list_id = None;
        {
            let conn = lock(&state.db);
            settings::save(&conn, &next);
        }
        *lock(&state.settings) = next;
    }
    scheduler::sync_word_availability(&state);
    flow::notify_data_changed(&app);
    Ok(removed)
}

#[tauri::command(rename_all = "camelCase")]
pub fn units_list(state: State<'_, AppState>, list_id: Option<i64>) -> Result<Vec<UnitInfo>, String> {
    let conn = lock(&state.db);
    words::list_units(&conn, list_id.filter(|id| *id != 0))
}

#[tauri::command(rename_all = "camelCase")]
pub fn units_create(
    app: AppHandle,
    state: State<'_, AppState>,
    list_id: i64,
    name: String,
) -> Result<i64, String> {
    let id = {
        let conn = lock(&state.db);
        words::create_unit(&conn, list_id, &name)?
    };
    flow::notify_data_changed(&app);
    Ok(id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn units_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    name: String,
) -> Result<bool, String> {
    {
        let conn = lock(&state.db);
        words::rename_unit(&conn, id, &name)?;
    }
    flow::notify_data_changed(&app);
    Ok(true)
}

#[tauri::command]
pub fn units_delete(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<i64, String> {
    let moved = {
        let conn = lock(&state.db);
        words::delete_unit(&conn, id)?
    };
    flow::notify_data_changed(&app);
    Ok(moved)
}

#[tauri::command(rename_all = "camelCase")]
pub fn words_move(
    app: AppHandle,
    state: State<'_, AppState>,
    ids: Vec<i64>,
    unit_id: Option<i64>,
) -> Result<i64, String> {
    let n = {
        let conn = lock(&state.db);
        words::move_words(&conn, &ids, unit_id)?
    };
    flow::notify_data_changed(&app);
    Ok(n)
}

#[tauri::command]
pub fn words_list(state: State<'_, AppState>, query: WordQuery) -> Result<WordListPage, String> {
    let conn = lock(&state.db);
    let (rows, total) = words::list_words(&conn, &query)?;
    Ok(WordListPage { rows, total })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordListPage {
    rows: Vec<WordRow>,
    total: i64,
}

#[tauri::command(rename_all = "camelCase")]
pub fn words_create(
    app: AppHandle,
    state: State<'_, AppState>,
    list_id: Option<i64>,
    input: WordInput,
) -> Result<UpsertResult, String> {
    let result = {
        let conn = lock(&state.db);
        let target = match list_id {
            Some(id) if id != 0 => id,
            _ => words::ensure_default_list(&conn)?,
        };
        words::create_word(&conn, state.dict(), target, &input)?
    };
    scheduler::sync_word_availability(&state);
    flow::notify_data_changed(&app);
    Ok(result)
}

#[tauri::command]
pub fn words_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
    input: WordInput,
) -> Result<WordRow, String> {
    let row = {
        let conn = lock(&state.db);
        words::update_word(&conn, id, &input)?
    };
    flow::notify_data_changed(&app);
    Ok(row)
}

#[tauri::command]
pub fn words_delete(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>) -> Result<i64, String> {
    let n = {
        let conn = lock(&state.db);
        words::delete_words(&conn, &ids)?
    };
    scheduler::sync_word_availability(&state);
    flow::notify_data_changed(&app);
    Ok(n)
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn words_pick_csv(app: AppHandle) -> Result<Option<CsvPick>, String> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择词表 CSV")
            .add_filter("CSV / TSV / TXT 词表", &["csv", "tsv", "txt"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    Ok(Some(CsvPick {
        name: basename(&path),
        path: path.to_string_lossy().to_string(),
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub fn words_import(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    list_id: Option<i64>,
    unit_id: Option<i64>,
) -> Result<ImportResult, String> {
    let result = {
        let conn = lock(&state.db);
        csv_io::import_file(&conn, state.dict(), Path::new(&path), list_id, unit_id)?
    };
    scheduler::sync_word_availability(&state);
    flow::notify_data_changed(&app);
    Ok(result)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn words_export(
    app: AppHandle,
    state: State<'_, AppState>,
    list_id: Option<i64>,
) -> Result<Option<ExportResult>, String> {
    let default_name = {
        let conn = lock(&state.db);
        match list_id {
            Some(id) => conn
                .query_row("select name from lists where id = ?1", [id], |r| r.get::<_, String>(0))
                .unwrap_or_else(|_| "赶词工词库".into()),
            None => "赶词工词库".into(),
        }
    };
    let file_name = format!("{default_name}.csv");
    let app2 = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app2.dialog()
            .file()
            .set_title("导出词表")
            .set_file_name(&file_name)
            .add_filter("CSV 文件", &["csv"])
            .blocking_save_file()
    })
    .await
    .map_err(|e| e.to_string())?;
    let Some(path) = picked.and_then(|f| f.into_path().ok()) else {
        return Ok(None);
    };
    let count = {
        let conn = lock(&state.db);
        csv_io::export_file(&conn, list_id, &path)?
    };
    Ok(Some(ExportResult {
        count,
        path: path.to_string_lossy().to_string(),
    }))
}

#[tauri::command]
pub fn open_data_dir(app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let dir = state.data_dir.clone();
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
pub fn dict_lookup(state: State<'_, AppState>, term: String) -> Result<Option<LookupHit>, String> {
    Ok(state.dict().lookup(&term))
}

const LEARN_BATCH: i64 = 10;

/// 进入学习页：暂停调度提醒，避免学到一半被复习弹窗打断
#[tauri::command]
pub fn learn_pause(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    state
        .learning
        .store(true, std::sync::atomic::Ordering::SeqCst);
    flow::notify_schedule_changed(&app);
    Ok(true)
}

/// 离开学习页：清掉暂停标记并重排到下一个网格点，不补触发错过的提醒
#[tauri::command]
pub fn learn_resume(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    state
        .learning
        .store(false, std::sync::atomic::Ordering::SeqCst);
    scheduler::recompute(&state);
    flow::notify_schedule_changed(&app);
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn learn_start(
    state: State<'_, AppState>,
    scope: Option<String>,
    extra: Option<bool>,
) -> Result<LearnRound, String> {
    let settings = state.settings();
    let conn = lock(&state.db);
    let cards = if scope.as_deref() == Some("wrong") {
        rounds::wrong_cards(&conn, state.dict(), LEARN_BATCH)
    } else {
        // 每日新词目标：普通学习只发剩余额度，点「再学习」才额外加一批
        let batch = if extra.unwrap_or(false) {
            LEARN_BATCH
        } else {
            let learned = rounds::new_learned_today(&conn, settings.active_list_id);
            (settings.daily_new_words - learned).clamp(0, LEARN_BATCH)
        };
        if batch <= 0 {
            Vec::new()
        } else {
            rounds::learn_cards(&conn, state.dict(), batch, settings.active_list_id)
        }
    };
    Ok(LearnRound {
        cards,
        wrong_today: rounds::wrong_list(&conn),
    })
}

#[tauri::command]
pub fn learn_wrong_list(state: State<'_, AppState>) -> Result<Vec<WrongWord>, String> {
    let conn = lock(&state.db);
    Ok(rounds::wrong_list(&conn))
}

#[tauri::command(rename_all = "camelCase")]
pub fn learn_wrong_mark(
    app: AppHandle,
    state: State<'_, AppState>,
    word_id: i64,
) -> Result<i64, String> {
    let count = {
        let conn = lock(&state.db);
        rounds::wrong_add(&conn, word_id);
        rounds::wrong_list(&conn).len() as i64
    };
    flow::notify_data_changed(&app);
    Ok(count)
}

/// 错词本列表：scope = today | all
#[tauri::command]
pub fn wrongs_list(state: State<'_, AppState>, scope: String) -> Result<Vec<WrongBookEntry>, String> {
    let conn = lock(&state.db);
    Ok(rounds::wrong_book_list(&conn, scope == "today"))
}

#[tauri::command]
pub fn wrongs_counts(state: State<'_, AppState>) -> Result<WrongBookCounts, String> {
    let conn = lock(&state.db);
    Ok(rounds::wrong_book_counts(&conn))
}

/// 手动把词移出错词本；只有用户主动操作才会删除
#[tauri::command(rename_all = "camelCase")]
pub fn wrongs_remove(
    app: AppHandle,
    state: State<'_, AppState>,
    word_ids: Vec<i64>,
) -> Result<i64, String> {
    let removed = {
        let conn = lock(&state.db);
        rounds::wrong_forget(&conn, &word_ids)
    };
    flow::notify_data_changed(&app);
    Ok(removed)
}

#[tauri::command(rename_all = "camelCase")]
pub fn learn_finish(
    app: AppHandle,
    state: State<'_, AppState>,
    started_at: i64,
    entries: Vec<LearnEntry>,
    scope: Option<String>,
) -> Result<LearnFinish, String> {
    let entries: Vec<(i64, i64)> = entries
        .iter()
        .map(|e| (e.word_id, if e.rating == 1 { 1 } else { 0 }))
        .collect();
    let (rated, known) = {
        let conn = lock(&state.db);
        let result = rounds::record_learn(&conn, started_at, &entries)?;
        // 结算完成即作废该范围的中断快照，下次进入重新取词
        let _ = conn.execute(
            "delete from learn_progress where scope = ?1",
            [scope.as_deref().unwrap_or("new")],
        );
        result
    };
    scheduler::sync_word_availability(&state);
    flow::notify_data_changed(&app);
    let conn = lock(&state.db);
    Ok(LearnFinish {
        rated,
        known,
        wrong_today: rounds::wrong_list(&conn),
    })
}

/// 读取学习中断快照（scope = new | wrong），没有快照返回 null
#[tauri::command]
pub fn learn_progress_get(state: State<'_, AppState>, scope: String) -> Result<Option<String>, String> {
    let conn = lock(&state.db);
    conn.query_row(
        "select payload from learn_progress where scope = ?1",
        [scope],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn learn_progress_save(
    state: State<'_, AppState>,
    scope: String,
    payload: String,
) -> Result<bool, String> {
    let conn = lock(&state.db);
    conn.execute(
        "insert into learn_progress (scope, payload, updated_at) values (?1, ?2, ?3)
         on conflict(scope) do update set payload = excluded.payload, updated_at = excluded.updated_at",
        rusqlite::params![scope, payload, crate::util::now()],
    )
    .map_err(|e| format!("保存学习进度失败：{e}"))?;
    Ok(true)
}

#[tauri::command]
pub fn learn_progress_clear(state: State<'_, AppState>, scope: String) -> Result<bool, String> {
    let conn = lock(&state.db);
    conn.execute("delete from learn_progress where scope = ?1", [scope])
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn dashboard_state(app: AppHandle, state: State<'_, AppState>) -> Result<DashboardState, String> {    let status = flow::flow_status(&app);
    let settings = state.settings();
    let conn = lock(&state.db);
    Ok(rounds::build_dashboard(
        &conn,
        &settings,
        status.next_fire_at,
        status.schedule_set_at,
        &status.reason,
        status.scheduler_active,
    ))
}

#[tauri::command]
pub fn stats_overview(app: AppHandle, state: State<'_, AppState>) -> Result<StatsOverview, String> {
    let status = flow::flow_status(&app);
    let settings = state.settings();
    let conn = lock(&state.db);
    let rounds_done: i64 = conn
        .query_row(
            "select count(*) from rounds where status = 'done'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    Ok(StatsOverview {
        counts: words::word_counts(&conn, None),
        daily: rounds::daily_series(&conn, 14),
        top_lapses: rounds::top_lapses(&conn, 20),
        streak: rounds::streak_days(&conn),
        words_today: rounds::words_rated_today(&conn),
        know_rate_today: rounds::today_know_rate(&conn),
        delay: rounds::quota_state(&conn, &settings),
        rounds_done,
        next_fire_at: status.next_fire_at,
        settings: StatsSettings {
            mode: settings.mode,
            lock_level: settings.lock_level,
        },
    })
}

#[tauri::command]
pub fn flow_status(app: AppHandle) -> Result<FlowStatus, String> {
    Ok(flow::flow_status(&app))
}

#[tauri::command]
pub fn review_start_now(app: AppHandle, scope: Option<String>) -> Result<StartResult, String> {
    let pick = match scope.as_deref() {
        Some("new") => rounds::PickScope::New,
        Some("due") => rounds::PickScope::Due,
        _ => rounds::PickScope::Mixed,
    };
    Ok(flow::start_round(&app, true, pick))
}

#[tauri::command(rename_all = "camelCase")]
pub fn review_plan(state: State<'_, AppState>, round_id: i64) -> Result<Option<RoundPlan>, String> {
    let Some(round) = flow::active_round(&state, round_id) else {
        return Ok(None);
    };
    let settings = state.settings();
    let left = {
        let conn = lock(&state.db);
        rounds::quota_state(&conn, &settings).left
    };
    Ok(Some(RoundPlan {
        round_id: round.id,
        mode: round.mode,
        lock_level: round.lock_level,
        tts_enabled: round.tts_enabled,
        delay_quota_left: left,
        cards: round.cards,
    }))
}

#[tauri::command(rename_all = "camelCase")]
pub fn review_rate(
    app: AppHandle,
    round_id: i64,
    word_id: i64,
    rating: i64,
) -> Result<Option<RateResult>, String> {
    Ok(flow::rate_card(&app, round_id, word_id, rating))
}

#[tauri::command(rename_all = "camelCase")]
pub fn review_finish(app: AppHandle, round_id: i64) -> Result<bool, String> {
    flow::complete_round(&app, round_id);
    Ok(true)
}

#[tauri::command(rename_all = "camelCase")]
pub fn review_delay(app: AppHandle, round_id: i64, reason: String) -> Result<DelayResult, String> {
    Ok(flow::request_delay(&app, round_id, &reason))
}

#[tauri::command(rename_all = "camelCase")]
pub fn review_abort(app: AppHandle, round_id: i64) -> Result<bool, String> {
    flow::abort_from_renderer(&app, round_id);
    Ok(true)
}

#[tauri::command]
pub fn kiosk_status(app: AppHandle) -> Result<KioskStatus, String> {
    Ok(KioskStatus {
        engaged: crate::kiosk::is_engaged(&app),
        pid: crate::kiosk::pid(&app),
    })
}
