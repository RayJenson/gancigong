use rusqlite::{Connection, OptionalExtension};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 8;

const SCHEMA: &str = r#"
create table if not exists meta (
  key text primary key,
  value text not null
);
create table if not exists lists (
  id integer primary key autoincrement,
  name text not null unique,
  remark text not null default '',
  created_at integer not null
);
create table if not exists units (
  id integer primary key autoincrement,
  list_id integer not null references lists(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at integer not null,
  unique (list_id, name)
);
create index if not exists idx_units_list on units (list_id);
create table if not exists words (
  id integer primary key autoincrement,
  list_id integer not null references lists(id) on delete cascade,
  unit_id integer references units(id) on delete set null,
  term text not null,
  phonetic text not null default '',
  meaning text not null default '',
  example text not null default '',
  tags text not null default '',
  need_meaning integer not null default 0,
  created_at integer not null,
  unique (list_id, term)
);
create index if not exists idx_words_term on words (term);
create index if not exists idx_words_need_meaning on words (need_meaning);
create table if not exists word_states (
  word_id integer primary key references words(id) on delete cascade,
  interval_days integer not null default 0,
  interval_minutes integer not null default 0,
  due_at integer,
  reps integer not null default 0,
  lapses integer not null default 0,
  last_rating integer,
  last_reviewed_at integer,
  learned_at integer not null default 0
);
create index if not exists idx_states_due on word_states (due_at);
create table if not exists rounds (
  id integer primary key autoincrement,
  planned_at integer not null,
  started_at integer,
  finished_at integer,
  mode text not null,
  lock_level text not null default 'app',
  planned_count integer not null default 0,
  rated_count integer not null default 0,
  status text not null default 'open'
);
create index if not exists idx_rounds_planned on rounds (planned_at);
create table if not exists round_items (
  id integer primary key autoincrement,
  round_id integer not null references rounds(id) on delete cascade,
  word_id integer not null references words(id) on delete cascade,
  position integer not null,
  rating integer,
  shown_at integer not null,
  rated_at integer
);
create index if not exists idx_items_round on round_items (round_id);
create index if not exists idx_items_word on round_items (word_id);
create table if not exists daily_wrongs (
  day text not null,
  word_id integer not null references words(id) on delete cascade,
  created_at integer not null,
  primary key (day, word_id)
);
create index if not exists idx_daily_wrongs_day on daily_wrongs (day);
create table if not exists wrong_book (
  word_id integer primary key references words(id) on delete cascade,
  first_wrong_at integer not null,
  last_wrong_at integer not null
);
create index if not exists idx_wrong_book_last on wrong_book (last_wrong_at);
create table if not exists delay_slots (
  day text primary key,
  used integer not null default 0,
  quota integer not null
);
create table if not exists settings (
  key text primary key,
  value_json text not null
);
create table if not exists learn_progress (
  scope text primary key,
  payload text not null,
  updated_at integer not null
);
create table if not exists events (
  id integer primary key autoincrement,
  kind text not null,
  detail_json text,
  at integer not null
);
create index if not exists idx_events_at on events (at);
"#;

/// 与 Electron 版共用数据目录：%APPDATA%\赶词工\gancigong.db
pub fn data_dir() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("赶词工")
}

