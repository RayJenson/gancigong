use crate::db::log_event;
use crate::dictionary::Dictionary;
use crate::models::*;
use crate::util::*;
use rand::seq::SliceRandom;
use rusqlite::{params, Connection};
use serde_json::json;

#[derive(Clone, Debug)]
pub struct ActiveRound {
    pub id: i64,
    pub mode: ReviewMode,
    pub lock_level: LockLevel,
    pub tts_enabled: bool,
    pub cards: Vec<CardData>,
}

struct CardRow {
    id: i64,
    term: String,
    phonetic: String,
    meaning: String,
    example: String,
    reps: i64,
}

fn to_card(dict: &Dictionary, r: &CardRow, practice: PracticeMode) -> CardData {
    let hit = dict.lookup(&r.term);
    let meaning = if r.meaning.is_empty() {
        hit.as_ref().map(|h| h.meaning.clone()).unwrap_or_default()
    } else {
        r.meaning.clone()
    };
    // 用户可指定题型；auto 时新词先默写、复习过的改选义。没有释义就没法出题，退回翻牌
    let wanted = match practice {
        PracticeMode::Auto => {
            if r.reps == 0 {
                CardMode::Spell
            } else {
                CardMode::Choice
            }
        }
        PracticeMode::Spell => CardMode::Spell,
        PracticeMode::Choice => CardMode::Choice,
    };
    CardData {
        word_id: r.id,
        term: r.term.clone(),
        phonetic: if r.phonetic.is_empty() {
            hit.as_ref().map(|h| h.phonetic.clone()).unwrap_or_default()
        } else {
            r.phonetic.clone()
        },
        meaning: meaning.clone(),
        example: r.example.clone(),
        forms: hit.map(|h| h.forms).unwrap_or_default(),
        mode: if meaning.trim().is_empty() {
            CardMode::Reveal
        } else {
            wanted
        },
        options: Vec::new(),
    }
}

/// 选择题的干扰项从全库释义里随机取
fn attach_options(conn: &Connection, cards: &mut [CardData]) {
    if !cards.iter().any(|c| c.mode == CardMode::Choice) {
        return;
    }
    let mut pool: Vec<String> = match conn
        .prepare("select distinct trim(meaning) meaning from words where trim(meaning) <> '' order by random() limit 120")
    {
        Ok(mut stmt) => stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let mut rng = rand::thread_rng();
    for card in cards.iter_mut() {
        if card.mode != CardMode::Choice {
            continue;
        }
        let answer = card.meaning.trim().to_string();
        pool.shuffle(&mut rng);
        let mut distractors: Vec<String> = Vec::new();
        for meaning in pool.iter() {
            if distractors.len() >= 3 {
                break;
            }
            if *meaning == answer || distractors.contains(meaning) {
                continue;
            }
            distractors.push(meaning.clone());
        }
        // 干扰项凑不够就不要硬凑俩选项，退回翻牌
        if distractors.len() < 2 {
            card.mode = CardMode::Reveal;
            continue;
        }
        let mut options = distractors;
        options.push(answer);
        options.shuffle(&mut rng);
        card.options = options;
    }
}

fn list_scope(list_id: Option<i64>) -> (&'static str, Vec<i64>) {
    match list_id {
        Some(id) => ("and w.list_id = ?", vec![id]),
        None => ("", Vec::new()),
    }
}

/// 取词范围：混排（调度器默认）、只背新词、只复习到期词
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PickScope {
    Mixed,
    New,
    Due,
}

/// 一轮取词：到期词 → 新词，去重后截断（未到期的词绝不混进来）
pub fn pick_words(
    conn: &Connection,
    dict: &Dictionary,
    count: i64,
    list_id: Option<i64>,
    practice: PracticeMode,
    pick: PickScope,
) -> Vec<CardData> {
    let now_ts = now();
    let (clause, scope) = list_scope(list_id);
    let mut picked: Vec<CardRow> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let push_rows = |rows: Vec<CardRow>, picked: &mut Vec<CardRow>, seen: &mut std::collections::HashSet<i64>| {
        for r in rows {
            if seen.insert(r.id) {
                picked.push(r);
            }
        }
    };

    if pick != PickScope::New {
        if let Ok(mut stmt) = conn.prepare(&format!(
            "select w.id, w.term, w.phonetic, w.meaning, w.example, s.reps as reps
             from words w join word_states s on s.word_id = w.id
             where s.due_at <= ? {clause}
             order by s.due_at asc, s.interval_minutes asc, w.id asc limit ?"
        )) {
            let args: Vec<rusqlite::types::Value> = std::iter::once(now_ts.into())
                .chain(scope.iter().map(|v| (*v).into()))
                .chain(std::iter::once(count.into()))
                .collect();
            if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(args.iter()), card_row) {
                push_rows(rows.filter_map(|r| r.ok()).collect(), &mut picked, &mut seen);
            }
        }
    }

    if pick != PickScope::Due && (picked.len() as i64) < count {
        let need = count - picked.len() as i64;
        if let Ok(mut stmt) = conn.prepare(&format!(
            "select w.id, w.term, w.phonetic, w.meaning, w.example, coalesce(s.reps, 0) as reps
             from words w left join word_states s on s.word_id = w.id
             where s.word_id is null {clause}
             order by w.id asc limit ?"
        )) {
            let args: Vec<rusqlite::types::Value> = scope
                .iter()
                .map(|v| (*v).into())
                .chain(std::iter::once(need.into()))
                .collect();
            if let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(args.iter()), card_row) {
                push_rows(rows.filter_map(|r| r.ok()).collect(), &mut picked, &mut seen);
            }
        }
    }

    let mut cards: Vec<CardData> = picked.iter().map(|r| to_card(dict, r, practice)).collect();
    attach_options(conn, &mut cards);
    cards
}

