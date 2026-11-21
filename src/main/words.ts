import { all, get, run } from './db'
import { lookup } from './dictionary'
import { isMastered, MASTERED_FROM_DAYS } from '@shared/srs'
import { startOfDay } from '@shared/time'
import type { ListInfo, UpsertResult, WordCounts, WordInput, WordQuery, WordRow } from '@shared/types'

interface WordRowDb {
  id: number
  list_id: number
  term: string
  phonetic: string
  meaning: string
  example: string
  tags: string
  need_meaning: number
  created_at: number
  interval_days?: number | null
  due_at?: number | null
  reps?: number | null
  lapses?: number | null
  last_rating?: number | null
}

function map(r: WordRowDb): WordRow {
  return {
    id: r.id,
    listId: r.list_id,
    unitId: null,
    unitName: '',
    term: r.term,
    phonetic: r.phonetic ?? '',
    meaning: r.meaning ?? '',
    example: r.example ?? '',
    tags: r.tags ?? '',
    needMeaning: r.need_meaning ?? 0,
    createdAt: r.created_at,
    intervalDays: r.interval_days ?? 0,
    dueAt: r.due_at ?? null,
    reps: r.reps ?? 0,
    lapses: r.lapses ?? 0,
    lastRating: r.last_rating ?? null,
  }
}

const SELECT = `
select w.id, w.list_id, w.term, w.phonetic, w.meaning, w.example, w.tags, w.need_meaning, w.created_at,
       s.interval_days, s.due_at, s.reps, s.lapses, s.last_rating
from words w left join word_states s on s.word_id = w.id
`

export function ensureDefaultList(): number {
  const row = get<{ id: number }>('select id from lists order by id limit 1')
  if (row) return row.id
  return run("insert into lists (name, remark, created_at) values ('我的词库', '', ?)", Date.now()).lastInsertRowid
}

export function listLists(): ListInfo[] {
  const now = Date.now()
  return all<{ id: number; name: string; remark: string; word_count: number; due_count: number }>(
    `select l.id, l.name, l.remark,
            count(w.id) as word_count,
            sum(case when w.id is null then 0 when s.due_at is null then 1 when s.due_at <= ? then 1 else 0 end) as due_count
     from lists l left join words w on w.list_id = l.id
     left join word_states s on s.word_id = w.id
     group by l.id order by l.id`,
    now
  ).map((r) => ({ id: r.id, name: r.name, remark: r.remark ?? '', wordCount: r.word_count ?? 0, dueCount: r.due_count ?? 0, unitCount: 0 }))
}

export function createList(name: string, remark = ''): number {
  const clean = name.trim()
  if (!clean) throw new Error('词表名称不能为空')
  const clash = get<{ id: number }>('select id from lists where name = ?', clean)
  if (clash) return clash.id
  return run('insert into lists (name, remark, created_at) values (?, ?, ?)', clean, remark.trim(), Date.now()).lastInsertRowid
}

export function renameList(id: number, name: string, remark?: string): void {
  const clean = name.trim()
  if (!clean) throw new Error('词表名称不能为空')
  if (remark === undefined) run('update lists set name = ? where id = ?', clean, id)
  else run('update lists set name = ?, remark = ? where id = ?', clean, remark.trim(), id)
}

export function deleteList(id: number): number {
  const count = get<{ n: number }>('select count(*) n from words where list_id = ?', id)?.n ?? 0
  run('delete from word_states where word_id in (select id from words where list_id = ?)', id)
  run('delete from round_items where word_id in (select id from words where list_id = ?)', id)
  run('delete from words where list_id = ?', id)
  run('delete from lists where id = ?', id)
  return count
}

export function listWords(q: WordQuery): { rows: WordRow[]; total: number } {
  const where: string[] = []
  const params: (string | number)[] = []
  if (q.listId) {
    where.push('w.list_id = ?')
    params.push(q.listId)
  }
  if (q.query) {
    where.push('(w.term like ? or w.meaning like ?)')
    params.push(`%${q.query.trim()}%`, `%${q.query.trim()}%`)
  }
  if (q.needMeaningOnly) where.push('w.need_meaning = 1')
  const clause = where.length ? `where ${where.join(' and ')}` : ''
  const order =
    q.sort === 'term'
      ? 'w.term asc'
      : q.sort === 'lapses'
        ? 'coalesce(s.lapses, 0) desc, coalesce(s.due_at, 0) asc'
        : q.sort === 'created'
          ? 'w.id desc'
          : 'case when s.due_at is null then 0 else 1 end, coalesce(s.due_at, 0) asc, w.id asc'
  const total = get<{ n: number }>(`select count(*) n from words w ${clause}`, ...params)?.n ?? 0
  const limit = q.limit ?? 200
  const offset = q.offset ?? 0
  const rows = all<WordRowDb>(`${SELECT} ${clause} order by ${order} limit ? offset ?`, ...params, limit, offset).map(map)
  return { rows, total }
}

