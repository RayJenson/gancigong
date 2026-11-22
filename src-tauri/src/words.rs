use crate::dictionary::Dictionary;
use crate::models::{ListInfo, UnitInfo, UpsertResult, WordCounts, WordInput, WordQuery, WordRow};
use crate::util::{now, start_of_day, DAY_MS, MASTERED_FROM_MINUTES};
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};

const SELECT: &str = "
select w.id, w.list_id, w.unit_id, coalesce(u.name, '') as unit_name,
       w.term, w.phonetic, w.meaning, w.example, w.tags, w.need_meaning, w.created_at,
       s.interval_days, s.interval_minutes, s.due_at, s.reps, s.lapses, s.last_rating
from words w left join word_states s on s.word_id = w.id
left join units u on u.id = w.unit_id
";

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<WordRow> {
    Ok(WordRow {
        id: r.get(0)?,
        list_id: r.get(1)?,
        unit_id: r.get(2)?,
        unit_name: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
        term: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
        phonetic: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
        meaning: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
        example: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
        tags: r.get::<_, Option<String>>(8)?.unwrap_or_default(),
        need_meaning: r.get::<_, Option<i64>>(9)?.unwrap_or_default(),
        created_at: r.get::<_, Option<i64>>(10)?.unwrap_or_default(),
        interval_days: r.get::<_, Option<i64>>(11)?.unwrap_or_default(),
        interval_minutes: r.get::<_, Option<i64>>(12)?.unwrap_or_default(),
        due_at: r.get(13)?,
        reps: r.get::<_, Option<i64>>(14)?.unwrap_or_default(),
        lapses: r.get::<_, Option<i64>>(15)?.unwrap_or_default(),
        last_rating: r.get(16)?,
    })
}

