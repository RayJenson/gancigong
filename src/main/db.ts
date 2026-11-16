import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { app } from 'electron'

type Bind = null | number | string | bigint | Uint8Array | boolean
let db: DatabaseSync | null = null

const SCHEMA_VERSION = 1

const SCHEMA = `
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
create table if not exists words (
  id integer primary key autoincrement,
  list_id integer not null references lists(id) on delete cascade,
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
  due_at integer,
  reps integer not null default 0,
  lapses integer not null default 0,
  last_rating integer,
  last_reviewed_at integer
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
create table if not exists delay_slots (
  day text primary key,
  used integer not null default 0,
  quota integer not null
);
create table if not exists settings (
  key text primary key,
  value_json text not null
);
create table if not exists events (
  id integer primary key autoincrement,
  kind text not null,
  detail_json text,
  at integer not null
);
create index if not exists idx_events_at on events (at);
`

export function dbPath(): string {
  return join(app.getPath('userData'), 'gancigong.db')
}

export function initDb(): DatabaseSync {
  if (db) return db
  mkdirSync(app.getPath('userData'), { recursive: true })
  db = new DatabaseSync(dbPath())
  db.exec('pragma journal_mode = WAL')
  db.exec('pragma foreign_keys = ON')
  db.exec(SCHEMA)
  const row = get<{ value: string }>("select value from meta where key = 'schema_version'")
  if (!row) {
    run("insert into meta (key, value) values ('schema_version', ?)", String(SCHEMA_VERSION))
  } else if (Number(row.value) !== SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${row.value} 与当前程序 ${SCHEMA_VERSION} 不兼容`)
  }
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('数据库尚未初始化')
  return db
}

function normalize(params: Bind[]): SQLInputValue[] {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p))
}

export function all<T>(sql: string, ...params: Bind[]): T[] {
  return getDb()
    .prepare(sql)
    .all(...normalize(params)) as T[]
}

export function get<T>(sql: string, ...params: Bind[]): T | undefined {
  const r = getDb()
    .prepare(sql)
    .get(...normalize(params))
  return r === undefined ? undefined : (r as T)
}

export function run(sql: string, ...params: Bind[]): { changes: number; lastInsertRowid: number } {
  const r = getDb().prepare(sql).run(...normalize(params))
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
}

export function exec(sql: string): void {
  getDb().exec(sql)
}

export function transaction<T>(fn: () => T): T {
  const d = getDb()
  d.exec('begin')
  try {
    const out = fn()
    d.exec('commit')
    return out
  } catch (err) {
    d.exec('rollback')
    throw err
  }
}

export function logEvent(kind: string, detail?: unknown): void {
  run('insert into events (kind, detail_json, at) values (?, ?, ?)', kind, detail === undefined ? null : JSON.stringify(detail), Date.now())
}
