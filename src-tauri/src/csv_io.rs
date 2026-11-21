use crate::db::log_event;
use crate::dictionary::Dictionary;
use crate::models::ImportResult;
use crate::words::{create_list, create_unit, ensure_default_list, normalize_unit};
use chrono::{Local, TimeZone};
use rusqlite::{params, Connection};
use serde_json::json;
use std::path::Path;

#[derive(Clone, Debug, Default)]
pub struct CsvWord {
    pub term: String,
    pub phonetic: String,
    pub meaning: String,
    pub example: String,
    pub tags: String,
    pub list_name: String,
    pub unit_name: String,
}

#[derive(Debug)]
pub struct CsvParseResult {
    pub words: Vec<CsvWord>,
    pub errors: Vec<String>,
    pub total_rows: i64,
}

const COLUMN_KEYS: [(&str, &[&str]); 7] = [
    ("term", &["word", "term", "english", "vocabulary", "headword", "单词", "英文", "词汇"]),
    (
        "meaning",
        &["meaning", "translation", "chinese", "definition", "释义", "翻译", "中文", "解释", "意思"],
    ),
    ("phonetic", &["phonetic", "phonetics", "ipa", "音标"]),
    ("example", &["example", "sentence", "context", "例句", "例子"]),
    ("tags", &["tag", "tags", "label", "标签"]),
    ("list_name", &["list", "group", "book", "词表", "分组", "课本"]),
    ("unit_name", &["unit", "section", "chapter", "lesson", "单元", "章节", "课"]),
];

fn norm_header(header: &str) -> String {
    header
        .trim()
        .to_lowercase()
        .chars()
        .filter(|c| !matches!(c, '_' | ' ' | '-'))
        .collect()
}

fn match_key(header: &str) -> Option<&'static str> {
    let norm = norm_header(header);
    for (key, aliases) in COLUMN_KEYS {
        if aliases.iter().any(|a| norm_header(a) == norm) {
            return Some(key);
        }
    }
    None
}