pub fn ensure_default_list(conn: &Connection) -> Result<i64, String> {
    let existing: Option<i64> = conn
        .query_row("select id from lists order by id limit 1", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        return Ok(id);
    }
    conn.execute(
        "insert into lists (name, remark, created_at) values ('我的词库', '', ?1)",
        [now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn list_lists(conn: &Connection) -> Result<Vec<ListInfo>, String> {
    let mut stmt = conn
        .prepare(
            "select l.id, l.name, l.remark,
                    count(w.id) as word_count,
                    sum(case when w.id is null then 0 when s.due_at is null then 1 when s.due_at <= ?1 then 1 else 0 end) as due_count,
                    (select count(*) from units u where u.list_id = l.id) as unit_count
             from lists l left join words w on w.list_id = l.id
             left join word_states s on s.word_id = w.id
             group by l.id order by l.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([now()], |r| {
            Ok(ListInfo {
                id: r.get(0)?,
                name: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                remark: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                word_count: r.get::<_, Option<i64>>(3)?.unwrap_or_default(),
                due_count: r.get::<_, Option<i64>>(4)?.unwrap_or_default(),
                unit_count: r.get::<_, Option<i64>>(5)?.unwrap_or_default(),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn create_list(conn: &Connection, name: &str, remark: &str) -> Result<i64, String> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err("词表名称不能为空".into());
    }
    let clash: Option<i64> = conn
        .query_row("select id from lists where name = ?1", [clean], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = clash {
        return Ok(id);
    }
    conn.execute(
        "insert into lists (name, remark, created_at) values (?1, ?2, ?3)",
        params![clean, remark.trim(), now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_list(conn: &Connection, id: i64, name: &str, remark: Option<&str>) -> Result<(), String> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err("词表名称不能为空".into());
    }
    match remark {
        None => conn.execute("update lists set name = ?1 where id = ?2", params![clean, id]),
        Some(r) => conn.execute(
            "update lists set name = ?1, remark = ?2 where id = ?3",
            params![clean, r.trim(), id],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_list(conn: &Connection, id: i64) -> Result<i64, String> {
    let count: i64 = conn
        .query_row("select count(*) from words where list_id = ?1", [id], |r| r.get(0))
        .unwrap_or(0);
    let _ = conn.execute(
        "delete from word_states where word_id in (select id from words where list_id = ?1)",
        [id],
    );
    let _ = conn.execute(
        "delete from round_items where word_id in (select id from words where list_id = ?1)",
        [id],
    );
    conn.execute("delete from words where list_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("delete from lists where id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(count)
}

pub fn list_units(conn: &Connection, list_id: Option<i64>) -> Result<Vec<UnitInfo>, String> {
    let (clause, now_param) = match list_id {
        Some(_) => ("where u.list_id = ?1", "?2"),
        None => ("", "?1"),
    };
    let sql = format!(
        "select u.id, u.list_id, u.name, u.position,
                count(w.id) as word_count,
                sum(case when w.id is null then 0 when s.due_at is null then 1 when s.due_at <= {now_param} then 1 else 0 end) as due_count
         from units u left join words w on w.unit_id = u.id
         left join word_states s on s.word_id = w.id
         {clause}
         group by u.id order by u.list_id, u.position, u.id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let map = |r: &rusqlite::Row| {
        Ok(UnitInfo {
            id: r.get(0)?,
            list_id: r.get(1)?,
            name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            position: r.get::<_, Option<i64>>(3)?.unwrap_or_default(),
            word_count: r.get::<_, Option<i64>>(4)?.unwrap_or_default(),
            due_count: r.get::<_, Option<i64>>(5)?.unwrap_or_default(),
        })
    };
    let rows = match list_id {
        Some(id) => stmt
            .query_map(params![id, now()], map)
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map(params![now()], map)
            .map_err(|e| e.to_string())?,
    };
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

pub fn create_unit(conn: &Connection, list_id: i64, name: &str) -> Result<i64, String> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err("单元名称不能为空".into());
    }
    let exists: Option<i64> = conn
        .query_row(
            "select id from units where list_id = ?1 and name = ?2",
            params![list_id, clean],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = exists {
        return Ok(id);
    }
    let next: i64 = conn
        .query_row(
            "select coalesce(max(position), 0) + 1 from units where list_id = ?1",
            [list_id],
            |r| r.get(0),
        )
        .unwrap_or(1);
    conn.execute(
        "insert into units (list_id, name, position, created_at) values (?1, ?2, ?3, ?4)",
        params![list_id, clean, next, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_unit(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let clean = name.trim();
    if clean.is_empty() {
        return Err("单元名称不能为空".into());
    }
    let list_id: i64 = conn
        .query_row("select list_id from units where id = ?1", [id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("单元不存在")?;
    let clash: Option<i64> = conn
        .query_row(
            "select id from units where list_id = ?1 and name = ?2 and id <> ?3",
            params![list_id, clean, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if clash.is_some() {
        return Err("同一词表下已有同名单元".into());
    }
    conn.execute("update units set name = ?1 where id = ?2", params![clean, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除单元但保留单词，只把单词移回“未分单元”
pub fn delete_unit(conn: &Connection, id: i64) -> Result<i64, String> {
    let affected = conn
        .execute("update words set unit_id = null where unit_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("delete from units where id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(affected as i64)
}

pub(crate) fn normalize_unit(conn: &Connection, list_id: i64, unit_id: Option<i64>) -> Result<Option<i64>, String> {
    match unit_id {
        None => Ok(None),
        Some(v) if v <= 0 => Ok(None),
        Some(id) => {
            let owner: Option<i64> = conn
                .query_row("select list_id from units where id = ?1", [id], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            match owner {
                Some(owner) if owner == list_id => Ok(Some(id)),
                Some(_) => Err("这个单元不属于当前词表".into()),
                None => Err("单元不存在".into()),
            }
        }
    }
}

pub fn move_words(conn: &Connection, ids: &[i64], unit_id: Option<i64>) -> Result<i64, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let marks = vec!["?"; ids.len()].join(",");
    let changes = match unit_id {
        None | Some(0) => {
            let args: Vec<rusqlite::types::Value> = ids.iter().map(|v| (*v).into()).collect();
            conn.execute(
                &format!("update words set unit_id = null where id in ({marks})"),
                params_from_iter(args.iter()),
            )
            .map_err(|e| e.to_string())?
        }
        Some(unit) => {
            let list_id: i64 = conn
                .query_row("select list_id from units where id = ?1", [unit], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?
                .ok_or("单元不存在")?;
            let mut args: Vec<rusqlite::types::Value> = vec![unit.into()];
            args.extend(ids.iter().map(|v| (*v).into()));
            args.push(list_id.into());
            conn.execute(
                &format!("update words set unit_id = ?1 where id in ({marks}) and list_id = ?{}", ids.len() + 2),
                params_from_iter(args.iter()),
            )
            .map_err(|e| e.to_string())?
        }
    };
    Ok(changes as i64)
}

pub fn list_words(conn: &Connection, q: &WordQuery) -> Result<(Vec<WordRow>, i64), String> {
    let mut where_parts: Vec<String> = Vec::new();
    let mut args: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(list_id) = q.list_id {
        if list_id != 0 {
            where_parts.push("w.list_id = ?".into());
            args.push(list_id.into());
        }
    }
    match q.unit_id {
        Some(0) => where_parts.push("w.unit_id is null".into()),
        Some(unit_id) if unit_id > 0 => {
            where_parts.push("w.unit_id = ?".into());
            args.push(unit_id.into());
        }
        _ => {}
    }
    if let Some(query) = q.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        where_parts.push("(w.term like ? or w.meaning like ?)".into());
        args.push(format!("%{query}%").into());
        args.push(format!("%{query}%").into());
    }
    if q.need_meaning_only.unwrap_or(false) {
        where_parts.push("w.need_meaning = 1".into());
    }
    let start_today = start_of_day(now());
    match q.scope.as_deref() {
        Some("wrong") => where_parts.push("coalesce(s.lapses, 0) > 0".into()),
        Some("learnedToday") => {
            // 只看首次学习时间：复习旧词不算「今日新学」
            where_parts.push("coalesce(s.learned_at, 0) >= ?".into());
            args.push(start_today.into());
        }
        Some("learned") => where_parts.push("coalesce(s.reps, 0) > 0".into()),
        Some("dueToday") => {
            where_parts.push("s.due_at is not null and s.due_at <= ?".into());
            args.push((start_today + DAY_MS - 1).into());
        }
        Some("studiedToday") => {
            // 今天学过或复习过的词：两个动作都会刷新 last_reviewed_at
            where_parts.push("coalesce(s.last_reviewed_at, 0) >= ?".into());
            args.push(start_today.into());
        }
        Some("wrongReview") => {
            where_parts.push(
                "exists(select 1 from wrong_book b where b.word_id = w.id)".into(),
            );
        }
        Some("reviewing") => {
            where_parts.push(
                "coalesce(s.reps, 0) > 0 and coalesce(s.interval_minutes, 0) < ?".into(),
            );
            args.push(MASTERED_FROM_MINUTES.into());
        }
        _ => {}
    }
    let clause = if where_parts.is_empty() {
        String::new()
    } else {
        format!("where {}", where_parts.join(" and "))
    };
    let order = match q.sort.as_deref() {
        Some("term") => "w.term asc".to_string(),
        Some("lapses") => "coalesce(s.lapses, 0) desc, coalesce(s.due_at, 0) asc".to_string(),
        Some("created") => "w.id desc".to_string(),
        _ => match q.scope.as_deref() {
            Some("wrong") => {
                "coalesce(s.lapses, 0) desc, coalesce(s.last_reviewed_at, 0) desc, w.id asc".to_string()
            }
            Some("learnedToday") => "coalesce(s.learned_at, 0) desc, w.id asc".to_string(),
            Some("learned") => {
                "coalesce(s.last_reviewed_at, 0) desc, w.id asc".to_string()
            }
            Some("dueToday") | Some("reviewing") => {
                "coalesce(s.due_at, 0) asc, w.id asc".to_string()
            }
            Some("studiedToday") => "coalesce(s.last_reviewed_at, 0) desc, w.id asc".to_string(),
            Some("wrongReview") => {
                "(select b.last_wrong_at from wrong_book b where b.word_id = w.id) desc, w.id asc"
                    .to_string()
            }
            _ => "case when s.due_at is null then 0 else 1 end, coalesce(s.due_at, 0) asc, w.id asc"
                .to_string(),
        },
    };

    let total: i64 = conn
        .query_row(
            &format!(
                "select count(*) from words w left join word_states s on s.word_id = w.id {clause}"
            ),
            params_from_iter(args.iter()),
            |r| r.get(0),
        )
        .unwrap_or(0);

    let limit = q.limit.unwrap_or(200);
    let offset = q.offset.unwrap_or(0);
    let sql = format!("{SELECT} {clause} order by {order} limit ? offset ?");
    let mut all_args = args.clone();
    all_args.push(limit.into());
    all_args.push(offset.into());
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(all_args.iter()), map_row)
        .map_err(|e| e.to_string())?;
    let rows = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok((rows, total))
}

pub fn get_word(conn: &Connection, id: i64) -> Result<Option<WordRow>, String> {
    let sql = format!("{SELECT} where w.id = ?1");
    conn.query_row(&sql, [id], map_row)
        .optional()
        .map_err(|e| e.to_string())
}

struct Enriched {
    phonetic: String,
    meaning: String,
    tags: String,
    need_meaning: i64,
    from_dictionary: bool,
}

/// 缺失的音标/释义用离线词典补，补不到就标记待补充
fn enrich(dict: &Dictionary, input: &WordInput) -> Enriched {
    let term = input.term.as_deref().unwrap_or("").trim().to_lowercase();
    let hit = dict.lookup(&term);
    let phonetic = non_empty(input.phonetic.as_deref())
        .or_else(|| hit.as_ref().map(|h| h.phonetic.clone()))
        .unwrap_or_default();
    let given_meaning = non_empty(input.meaning.as_deref());
    let meaning = given_meaning
        .clone()
        .or_else(|| hit.as_ref().map(|h| h.meaning.clone()))
        .unwrap_or_default();
    let tags = non_empty(input.tags.as_deref())
        .or_else(|| hit.as_ref().map(|h| h.tags.join(" ")))
        .unwrap_or_default();
    Enriched {
        phonetic,
        meaning: meaning.clone(),
        tags,
        need_meaning: if meaning.is_empty() { 1 } else { 0 },
        from_dictionary: hit.is_some() && given_meaning.is_none(),
    }
}

fn non_empty(v: Option<&str>) -> Option<String> {
    v.map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

pub fn create_word(conn: &Connection, dict: &Dictionary, list_id: i64, input: &WordInput) -> Result<UpsertResult, String> {
    let term = input.term.as_deref().unwrap_or("").trim().to_lowercase();
    if term.is_empty() {
        return Err("单词不能为空".into());
    }
    let extra = enrich(dict, input);
    let unit_id = normalize_unit(conn, list_id, input.unit_id)?;
    let existing: Option<i64> = conn
        .query_row(
            "select id from words where list_id = ?1 and term = ?2",
            params![list_id, term],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if let Some(id) = existing {
        let row = update_word(conn, id, input)?;
        return Ok(UpsertResult {
            row,
            from_dictionary: extra.from_dictionary,
        });
    }
    conn.execute(
        "insert into words (list_id, unit_id, term, phonetic, meaning, example, tags, need_meaning, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            list_id,
            unit_id,
            term,
            extra.phonetic,
            extra.meaning,
            input.example.as_deref().unwrap_or("").trim(),
            extra.tags,
            extra.need_meaning,
            now()
        ],
    )
    .map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(UpsertResult {
        row: get_word(conn, id)?.ok_or("写入后读不到单词")?,
        from_dictionary: extra.from_dictionary,
    })
}

pub fn update_word(conn: &Connection, id: i64, input: &WordInput) -> Result<WordRow, String> {
    let current = get_word(conn, id)?.ok_or("单词不存在")?;
    let term = {
        let t = input
            .term
            .as_deref()
            .unwrap_or(&current.term)
            .trim()
            .to_lowercase();
        if t.is_empty() {
            current.term.clone()
        } else {
            t
        }
    };
    let phonetic = non_empty(input.phonetic.as_deref()).unwrap_or_else(|| current.phonetic.clone());
    let meaning = input
        .meaning
        .as_deref()
        .unwrap_or(&current.meaning)
        .trim()
        .to_string();
    let example = input
        .example
        .as_deref()
        .unwrap_or(&current.example)
        .trim()
        .to_string();
    let tags = input.tags.as_deref().unwrap_or(&current.tags).trim().to_string();
    let unit_id = match input.unit_id {
        None => current.unit_id,
        Some(v) if v <= 0 => None,
        Some(unit) => normalize_unit(conn, current.list_id, Some(unit))?,
    };
    conn.execute(
        "update words set term = ?1, phonetic = ?2, meaning = ?3, example = ?4, tags = ?5, need_meaning = ?6, unit_id = ?7 where id = ?8",
        params![term, phonetic, meaning, example, tags, if meaning.is_empty() { 1 } else { 0 }, unit_id, id],
    )
    .map_err(|e| e.to_string())?;
    get_word(conn, id)?.ok_or_else(|| "单词不存在".into())
}

pub fn delete_words(conn: &Connection, ids: &[i64]) -> Result<i64, String> {
    if ids.is_empty() {
        return Ok(0);
    }
    let marks = vec!["?"; ids.len()].join(",");
    let args: Vec<rusqlite::types::Value> = ids.iter().map(|v| (*v).into()).collect();
    let _ = conn.execute(
        &format!("delete from round_items where word_id in ({marks})"),
        params_from_iter(args.iter()),
    );
    let _ = conn.execute(
        &format!("delete from word_states where word_id in ({marks})"),
        params_from_iter(args.iter()),
    );
    let changes = conn
        .execute(
            &format!("delete from words where id in ({marks})"),
            params_from_iter(args.iter()),
        )
        .map_err(|e| e.to_string())?;
    Ok(changes as i64)
}

pub fn word_counts(conn: &Connection, list_id: Option<i64>) -> WordCounts {
    let scope = match list_id {
        Some(_) => "and w.list_id = ?",
        None => "",
    };
    let list_arg = list_id;

    let q1 = format!("select count(*) from words w where 1=1 {scope}");
    let total: i64 = match list_arg {
        Some(id) => conn.query_row(&q1, [id], |r| r.get(0)).unwrap_or(0),
        None => conn.query_row(&q1, [], |r| r.get(0)).unwrap_or(0),
    };

    let q2 = format!(
        "select count(*) from words w join word_states s on s.word_id = w.id where s.interval_minutes >= ? {scope}"
    );
    let mastered: i64 = match list_arg {
        Some(id) => conn.query_row(&q2, params![MASTERED_FROM_MINUTES, id], |r| r.get(0)).unwrap_or(0),
        None => conn.query_row(&q2, params![MASTERED_FROM_MINUTES], |r| r.get(0)).unwrap_or(0),
    };

    let q3 = format!(
        "select count(*) from words w left join word_states s on s.word_id = w.id where s.word_id is null {scope}"
    );
    let fresh: i64 = match list_arg {
        Some(id) => conn.query_row(&q3, [id], |r| r.get(0)).unwrap_or(0),
        None => conn.query_row(&q3, [], |r| r.get(0)).unwrap_or(0),
    };

    let q4 = format!("select count(*) from words w where w.need_meaning = 1 {scope}");
    let need_meaning: i64 = match list_arg {
        Some(id) => conn.query_row(&q4, [id], |r| r.get(0)).unwrap_or(0),
        None => conn.query_row(&q4, [], |r| r.get(0)).unwrap_or(0),
    };

    let end_of_today = start_of_day(now()) + DAY_MS - 1;
    let q5 = format!(
        "select count(*) from words w join word_states s on s.word_id = w.id where s.due_at <= ? {scope}"
    );
    let due_now: i64 = match list_arg {
        Some(id) => conn
            .query_row(&q5, params![end_of_today, id], |r| r.get(0))
            .unwrap_or(0),
        None => conn
            .query_row(&q5, params![end_of_today], |r| r.get(0))
            .unwrap_or(0),
    };

    WordCounts {
        total,
        mastered,
        fresh,
        need_meaning,
        due_now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn learned_today_scope_only_returns_first_learned_today() {
        let dir = std::env::temp_dir().join(format!(
            "gancigong-words-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (rows, total) = {
            let conn = db::init(&dir).unwrap();
            conn.execute(
                "insert into lists (name, created_at) values ('t', 0)",
                [],
            )
            .unwrap();
            let list_id = conn.last_insert_rowid();
            let today = start_of_day(now()) + 1_000;
            let insert_word = |term: &str| {
                conn.execute(
                    "insert into words (list_id, term, created_at) values (?1, ?2, ?3)",
                    params![list_id, term, now()],
                )
                .unwrap();
                conn.last_insert_rowid()
            };
            let new_today = insert_word("new_today");
            let old_reviewed = insert_word("old_reviewed");
            insert_word("untouched");
            conn.execute(
                "insert into word_states (word_id, learned_at, last_reviewed_at, reps)
                 values (?1, ?2, ?2, 1)",
                params![new_today, today],
            )
            .unwrap();
            conn.execute(
                "insert into word_states (word_id, learned_at, last_reviewed_at, reps)
                 values (?1, ?2, ?3, 2)",
                params![old_reviewed, today - DAY_MS, today],
            )
            .unwrap();
            let q = WordQuery {
                scope: Some("learnedToday".into()),
                ..WordQuery::default()
            };
            list_words(&conn, &q).unwrap()
        };
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(total, 1);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].term, "new_today");
    }

    #[test]
    fn reinforce_scopes_filter_as_expected() {
        let dir = std::env::temp_dir().join(format!(
            "gancigong-reinforce-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let (studied, wrong, reviewing) = {
            let conn = db::init(&dir).unwrap();
            conn.execute(
                "insert into lists (name, created_at) values ('t', 0)",
                [],
            )
            .unwrap();
            let list_id = conn.last_insert_rowid();
            let today = start_of_day(now()) + 5_000;
            let insert_word = |term: &str| {
                conn.execute(
                    "insert into words (list_id, term, created_at) values (?1, ?2, ?3)",
                    params![list_id, term, now()],
                )
                .unwrap();
                conn.last_insert_rowid()
            };
            let today_word = insert_word("today_word");
            let old_word = insert_word("old_word");
            let mastered = insert_word("mastered_word");
            let wrong_word = insert_word("wrong_word");
            let insert_state = |word_id: i64, interval: i64, reps: i64, reviewed_at: i64| {
                conn.execute(
                    "insert into word_states
                       (word_id, interval_minutes, due_at, reps, last_reviewed_at, learned_at)
                     values (?1, ?2, ?3, ?4, ?5, ?5)",
                    params![word_id, interval, reviewed_at + 3_600_000, reps, reviewed_at],
                )
                .unwrap();
            };
            insert_state(today_word, 30, 2, today);
            insert_state(old_word, 30, 2, today - DAY_MS);
            insert_state(mastered, MASTERED_FROM_MINUTES, 5, 0);
            insert_state(wrong_word, 5, 1, today);
            conn.execute(
                "insert into wrong_book (word_id, first_wrong_at, last_wrong_at)
                 values (?1, ?2, ?2)",
                params![wrong_word, today],
            )
            .unwrap();

            let query = |scope: &str| WordQuery {
                scope: Some(scope.into()),
                ..WordQuery::default()
            };
            let terms = |scope: &str| {
                let mut out: Vec<String> = list_words(&conn, &query(scope))
                    .unwrap()
                    .0
                    .into_iter()
                    .map(|w| w.term)
                    .collect();
                out.sort();
                out
            };
            (terms("studiedToday"), terms("wrongReview"), terms("reviewing"))
        };
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(studied, vec!["today_word", "wrong_word"]);
        assert_eq!(wrong, vec!["wrong_word"]);
        assert_eq!(reviewing, vec!["old_word", "today_word", "wrong_word"]);
    }
}