/// 背单词批次：只取完全没学过的新词，每题都配好 ABCD 选项
pub fn learn_cards(
    conn: &Connection,
    dict: &Dictionary,
    count: i64,
    list_id: Option<i64>,
) -> Vec<CardData> {
    let (clause, scope) = list_scope(list_id);
    let sql = format!(
        "select w.id, w.term, w.phonetic, w.meaning, w.example, 0 as reps
         from words w left join word_states s on s.word_id = w.id
         where s.word_id is null {clause}
         order by random() limit ?"
    );
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let args: Vec<rusqlite::types::Value> = scope
        .iter()
        .map(|v| (*v).into())
        .chain(std::iter::once(count.max(1).into()))
        .collect();
    let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(args.iter()), card_row) else {
        return Vec::new();
    };
    let picked: Vec<CardRow> = rows.filter_map(|r| r.ok()).collect();
    let mut cards: Vec<CardData> = picked
        .iter()
        .map(|r| to_card(dict, r, PracticeMode::Choice))
        .collect();
    attach_options(conn, &mut cards);
    cards
}

/// 记一次错：今日错词 + 永久错词本（错词本只增，需用户手动移出）
pub fn wrong_add(conn: &Connection, word_id: i64) {
    let ts = now();
    let _ = conn.execute(
        "insert or ignore into daily_wrongs (day, word_id, created_at) values (?1, ?2, ?3)",
        params![day_key(ts), word_id, ts],
    );
    let _ = conn.execute(
        "insert into wrong_book (word_id, first_wrong_at, last_wrong_at) values (?1, ?2, ?2)
         on conflict(word_id) do update set last_wrong_at = excluded.last_wrong_at",
        params![word_id, ts],
    );
}