export function getWord(id: number): WordRow | undefined {
  const r = all<WordRowDb>(`${SELECT} where w.id = ?`, id)[0]
  return r ? map(r) : undefined
}

/** 缺失的音标/释义用离线词典补，补不到就标记待补充 */
function enrich(input: WordInput): { phonetic: string; meaning: string; tags: string; needMeaning: number; fromDictionary: boolean } {
  const term = input.term.trim().toLowerCase()
  const hit = lookup(term)
  const phonetic = (input.phonetic ?? '').trim() || hit?.phonetic || ''
  const meaning = (input.meaning ?? '').trim() || hit?.meaning || ''
  const tags = (input.tags ?? '').trim() || (hit?.tags ?? []).join(' ')
  return { phonetic, meaning, tags, needMeaning: meaning ? 0 : 1, fromDictionary: Boolean(hit) && Boolean((input.meaning ?? '').trim()) === false }
}

export function createWord(listId: number, input: WordInput): UpsertResult {
  const term = input.term.trim().toLowerCase()
  if (!term) throw new Error('单词不能为空')
  const extra = enrich(input)
  const existing = get<{ id: number }>('select id from words where list_id = ? and term = ?', listId, term)
  if (existing) {
    updateWord(existing.id, input)
    return { row: getWord(existing.id)!, fromDictionary: extra.fromDictionary }
  }
  const id = run(
    'insert into words (list_id, term, phonetic, meaning, example, tags, need_meaning, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    listId,
    term,
    extra.phonetic,
    extra.meaning,
    (input.example ?? '').trim(),
    extra.tags,
    extra.needMeaning,
    Date.now()
  ).lastInsertRowid
  return { row: getWord(id)!, fromDictionary: extra.fromDictionary }
}

export function updateWord(id: number, input: WordInput): WordRow {
  const current = getWord(id)
  if (!current) throw new Error('单词不存在')
  const term = (input.term ?? current.term).trim().toLowerCase() || current.term
  const phonetic = (input.phonetic ?? current.phonetic).trim() || current.phonetic
  const meaning = (input.meaning ?? current.meaning).trim()
  const example = (input.example ?? current.example).trim()
  const tags = (input.tags ?? current.tags).trim()
  run('update words set term = ?, phonetic = ?, meaning = ?, example = ?, tags = ?, need_meaning = ? where id = ?', term, phonetic, meaning, example, tags, meaning ? 0 : 1, id)
  return getWord(id)!
}

export function deleteWords(ids: number[]): number {
  if (!ids.length) return 0
  const marks = ids.map(() => '?').join(',')
  run(`delete from round_items where word_id in (${marks})`, ...ids)
  run(`delete from word_states where word_id in (${marks})`, ...ids)
  return run(`delete from words where id in (${marks})`, ...ids).changes
}

export function wordCounts(listId?: number | null): WordCounts {
  const scope = listId ? 'and w.list_id = ?' : ''
  const args: (number | string)[] = listId ? [listId] : []
  const total = get<{ n: number }>(`select count(*) n from words w ${scope}`, ...args)?.n ?? 0
  const mastered =
    get<{ n: number }>(
      `select count(*) n from words w join word_states s on s.word_id = w.id where s.interval_days >= ? ${scope}`,
      MASTERED_FROM_DAYS,
      ...args
    )?.n ?? 0
  const fresh =
    get<{ n: number }>(
      `select count(*) n from words w left join word_states s on s.word_id = w.id where s.word_id is null ${scope}`,
      ...args
    )?.n ?? 0
  const needMeaning = get<{ n: number }>(`select count(*) n from words w where w.need_meaning = 1 ${scope}`, ...args)?.n ?? 0
  const endOfToday = startOfDay(Date.now()) + 86_400_000 - 1
  const dueNow =
    get<{ n: number }>(
      `select count(*) n from words w join word_states s on s.word_id = w.id where s.due_at <= ? ${scope}`,
      endOfToday,
      ...args
    )?.n ?? 0
  return { total, mastered, fresh, needMeaning, dueNow }
}

export { isMastered }