pub fn decode(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    for enc in [encoding_rs::GBK, encoding_rs::BIG5] {
        let (cow, _, had_errors) = enc.decode(bytes);
        if !had_errors {
            return cow.into_owned();
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn detect_delimiter(text: &str) -> u8 {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let mut counts = [(b',', 0usize), (b'\t', 0usize), (b';', 0usize)];
    let mut in_quotes = false;
    for b in line.bytes() {
        if b == b'"' {
            in_quotes = !in_quotes;
            continue;
        }
        if in_quotes {
            continue;
        }
        for (delim, count) in counts.iter_mut() {
            if b == *delim {
                *count += 1;
            }
        }
    }
    counts
        .iter()
        .max_by_key(|(_, n)| *n)
        .map(|(d, _)| *d)
        .unwrap_or(b',')
}

pub fn parse(text: &str) -> CsvParseResult {
    let cleaned = text.strip_prefix('\u{feff}').unwrap_or(text);
    let delim = detect_delimiter(cleaned);
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .delimiter(delim)
        .from_reader(cleaned.as_bytes());

    let mut grid: Vec<Vec<String>> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    for (i, rec) in rdr.records().enumerate() {
        match rec {
            Ok(r) => {
                let row: Vec<String> = r.iter().map(|c| c.trim().to_string()).collect();
                if row.iter().all(|c| c.is_empty()) {
                    continue;
                }
                grid.push(row);
            }
            Err(e) => {
                if errors.len() < 20 {
                    errors.push(format!("第 {} 行：{}", i + 1, e));
                }
            }
        }
    }
    if grid.is_empty() {
        if errors.is_empty() {
            errors.push("文件里没有内容".into());
        }
        return CsvParseResult {
            words: Vec::new(),
            errors,
            total_rows: 0,
        };
    }

    let first = &grid[0];
    let header_map: Vec<Option<&'static str>> = first.iter().map(|c| match_key(c)).collect();
    let header_detected = header_map.iter().any(|k| k.is_some());
    let body: &[Vec<String>] = if header_detected { &grid[1..] } else { &grid[..] };

    let mut words = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for row in body {
        let mut item = CsvWord::default();
        for (i, cell) in row.iter().enumerate() {
            if cell.is_empty() {
                continue;
            }
            let key = if header_detected {
                header_map.get(i).copied().flatten()
            } else if i == 0 {
                Some("term")
            } else if i == 1 {
                Some("meaning")
            } else {
                None
            };
            let Some(key) = key else { continue };
            let slot = match key {
                "term" => &mut item.term,
                "meaning" => &mut item.meaning,
                "phonetic" => &mut item.phonetic,
                "example" => &mut item.example,
                "tags" => &mut item.tags,
                "list_name" => &mut item.list_name,
                "unit_name" => &mut item.unit_name,
                _ => continue,
            };
            if slot.is_empty() {
                *slot = cell.clone();
            }
        }
        if item.term.is_empty() {
            continue;
        }
        let dedup = format!(
            "{}::{}::{}",
            item.list_name,
            item.unit_name,
            item.term.to_lowercase()
        );
        if !seen.insert(dedup) {
            continue;
        }
        words.push(item);
    }

    CsvParseResult {
        words,
        errors,
        total_rows: body.len() as i64,
    }
}

fn is_term_shape(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    let rest: Vec<char> = chars.collect();
    if rest.len() > 47 {
        return false;
    }
    rest.iter()
        .all(|c| c.is_ascii_alphabetic() || matches!(c, '\'' | '\u{2019}' | '.' | '-' | ' '))
}

pub fn import_file(
    conn: &Connection,
    dict: &Dictionary,
    file_path: &Path,
    target_list: Option<i64>,
    target_unit: Option<i64>,
) -> Result<ImportResult, String> {
    let bytes = std::fs::read(file_path).map_err(|e| format!("读不到文件：{e}"))?;
    let parsed = parse(&decode(&bytes));
    let file_name = file_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut result = ImportResult {
        total_rows: parsed.total_rows,
        errors: parsed.errors.clone(),
        file_name: file_name.clone(),
        ..Default::default()
    };

    if parsed.words.is_empty() {
        result
            .errors
            .push("没有解析出任何单词，请检查表头是否包含「单词 / 释义」之类的列".into());
        return Ok(result);
    }

    let default_list = match target_list {
        Some(id) => id,
        None => ensure_default_list(conn)?,
    };
    let fixed_unit = normalize_unit(conn, default_list, target_unit)?;
    let mut grouped: std::collections::HashMap<(i64, Option<i64>), Vec<CsvWord>> =
        std::collections::HashMap::new();
    let mut bad_rows: Vec<String> = Vec::new();
    for w in &parsed.words {
        if !is_term_shape(&w.term) {
            if bad_rows.len() < 8 {
                let preview: String = w.term.chars().take(24).collect();
                bad_rows.push(format!("「{preview}」不像英文单词，已跳过"));
            }
            result.skipped += 1;
            continue;
        }
        let list_id = if target_list.is_some() || w.list_name.is_empty() {
            default_list
        } else {
            create_list(conn, &w.list_name, &format!("来自 {file_name}"))?
        };
        // 指定了目标单元就整份导入该单元，否则按 CSV 的「单元」列归组
        let unit_id = match fixed_unit {
            Some(id) => Some(id),
            None if w.unit_name.is_empty() => None,
            None => Some(create_unit(conn, list_id, &w.unit_name)?),
        };
        grouped.entry((list_id, unit_id)).or_default().push(w.clone());
    }
    result.errors.extend(bad_rows);

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for ((list_id, unit_id), words) in &grouped {
        upsert_into_list(&tx, dict, *list_id, *unit_id, words, &mut result)?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    log_event(
        conn,
        "import",
        Some(json!({
            "file": file_name,
            "created": result.created,
            "updated": result.updated,
            "skipped": result.skipped,
            "filledFromDict": result.filled_from_dict,
            "missingMeaning": result.missing_meaning,
        })),
    );
    Ok(result)
}

fn upsert_into_list(
    conn: &Connection,
    dict: &Dictionary,
    list_id: i64,
    unit_id: Option<i64>,
    words: &[CsvWord],
    result: &mut ImportResult,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare("select term, phonetic, meaning, example, tags from words where list_id = ?1")
        .map_err(|e| e.to_string())?;
    let existing: std::collections::HashMap<String, (String, String, String, String, String)> = stmt
        .query_map([list_id], |r| {
            Ok((
                r.get::<_, String>(0)?.to_lowercase(),
                (
                    r.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                ),
            ))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    for item in words {
        let term = item.term.trim().to_lowercase();
        let hit = dict.lookup(&term);
        if let Some((_cur_term, cur_phonetic, cur_meaning, cur_example, cur_tags)) = existing.get(&term) {
            let meaning = pick(&item.meaning, cur_meaning)
                .or_else(|| hit.as_ref().map(|h| h.meaning.clone()))
                .unwrap_or_default();
            let phonetic = pick(&item.phonetic, cur_phonetic)
                .or_else(|| hit.as_ref().map(|h| h.phonetic.clone()))
                .unwrap_or_default();
            let example = pick(&item.example, cur_example).unwrap_or_default();
            let tags = pick(&item.tags, cur_tags)
                .or_else(|| hit.as_ref().map(|h| h.tags.join(" ")))
                .unwrap_or_default();
            if meaning == *cur_meaning
                && phonetic == *cur_phonetic
                && example == *cur_example
                && tags == *cur_tags
            {
                result.skipped += 1;
                continue;
            }
            if item.meaning.is_empty() && cur_meaning.is_empty() && hit.as_ref().is_some_and(|h| !h.meaning.is_empty()) {
                result.filled_from_dict += 1;
            }
            match unit_id {
                Some(unit) => conn.execute(
                    "update words set meaning = ?1, phonetic = ?2, example = ?3, tags = ?4, need_meaning = ?5, unit_id = ?6 where list_id = ?7 and lower(term) = ?8",
                    params![meaning, phonetic, example, tags, if meaning.is_empty() { 1 } else { 0 }, unit, list_id, term],
                ),
                None => conn.execute(
                    "update words set meaning = ?1, phonetic = ?2, example = ?3, tags = ?4, need_meaning = ?5 where list_id = ?6 and lower(term) = ?7",
                    params![meaning, phonetic, example, tags, if meaning.is_empty() { 1 } else { 0 }, list_id, term],
                ),
            }
            .map_err(|e| e.to_string())?;
            result.updated += 1;
            continue;
        }

        let meaning = if item.meaning.is_empty() {
            hit.as_ref().map(|h| h.meaning.clone()).unwrap_or_default()
        } else {
            item.meaning.clone()
        };
        if !meaning.is_empty() && item.meaning.is_empty() {
            result.filled_from_dict += 1;
        }
        if meaning.is_empty() {
            result.missing_meaning += 1;
        }
        let phonetic = if item.phonetic.is_empty() {
            hit.as_ref().map(|h| h.phonetic.clone()).unwrap_or_default()
        } else {
            item.phonetic.clone()
        };
        let tags = if item.tags.is_empty() {
            hit.as_ref().map(|h| h.tags.join(" ")).unwrap_or_default()
        } else {
            item.tags.clone()
        };
        conn.execute(
            "insert into words (list_id, unit_id, term, phonetic, meaning, example, tags, need_meaning, created_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                list_id,
                unit_id,
                term,
                phonetic,
                meaning,
                item.example,
                tags,
                if meaning.is_empty() { 1 } else { 0 },
                crate::util::now()
            ],
        )
        .map_err(|e| e.to_string())?;
        result.created += 1;
    }
    Ok(())
}

fn pick(primary: &str, fallback: &str) -> Option<String> {
    let p = primary.trim();
    if !p.is_empty() {
        Some(p.to_string())
    } else if !fallback.is_empty() {
        Some(fallback.to_string())
    } else {
        None
    }
}

fn iso_or_empty(ts: Option<i64>) -> String {
    let Some(ts) = ts else {
        return String::new();
    };
    Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

pub fn export_file(conn: &Connection, list_id: Option<i64>, out_path: &Path) -> Result<i64, String> {
    let sql = format!(
        "select w.term, w.phonetic, w.meaning, w.example, w.tags, l.name as list_name,
                coalesce(u.name, '') as unit_name,
                s.interval_days, s.due_at, s.reps, s.lapses
         from words w join lists l on l.id = w.list_id
         left join units u on u.id = w.unit_id
         left join word_states s on s.word_id = w.id
         {}
         order by l.id, u.position, s.due_at is null, s.due_at, w.term",
        if list_id.is_some() { "where w.list_id = ?1" } else { "" }
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let collect = |r: &rusqlite::Row| -> rusqlite::Result<Vec<String>> {
        Ok(vec![
            r.get::<_, Option<String>>(0)?.unwrap_or_default(),
            r.get::<_, Option<String>>(1)?.unwrap_or_default(),
            r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            r.get::<_, Option<String>>(4)?.unwrap_or_default(),
            r.get::<_, Option<String>>(5)?.unwrap_or_default(),
            r.get::<_, Option<String>>(6)?.unwrap_or_default(),
            r.get::<_, Option<i64>>(7)?.unwrap_or(0).to_string(),
            iso_or_empty(r.get(8)?),
            r.get::<_, Option<i64>>(9)?.unwrap_or(0).to_string(),
            r.get::<_, Option<i64>>(10)?.unwrap_or(0).to_string(),
        ])
    };
    let rows: Vec<Vec<String>> = match list_id {
        Some(id) => stmt
            .query_map([id], collect)
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?,
        None => stmt
            .query_map([], collect)
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?,
    };

    let mut wtr = csv::WriterBuilder::new().from_writer(Vec::new());
    wtr.write_record([
        "term",
        "phonetic",
        "meaning",
        "example",
        "tags",
        "list",
        "unit",
        "interval_days",
        "due_at",
        "reps",
        "lapses",
    ])
    .map_err(|e| e.to_string())?;
    for row in &rows {
        wtr.write_record(row).map_err(|e| e.to_string())?;
    }
    let data = wtr.into_inner().map_err(|e| e.to_string())?;
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend_from_slice(&data);
    std::fs::write(out_path, bytes).map_err(|e| format!("写入失败：{e}"))?;

    let file_name = out_path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    log_event(
        conn,
        "export",
        Some(json!({ "file": file_name, "rows": rows.len() })),
    );
    Ok(rows.len() as i64)
}