/// 错词本里今天答错过的词数
pub fn wrong_count(conn: &Connection) -> i64 {
    conn.query_row(
        "select count(*) from wrong_book where last_wrong_at >= ?1",
        [start_of_day(now())],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// 用户手动把词移出错词本：同时清掉今日错词与永久记录
pub fn wrong_forget(conn: &Connection, word_ids: &[i64]) -> i64 {
    if word_ids.is_empty() {
        return 0;
    }
    let marks = std::iter::repeat("?")
        .take(word_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let ids: Vec<rusqlite::types::Value> = word_ids.iter().map(|v| (*v).into()).collect();
    let _ = conn.execute(
        &format!("delete from daily_wrongs where word_id in ({marks})"),
        rusqlite::params_from_iter(ids.iter()),
    );
    conn.execute(
        &format!("delete from wrong_book where word_id in ({marks})"),
        rusqlite::params_from_iter(ids.iter()),
    )
    .unwrap_or(0) as i64
}

/// 错词复习批次：按最近答错时间从早到晚轮，最多一批 10 个
pub fn wrong_cards(conn: &Connection, dict: &Dictionary, count: i64) -> Vec<CardData> {
    let Ok(mut stmt) = conn.prepare(
        "select w.id, w.term, w.phonetic, w.meaning, w.example, coalesce(s.reps, 0) as reps
         from wrong_book b
         join words w on w.id = b.word_id
         left join word_states s on s.word_id = w.id
         order by b.last_wrong_at asc limit ?1",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map(params![count.max(1)], card_row) else {
        return Vec::new();
    };
    let picked: Vec<CardRow> = rows.filter_map(|r| r.ok()).collect();
    let mut cards: Vec<CardData> = picked
        .iter()
        .map(|r| to_card(dict, r, PracticeMode::Choice))
        .collect();
    attach_options(conn, &mut cards);
    cards
}

/// 今天答错过的词（错词本里 today 页签）
pub fn wrong_list(conn: &Connection) -> Vec<WrongWord> {
    let Ok(mut stmt) = conn.prepare(
        "select w.id, w.term, w.phonetic, w.meaning
         from wrong_book b join words w on w.id = b.word_id
         where b.last_wrong_at >= ?1 order by b.last_wrong_at desc",
    ) else {
        return Vec::new();
    };
    stmt.query_map([start_of_day(now())], |r| {
        Ok(WrongWord {
            word_id: r.get(0)?,
            term: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            phonetic: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            meaning: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        })
    })
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

pub fn wrong_book_counts(conn: &Connection) -> WrongBookCounts {
    let today = wrong_count(conn);
    let total = conn
        .query_row("select count(*) from wrong_book", [], |r| r.get(0))
        .unwrap_or(0);
    WrongBookCounts { today, total }
}

/// only_today 为真是「今日答错」，否则是全部错词；最近答错的排在前面
pub fn wrong_book_list(conn: &Connection, only_today: bool) -> Vec<WrongBookEntry> {
    let Ok(mut stmt) = conn.prepare(
        "select w.id, w.term, w.phonetic, w.meaning, b.last_wrong_at
         from wrong_book b join words w on w.id = b.word_id
         where (?1 = 0 or b.last_wrong_at >= ?2)
         order by b.last_wrong_at desc",
    ) else {
        return Vec::new();
    };
    let day_start = start_of_day(now());
    let only = if only_today { 1 } else { 0 };
    let Ok(rows) = stmt.query_map(params![only, day_start], |r| {
        Ok(WrongBookEntry {
            word_id: r.get(0)?,
            term: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            phonetic: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            meaning: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            last_wrong_at: r.get(4)?,
        })
    }) else {
        return Vec::new();
    };
    rows.flatten().collect()
}

/// 一大轮学完后一次性记账：补一条已完成轮次 + 逐个套用 SRS
pub fn record_learn(
    conn: &Connection,
    started_at: i64,
    entries: &[(i64, i64)],
) -> Result<(i64, i64), String> {
    // 断点续学快照可能保留了已被删除的词，先剔掉再记账，避免外键失败
    let entries: Vec<(i64, i64)> = entries
        .iter()
        .copied()
        .filter(|(word_id, _)| {
            conn.query_row(
                "select exists(select 1 from words where id = ?1)",
                [*word_id],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
                == 1
        })
        .collect();
    if entries.is_empty() {
        return Ok((0, 0));
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "insert into rounds (planned_at, started_at, mode, lock_level, planned_count, status)
         values (?1, ?1, 'gentle', 'app', ?2, 'open')",
        params![started_at, entries.len() as i64],
    )
    .map_err(|e| e.to_string())?;
    let round_id = tx.last_insert_rowid();
    for (i, (word_id, _)) in entries.iter().enumerate() {
        tx.execute(
            "insert into round_items (round_id, word_id, position, shown_at) values (?1, ?2, ?3, ?4)",
            params![round_id, word_id, i as i64, started_at],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    let mut known = 0;
    for &(word_id, rating) in &entries {
        rate(conn, round_id, word_id, rating)?;
        if rating == 1 {
            known += 1;
        }
    }
    finish_round(conn, round_id);
    Ok((entries.len() as i64, known))
}

fn card_row(r: &rusqlite::Row) -> rusqlite::Result<CardRow> {
    Ok(CardRow {
        id: r.get(0)?,
        term: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
        phonetic: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
        meaning: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        example: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
        reps: r.get::<_, Option<i64>>(5)?.unwrap_or_default(),
    })
}

pub fn open_round(
    conn: &Connection,
    dict: &Dictionary,
    s: &Settings,
    mode: ReviewMode,
    planned_at: i64,
    record_empty: bool,
    pick: PickScope,
) -> Result<Option<ActiveRound>, String> {
    let cards = pick_words(conn, dict, s.words_per_round, s.active_list_id, s.practice_mode, pick);
    if cards.is_empty() {
        // 到点却没词可复习要留审计记录；手点失败的轮次不塞空历史
        if record_empty {
            let ts = now();
            conn.execute(
                "insert into rounds (planned_at, mode, lock_level, planned_count, status, started_at)
                 values (?1, ?2, ?3, 0, 'empty', ?4)",
                params![planned_at, mode_str(mode), lock_str(s.lock_level), ts],
            )
            .map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();
            let _ = conn.execute("update rounds set finished_at = ?1 where id = ?2", params![ts, id]);
        }
        return Ok(None);
    }

    let started_at = now();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "insert into rounds (planned_at, started_at, mode, lock_level, planned_count, status)
         values (?1, ?2, ?3, ?4, ?5, 'open')",
        params![
            planned_at,
            started_at,
            mode_str(mode),
            lock_str(s.lock_level),
            cards.len() as i64
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = tx.last_insert_rowid();
    for (i, c) in cards.iter().enumerate() {
        tx.execute(
            "insert into round_items (round_id, word_id, position, shown_at) values (?1, ?2, ?3, ?4)",
            params![id, c.word_id, i as i64, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Some(ActiveRound {
        id,
        mode,
        lock_level: s.lock_level,
        tts_enabled: s.tts_enabled,
        cards,
    }))
}

pub fn rate(conn: &Connection, round_id: i64, word_id: i64, rating: i64) -> Result<RateResult, String> {
    let now_ts = now();
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "update round_items set rating = ?1, rated_at = ?2 where round_id = ?3 and word_id = ?4",
        params![if rating == 1 { 1 } else { 0 }, now_ts, round_id, word_id],
    )
    .map_err(|e| e.to_string())?;
    let current: i64 = tx
        .query_row(
            "select interval_minutes from word_states where word_id = ?1",
            [word_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let interval_minutes = apply_rating_minutes(current, rating);
    let interval_days = interval_minutes / 1_440;
    let due_at = now_ts + interval_minutes * 60_000;
    tx.execute(
        "insert into word_states (word_id, interval_days, interval_minutes, due_at, reps, lapses, last_rating, last_reviewed_at, learned_at)
         values (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?7)
         on conflict(word_id) do update set
           interval_days = excluded.interval_days,
           interval_minutes = excluded.interval_minutes,
           due_at = excluded.due_at,
           reps = word_states.reps + 1,
           lapses = word_states.lapses + excluded.lapses,
           last_rating = excluded.last_rating,
           last_reviewed_at = excluded.last_reviewed_at",
        params![
            word_id,
            interval_days,
            interval_minutes,
            due_at,
            if rating == 0 { 1 } else { 0 },
            if rating == 1 { 1 } else { 0 },
            now_ts
        ],
    )
    .map_err(|e| e.to_string())?;
    if rating == 0 {
        wrong_add(&tx, word_id);
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(RateResult {
        next_due_at: due_at,
        interval_days,
        interval_minutes,
    })
}

fn close_round(conn: &Connection, round_id: i64, status: &str) {
    let rated: i64 = conn
        .query_row(
            "select count(*) from round_items where round_id = ?1 and rating is not null",
            [round_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let _ = conn.execute(
        "update rounds set status = ?1, rated_count = ?2, finished_at = ?3 where id = ?4",
        params![status, rated, now(), round_id],
    );
}

pub fn finish_round(conn: &Connection, round_id: i64) -> (i64, i64) {
    let rated: i64 = conn
        .query_row(
            "select count(*) from round_items where round_id = ?1 and rating is not null",
            [round_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let known: i64 = conn
        .query_row(
            "select count(*) from round_items where round_id = ?1 and rating = 1",
            [round_id],
            |r| r.get(0),
        )
        .unwrap_or(0);
    close_round(conn, round_id, if rated > 0 { "done" } else { "skipped" });
    log_event(
        conn,
        "round_done",
        Some(json!({ "roundId": round_id, "rated": rated, "known": known })),
    );
    (rated, known)
}

pub fn abort_round(conn: &Connection, round_id: i64, reason: &str) {
    close_round(conn, round_id, "aborted");
    log_event(
        conn,
        "round_aborted",
        Some(json!({ "roundId": round_id, "reason": reason })),
    );
}

pub fn quota_state(conn: &Connection, s: &Settings) -> QuotaState {
    let used: i64 = conn
        .query_row(
            "select used from delay_slots where day = ?1",
            [day_key(now())],
            |r| r.get(0),
        )
        .unwrap_or(0);
    QuotaState {
        used,
        quota: s.delay_quota_per_day,
        left: (s.delay_quota_per_day - used).max(0),
    }
}

/// 消耗一次今日延后额度；额度用尽返回 None
pub fn consume_delay(conn: &Connection, s: &Settings, round_id: i64, reason: &str) -> Option<QuotaState> {
    let state = quota_state(conn, s);
    if state.left <= 0 {
        log_event(
            conn,
            "quota_exhausted",
            Some(json!({ "roundId": round_id, "reason": reason, "used": state.used, "quota": s.delay_quota_per_day })),
        );
        return None;
    }
    let day = day_key(now());
    let _ = conn.execute(
        "insert into delay_slots (day, used, quota) values (?1, 1, ?2)
         on conflict(day) do update set used = delay_slots.used + 1, quota = excluded.quota",
        params![day, s.delay_quota_per_day],
    );
    log_event(
        conn,
        "delay",
        Some(json!({
            "roundId": round_id,
            "reason": reason,
            "used": state.used + 1,
            "quota": s.delay_quota_per_day,
            "minutes": s.delay_minutes,
        })),
    );
    Some(quota_state(conn, s))
}

pub fn words_rated_today(conn: &Connection) -> i64 {
    conn.query_row(
        "select count(*) from round_items where rating is not null and shown_at >= ?1",
        [start_of_day(now())],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// 今天首次学会的新词数（只看首次学习时间，复习旧词不算）
pub fn new_learned_today(conn: &Connection, list_id: Option<i64>) -> i64 {
    let sql = match list_id {
        Some(_) => "select count(*) from word_states s join words w on w.id = s.word_id where s.learned_at >= ?1 and w.list_id = ?2",
        None => "select count(*) from word_states s where s.learned_at >= ?1",
    };
    match list_id {
        Some(id) => conn
            .query_row(sql, params![start_of_day(now()), id], |r| r.get(0))
            .unwrap_or(0),
        None => conn
            .query_row(sql, [start_of_day(now())], |r| r.get(0))
            .unwrap_or(0),
    }
}

pub fn today_know_rate(conn: &Connection) -> Option<i64> {
    let (total, known): (i64, i64) = conn
        .query_row(
            "select count(*), coalesce(sum(case when rating = 1 then 1 else 0 end), 0)
             from round_items where rating is not null and shown_at >= ?1",
            [start_of_day(now())],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    if total == 0 {
        None
    } else {
        Some(((known as f64 / total as f64) * 100.0).round() as i64)
    }
}

pub fn streak_days(conn: &Connection) -> i64 {
    let mut days: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Ok(mut stmt) = conn.prepare(
        "select distinct date(shown_at / 1000, 'unixepoch', 'localtime') d
         from round_items where rating is not null",
    ) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            days.extend(rows.filter_map(|r| r.ok()));
        }
    }
    if days.is_empty() {
        return 0;
    }
    let mut streak = 0;
    let mut cursor = start_of_day(now());
    if !days.contains(&day_key(cursor)) {
        cursor -= DAY_MS;
    }
    while days.contains(&day_key(cursor)) {
        streak += 1;
        cursor -= DAY_MS;
    }
    streak
}

pub fn daily_series(conn: &Connection, days: i64) -> Vec<DayStat> {
    let from = start_of_day(now()) - (days - 1) * DAY_MS;
    let mut by_day: std::collections::HashMap<String, (i64, i64)> = std::collections::HashMap::new();
    if let Ok(mut stmt) = conn.prepare(
        "select date(shown_at / 1000, 'unixepoch', 'localtime') d, count(*),
                coalesce(sum(case when rating = 1 then 1 else 0 end), 0)
         from round_items where rating is not null and shown_at >= ?1
         group by d",
    ) {
        if let Ok(rows) = stmt.query_map([from], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        }) {
            for row in rows.flatten() {
                by_day.insert(row.0, (row.1, row.2));
            }
        }
    }
    (0..days)
        .map(|i| {
            let key = day_key(from + i * DAY_MS);
            let (words, known) = by_day.get(&key).copied().unwrap_or((0, 0));
            DayStat {
                day: key,
                words,
                known,
                rate: if words > 0 {
                    Some(((known as f64 / words as f64) * 100.0).round() as i64)
                } else {
                    None
                },
            }
        })
        .collect()
}

pub fn top_lapses(conn: &Connection, limit: i64) -> Vec<TopLapse> {
    let Ok(mut stmt) = conn.prepare(
        "select w.term, w.meaning, s.lapses, s.reps, s.interval_days, s.interval_minutes
         from word_states s join words w on w.id = s.word_id
         where s.lapses > 0 order by s.lapses desc, s.reps asc limit ?1",
    ) else {
        return Vec::new();
    };
    stmt.query_map([limit], |r| {
        Ok(TopLapse {
            term: r.get(0)?,
            meaning: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            lapses: r.get::<_, Option<i64>>(2)?.unwrap_or_default(),
            reps: r.get::<_, Option<i64>>(3)?.unwrap_or_default(),
            interval_days: r.get::<_, Option<i64>>(4)?.unwrap_or_default(),
            interval_minutes: r.get::<_, Option<i64>>(5)?.unwrap_or_default(),
        })
    })
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

pub fn recent_rounds(conn: &Connection, limit: i64) -> Vec<RoundSummary> {
    let Ok(mut stmt) = conn.prepare(
        "select r.id, r.planned_at, r.mode, r.planned_count, r.rated_count, r.status,
                (select count(*) from round_items i where i.round_id = r.id and i.rating = 1) as known
         from rounds r
         where r.status <> 'empty'
         order by r.planned_at desc limit ?1",
    ) else {
        return Vec::new();
    };
    stmt.query_map([limit], |r| {
        let rated: i64 = r.get::<_, Option<i64>>(4)?.unwrap_or_default();
        let known: i64 = r.get::<_, Option<i64>>(6)?.unwrap_or_default();
        Ok(RoundSummary {
            id: r.get(0)?,
            planned_at: r.get(1)?,
            mode: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            planned: r.get::<_, Option<i64>>(3)?.unwrap_or_default(),
            rated,
            status: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            know_rate: if rated > 0 {
                Some(((known as f64 / rated as f64) * 100.0).round() as i64)
            } else {
                None
            },
        })
    })
    .map(|rows| rows.flatten().collect())
    .unwrap_or_default()
}

/// 当前已经到期、可以立刻复习的词
pub fn review_due_count(conn: &Connection, list_id: Option<i64>) -> i64 {
    let sql = match list_id {
        Some(_) => "select count(*) from word_states s join words w on w.id = s.word_id where s.due_at <= ?1 and w.list_id = ?2",
        None => "select count(*) from word_states s where s.due_at <= ?1",
    };
    match list_id {
        Some(id) => conn.query_row(sql, params![now(), id], |r| r.get(0)).unwrap_or(0),
        None => conn.query_row(sql, params![now()], |r| r.get(0)).unwrap_or(0),
    }
}

/// 今日待复习 = 今天结束前会到期的复习词（含已经到期的），不含新词
pub fn due_today_count(conn: &Connection, list_id: Option<i64>) -> i64 {
    let end_of_today = start_of_day(now()) + DAY_MS - 1;
    let sql = match list_id {
        Some(_) => "select count(*) from word_states s join words w on w.id = s.word_id where s.due_at <= ?1 and w.list_id = ?2",
        None => "select count(*) from word_states s where s.due_at <= ?1",
    };
    match list_id {
        Some(id) => conn
            .query_row(sql, params![end_of_today, id], |r| r.get(0))
            .unwrap_or(0),
        None => conn
            .query_row(sql, params![end_of_today], |r| r.get(0))
            .unwrap_or(0),
    }
}

/// 未来第 N 天（0=今天）到期的复习词数，用来展示跨天复习计划
pub fn due_on_offset_count(conn: &Connection, list_id: Option<i64>, day_offset: i64) -> i64 {
    let start = start_of_day(now()) + day_offset * DAY_MS;
    let end = start + DAY_MS;
    let sql = match list_id {
        Some(_) => "select count(*) from word_states s join words w on w.id = s.word_id where s.due_at >= ?1 and s.due_at < ?2 and w.list_id = ?3",
        None => "select count(*) from word_states s where s.due_at >= ?1 and s.due_at < ?2",
    };
    match list_id {
        Some(id) => conn
            .query_row(sql, params![start, end, id], |r| r.get(0))
            .unwrap_or(0),
        None => conn
            .query_row(sql, params![start, end], |r| r.get(0))
            .unwrap_or(0),
    }
}

/// 最近一次复习到期时间：调度器据此决定什么时候再叫醒用户
pub fn earliest_due_at(conn: &Connection, list_id: Option<i64>) -> Option<i64> {
    let sql = match list_id {
        Some(_) => "select min(s.due_at) from word_states s join words w on w.id = s.word_id where w.list_id = ?1",
        None => "select min(s.due_at) from word_states s",
    };
    match list_id {
        Some(id) => conn
            .query_row(sql, [id], |r| r.get::<_, Option<i64>>(0))
            .unwrap_or(None),
        None => conn
            .query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .unwrap_or(None),
    }
}

pub fn build_dashboard(
    conn: &Connection,
    s: &Settings,
    next_fire_at: Option<i64>,
    schedule_set_at: Option<i64>,
    next_fire_reason: &str,
    scheduler_active: bool,
) -> DashboardState {
    let active_list = s.active_list_id.filter(|id| *id != 0);
    let counts = crate::words::word_counts(conn, active_list);
    let active_list_name: String = match active_list {
        Some(id) => conn
            .query_row("select name from lists where id = ?1", [id], |r| r.get(0))
            .unwrap_or_default(),
        None => String::new(),
    };
    let q = quota_state(conn, s);
    let rounds_today: i64 = conn
        .query_row(
            "select count(*) from rounds where status in ('done', 'aborted') and planned_at >= ?1",
            [start_of_day(now())],
            |r| r.get(0),
        )
        .unwrap_or(0);
    DashboardState {
        next_fire_at,
        schedule_set_at,
        next_fire_reason: next_fire_reason.to_string(),
        active_list_id: active_list,
        active_list_name,
        due_today: due_today_count(conn, active_list),
        due_tomorrow: due_on_offset_count(conn, active_list, 1),
        due_after_tomorrow: due_on_offset_count(conn, active_list, 2),
        review_due: review_due_count(conn, active_list),
        mastered: counts.mastered,
        fresh: counts.fresh,
        daily_new_words: s.daily_new_words,
        new_today: new_learned_today(conn, active_list),
        need_meaning: counts.need_meaning,
        total_words: counts.total,
        delay_used: q.used,
        delay_quota: q.quota,
        delay_minutes: s.delay_minutes,
        mode: s.mode,
        lock_level: s.lock_level,
        rounds_today,
        words_today: words_rated_today(conn),
        recent_rounds: recent_rounds(conn, 5),
        windows: s.windows.clone(),
        interval_minutes: s.interval_minutes,
        scheduler_active,
        wrong_today: wrong_count(conn),
        wrong_total: wrong_book_counts(conn).total,
    }
}

fn mode_str(mode: ReviewMode) -> &'static str {
    match mode {
        ReviewMode::Gentle => "gentle",
        ReviewMode::Fullscreen => "fullscreen",
    }
}

fn lock_str(level: LockLevel) -> &'static str {
    match level {
        LockLevel::App => "app",
        LockLevel::Kiosk => "kiosk",
    }
}