pub fn init(dir: &Path) -> Result<Connection, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("无法创建数据目录：{e}"))?;
    let conn = Connection::open(dir.join("gancigong.db")).map_err(|e| format!("无法打开数据库：{e}"))?;
    conn.execute_batch("pragma journal_mode = WAL; pragma foreign_keys = ON;")
        .map_err(|e| format!("数据库初始化失败：{e}"))?;
    conn.execute_batch(SCHEMA)
        .map_err(|e| format!("建表失败：{e}"))?;

    let existing: Option<String> = conn
        .query_row("select value from meta where key = 'schema_version'", [], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    match existing {
        None => {
            conn.execute(
                "insert into meta (key, value) values ('schema_version', ?1)",
                [SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
        Some(v) => {
            let version = v.parse::<i64>().unwrap_or(-1);
            if version > SCHEMA_VERSION {
                return Err(format!("数据库版本 {v} 与当前程序 {SCHEMA_VERSION} 不兼容"));
            }
            if version < 2 {
                migrate_to_v2(&conn)?;
                log_event(
                    &conn,
                    "schema_migrated",
                    Some(serde_json::json!({ "from": version, "to": 2 })),
                );
            }
            if version < 3 {
                // v3 只新增 daily_wrongs，建表已由 SCHEMA 的 if not exists 完成
                log_event(
                    &conn,
                    "schema_migrated",
                    Some(serde_json::json!({ "from": version, "to": 3 })),
                );
            }
            if version < 4 {
                // v4 只新增 learn_progress（学习中断快照），建表同样交给 SCHEMA
                log_event(
                    &conn,
                    "schema_migrated",
                    Some(serde_json::json!({ "from": version, "to": 4 })),
                );
            }
            if version < 5 {
                migrate_to_v5(&conn)?;
                log_event(
                    &conn,
                    "schema_migrated",
                    Some(serde_json::json!({ "from": version, "to": 5 })),
                );
            }
            if version < 6 {
                migrate_to_v6(&conn)?;
                log_event(
                    &conn,
                    "schema_migrated",
                    Some(serde_json::json!({ "from": version, "to": 6 })),
                );
            }
            if version < 7 {
                migrate_to_v7(&conn)?;
                log_event(
                    &conn,
                    "schema_migrated",
                    Some(serde_json::json!({ "from": version, "to": 7 })),
                );
            }
            if version < 8 {
                migrate_to_v8(&conn)?;
                log_event(
                    &conn,
                    "schema_migrated",
                    Some(serde_json::json!({ "from": version, "to": 8 })),
                );
            }
            conn.execute(
                "update meta set value = ?1 where key = 'schema_version'",
                [SCHEMA_VERSION.to_string()],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    // 单元索引等列迁移完成后再建，老库的 words 表此时才补上 unit_id
    conn.execute_batch("create index if not exists idx_words_unit on words (unit_id)")
        .map_err(|e| format!("建索引失败：{e}"))?;
    Ok(conn)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("pragma table_info({table})"))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let name: String = row.get(1).map_err(|e| e.to_string())?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// v5 把复习间隔从天细化到分钟，老数据的按天间隔乘以 1440 回填
fn migrate_to_v5(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "word_states", "interval_minutes")? {
        conn.execute_batch(
            "alter table word_states add column interval_minutes integer not null default 0",
        )
        .map_err(|e| format!("升级复习间隔字段失败：{e}"))?;
    }
    conn.execute(
        "update word_states set interval_minutes = interval_days * 1440
         where interval_minutes = 0 and interval_days > 0",
        [],
    )
    .map_err(|e| format!("回填复习间隔失败：{e}"))?;
    Ok(())
}

/// v6 记录单词首次学习时间，用于「每日新词目标」的当日进度。
/// 老数据的首次学习时间已无从考证，保持 0 表示「今天之前」，
/// 不要把 last_reviewed_at 倒灌进来，否则升级当天会把复习过的旧词算成新词。
fn migrate_to_v6(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "word_states", "learned_at")? {
        conn.execute_batch(
            "alter table word_states add column learned_at integer not null default 0",
        )
        .map_err(|e| format!("升级学习时间字段失败：{e}"))?;
    }
    Ok(())
}

/// v7 建立永久错词本，把历次 daily_wrongs 里出现过的词都回填进去
fn migrate_to_v7(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "insert or ignore into wrong_book (word_id, first_wrong_at, last_wrong_at)
         select word_id, min(created_at), max(created_at) from daily_wrongs group by word_id",
        [],
    )
    .map_err(|e| format!("回填错词本失败：{e}"))?;
    Ok(())
}

/// v8 用遗忘次数补全错词本：早期答对会被移出今日错词，daily_wrongs 已丢过记录
fn migrate_to_v8(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "insert or ignore into wrong_book (word_id, first_wrong_at, last_wrong_at)
         select s.word_id,
                coalesce((select min(d.created_at) from daily_wrongs d where d.word_id = s.word_id),
                         s.last_reviewed_at, s.learned_at, cast(strftime('%s', 'now') as integer) * 1000),
                coalesce((select max(d.created_at) from daily_wrongs d where d.word_id = s.word_id),
                         s.last_reviewed_at, s.learned_at, cast(strftime('%s', 'now') as integer) * 1000)
         from word_states s
         where s.lapses > 0",
        [],
    )
    .map_err(|e| format!("补全错词本失败：{e}"))?;
    Ok(())
}

fn migrate_to_v2(conn: &Connection) -> Result<(), String> {
    if !has_column(conn, "words", "unit_id")? {
        conn.execute_batch(
            "alter table words add column unit_id integer references units(id) on delete set null",
        )
        .map_err(|e| format!("升级单元字段失败：{e}"))?;
    }
    Ok(())
}

pub fn log_event(conn: &Connection, kind: &str, detail: Option<serde_json::Value>) {
    let json = detail.map(|v| v.to_string());
    let _ = conn.execute(
        "insert into events (kind, detail_json, at) values (?1, ?2, ?3)",
        rusqlite::params![kind, json, crate::util::now()],
    );
}
