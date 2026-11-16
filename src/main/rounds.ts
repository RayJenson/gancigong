import { all, get, logEvent, run, transaction } from './db'
import { lookup } from './dictionary'
import { getSettings } from './settings'
import { applyRating, isMastered } from '@shared/srs'
import { dayKey, startOfDay } from '@shared/time'
import { wordCounts } from './words'
import type { CardData, DashboardState, DayStat, LockLevel, PracticeMode, QuotaState, Rating, ReviewMode, RoundStatus, RoundSummary, TimeWindow } from '@shared/types'

const DAY_MS = 86_400_000

interface CardRow {
  id: number
  term: string
  phonetic: string
  meaning: string
  example: string
  reps: number
}

export interface ActiveRound {
  id: number
  mode: ReviewMode
  lockLevel: LockLevel
  ttsEnabled: boolean
  plannedAt: number
  startedAt: number
  cards: CardData[]
  status: RoundStatus
}

const active = new Map<number, ActiveRound>()

function toCard(r: CardRow, practice: PracticeMode): CardData {
  const hit = lookup(r.term)
  const meaning = r.meaning || hit?.meaning || ''
  // 用户可指定题型；auto 时新词先默写、复习过的改选义。没有释义就没法出题，退回翻牌
  const wanted = practice === 'auto' ? (r.reps === 0 ? 'spell' : 'choice') : practice
  return {
    wordId: r.id,
    term: r.term,
    phonetic: r.phonetic || hit?.phonetic || '',
    meaning,
    example: r.example,
    forms: hit?.forms ?? [],
    mode: !meaning.trim() ? 'reveal' : wanted,
    options: [],
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** 选择题的干扰项从全库释义里随机取，避免同一轮里几个词共用同一组选项 */
function attachOptions(cards: CardData[]): CardData[] {
  if (!cards.some((c) => c.mode === 'choice')) return cards
  const pool = all<{ meaning: string }>(
    "select distinct trim(meaning) meaning from words where trim(meaning) <> '' order by random() limit 120"
  ).map((r) => r.meaning)
  for (const card of cards) {
    if (card.mode !== 'choice') continue
    const answer = card.meaning.trim()
    const distractors: string[] = []
    for (const meaning of shuffle(pool)) {
      if (distractors.length >= 3) break
      if (meaning === answer || distractors.includes(meaning)) continue
      distractors.push(meaning)
    }
    // 干扰项凑不够就不要硬凑俩选项，退回翻牌
    if (distractors.length < 2) {
      card.mode = 'reveal'
      continue
    }
    card.options = shuffle([answer, ...distractors])
  }
  return cards
}

function listScope(listId: number | null): { clause: string; params: number[] } {
  return listId ? { clause: 'and w.list_id = ?', params: [listId] } : { clause: '', params: [] }
}

/**
 * 一轮的取词顺序：到期词 → 新词 → 最接近到期的词（允许提前复习），去重后截断到 wordsPerRound。
 */
export function pickWords(count: number, listId: number | null): CardData[] {
  const now = Date.now()
  const scope = listScope(listId)
  const picked = new Map<number, CardRow>()

  const push = (rows: CardRow[]) => {
    for (const r of rows) if (!picked.has(r.id)) picked.set(r.id, r)
  }

  push(
    all<CardRow>(
      `select w.id, w.term, w.phonetic, w.meaning, w.example, s.reps as reps
       from words w join word_states s on s.word_id = w.id
       where s.due_at <= ? ${scope.clause}
       order by s.due_at asc, s.interval_days asc, w.id asc limit ?`,
      now, ...scope.params, count
    )
  )
  if (picked.size < count) {
    push(
      all<CardRow>(
        `select w.id, w.term, w.phonetic, w.meaning, w.example, coalesce(s.reps, 0) as reps
         from words w left join word_states s on s.word_id = w.id
         where s.word_id is null ${scope.clause}
         order by w.id asc limit ?`,
        ...scope.params, count - picked.size
      )
    )
  }
  if (picked.size < count) {
    push(
      all<CardRow>(
        `select w.id, w.term, w.phonetic, w.meaning, w.example, s.reps as reps
         from words w join word_states s on s.word_id = w.id
         where s.due_at > ? ${scope.clause}
         order by s.due_at asc limit ?`,
        now, ...scope.params, count - picked.size
      )
    )
  }
  const practice = getSettings().practiceMode
  return attachOptions([...picked.values()].map((r) => toCard(r, practice)))
}

export function openRound(mode: ReviewMode, plannedAt: number, recordEmpty = true): ActiveRound | null {
  const s = getSettings()
  const cards = pickWords(s.wordsPerRound, s.activeListId)
  if (!cards.length) {
    // 到点却没词可复习要留一条审计记录；用户手点「开始复习」失败不该往历史里塞空轮
    if (recordEmpty) {
      const id = run(
        "insert into rounds (planned_at, mode, lock_level, planned_count, status, started_at) values (?, ?, ?, 0, 'empty', ?)",
        plannedAt, mode, s.lockLevel, Date.now()
      ).lastInsertRowid
      run('update rounds set finished_at = ? where id = ?', Date.now(), id)
    }
    return null
  }
  const round: ActiveRound = {
    id: 0,
    mode,
    lockLevel: s.lockLevel,
    ttsEnabled: s.ttsEnabled,
    plannedAt,
    startedAt: Date.now(),
    cards,
    status: 'open',
  }
  const id = transaction(() => {
    const rowId = run(
      'insert into rounds (planned_at, started_at, mode, lock_level, planned_count, status) values (?, ?, ?, ?, ?, \'open\')',
      plannedAt, round.startedAt, mode, s.lockLevel, cards.length
    ).lastInsertRowid
    cards.forEach((c, i) => {
      run('insert into round_items (round_id, word_id, position, shown_at) values (?, ?, ?, ?)', rowId, c.wordId, i, Date.now())
    })
    return rowId
  })
  round.id = id
  active.set(id, round)
  return round
}

export function getActiveRound(id: number): ActiveRound | undefined {
  return active.get(id)
}

export function hasActiveRound(): boolean {
  return active.size > 0
}

export function rate(roundId: number, wordId: number, rating: Rating): { nextDueAt: number; intervalDays: number } {
  const now = Date.now()
  return transaction(() => {
    run('update round_items set rating = ?, rated_at = ? where round_id = ? and word_id = ?', rating ? 1 : 0, now, roundId, wordId)
    const st = get<{ interval_days: number; reps: number; lapses: number }>(
      'select interval_days, reps, lapses from word_states where word_id = ?',
      wordId
    )
    const current = st?.interval_days ?? 0
    const intervalDays = applyRating(current, rating)
    const dueAt = startOfDay(now) + intervalDays * DAY_MS
    run(
      `insert into word_states (word_id, interval_days, due_at, reps, lapses, last_rating, last_reviewed_at)
       values (?, ?, ?, 1, ?, ?, ?)
       on conflict(word_id) do update set
         interval_days = excluded.interval_days,
         due_at = excluded.due_at,
         reps = word_states.reps + 1,
         lapses = word_states.lapses + excluded.lapses,
         last_rating = excluded.last_rating,
         last_reviewed_at = excluded.last_reviewed_at`,
      wordId, intervalDays, dueAt, rating === 0 ? 1 : 0, rating === 1 ? 1 : 0, now
    )
    return { nextDueAt: dueAt, intervalDays }
  })
}

function closeRound(roundId: number, status: RoundStatus): void {
  const rated = get<{ n: number }>('select count(*) n from round_items where round_id = ? and rating is not null', roundId)?.n ?? 0
  run('update rounds set status = ?, rated_count = ?, finished_at = ? where id = ?', status, rated, Date.now(), roundId)
  active.delete(roundId)
}

export function finishRound(roundId: number): { rated: number; known: number } {
  const rated = get<{ n: number }>('select count(*) n from round_items where round_id = ? and rating is not null', roundId)?.n ?? 0
  const known = get<{ n: number }>('select count(*) n from round_items where round_id = ? and rating = 1', roundId)?.n ?? 0
  closeRound(roundId, rated ? 'done' : 'skipped')
  logEvent('round_done', { roundId, rated, known })
  return { rated, known }
}

export function abortRound(roundId: number, reason: string): void {
  if (!active.has(roundId)) return
  closeRound(roundId, 'aborted')
  logEvent('round_aborted', { roundId, reason })
}

export function quotaState(): QuotaState {
  const s = getSettings()
  const used = get<{ used: number }>('select used from delay_slots where day = ?', dayKey(Date.now()))?.used ?? 0
  return { used, quota: s.delayQuotaPerDay, left: Math.max(0, s.delayQuotaPerDay - used) }
}

/** 消耗一次今日延后额度；额度用尽返回 null，由调用方决定「必须复习」 */
export function consumeDelay(roundId: number, reason: string): QuotaState | null {
  const s = getSettings()
  const day = dayKey(Date.now())
  const state = quotaState()
  if (state.left <= 0) {
    logEvent('quota_exhausted', { roundId, reason, used: state.used, quota: s.delayQuotaPerDay })
    return null
  }
  run(
    `insert into delay_slots (day, used, quota) values (?, 1, ?)
     on conflict(day) do update set used = delay_slots.used + 1, quota = excluded.quota`,
    day, s.delayQuotaPerDay
  )
  logEvent('delay', { roundId, reason, used: state.used + 1, quota: s.delayQuotaPerDay, minutes: s.delayMinutes })
  return quotaState()
}

export function wordsRatedToday(): number {
  const from = startOfDay(Date.now())
  return get<{ n: number }>('select count(*) n from round_items where rating is not null and shown_at >= ?', from)?.n ?? 0
}

export function todayKnowRate(): number | null {
  const from = startOfDay(Date.now())
  const r = get<{ total: number; known: number }>(
    `select count(*) total, sum(case when rating = 1 then 1 else 0 end) known
     from round_items where rating is not null and shown_at >= ?`,
    from
  )
  if (!r || !r.total) return null
  return Math.round(((r.known ?? 0) / r.total) * 100)
}

export function streakDays(): number {
  const days = new Set(all<{ d: string }>('select distinct date(shown_at / 1000, \'unixepoch\', \'localtime\') d from round_items where rating is not null').map((r) => r.d))
  if (!days.size) return 0
  let streak = 0
  let cursor = startOfDay(Date.now())
  if (!days.has(dayKey(cursor))) cursor -= DAY_MS
  while (days.has(dayKey(cursor))) {
    streak++
    cursor -= DAY_MS
  }
  return streak
}

export function dailySeries(days = 14): DayStat[] {
  const from = startOfDay(Date.now()) - (days - 1) * DAY_MS
  const rows = all<{ d: string; total: number; known: number }>(
    `select date(shown_at / 1000, 'unixepoch', 'localtime') d, count(*) total,
            sum(case when rating = 1 then 1 else 0 end) known
     from round_items where rating is not null and shown_at >= ?
     group by d`,
    from
  )
  const byDay = new Map(rows.map((r) => [r.d, r]))
  const out: DayStat[] = []
  for (let i = 0; i < days; i++) {
    const key = dayKey(from + i * DAY_MS)
    const r = byDay.get(key)
    out.push({ day: key, words: r?.total ?? 0, known: r?.known ?? 0, rate: r?.total ? Math.round(((r.known ?? 0) / r.total) * 100) : null })
  }
  return out
}

export function topLapses(limit = 20): { term: string; meaning: string; lapses: number; reps: number; intervalDays: number }[] {
  return all<{ term: string; meaning: string; lapses: number; reps: number; interval_days: number }>(
    `select w.term, w.meaning, s.lapses, s.reps, s.interval_days
     from word_states s join words w on w.id = s.word_id
     where s.lapses > 0 order by s.lapses desc, s.reps asc limit ?`,
    limit
  ).map((r) => ({ term: r.term, meaning: r.meaning, lapses: r.lapses, reps: r.reps, intervalDays: r.interval_days }))
}

export function recentRounds(limit = 5): RoundSummary[] {
  return all<{ id: number; planned_at: number; mode: string; planned_count: number; rated_count: number; status: string; known: number | null }>(
    `select r.id, r.planned_at, r.mode, r.planned_count, r.rated_count, r.status,
            (select count(*) from round_items i where i.round_id = r.id and i.rating = 1) as known
     from rounds r
     where r.status <> 'empty'
     order by r.planned_at desc limit ?`,
    limit
  ).map((r) => ({
    id: r.id,
    plannedAt: r.planned_at,
    mode: r.mode,
    planned: r.planned_count,
    rated: r.rated_count,
    status: r.status,
    knowRate: r.rated_count ? Math.round(((r.known ?? 0) / r.rated_count) * 100) : null,
  }))
}

/** 今日待复习 = 已到期 + 还没排过程序的新词 */
export function dueCount(listId: number | null = null): number {
  const scope = listScope(listId)
  const now = Date.now()
  const overdue =
    get<{ n: number }>(
      `select count(*) n from word_states s join words w on w.id = s.word_id where s.due_at <= ? ${scope.clause}`,
      now,
      ...scope.params
    )?.n ?? 0
  const fresh =
    get<{ n: number }>(
      `select count(*) n from words w left join word_states s on s.word_id = w.id where s.word_id is null ${scope.clause}`,
      ...scope.params
    )?.n ?? 0
  return overdue + fresh
}

export function buildDashboard(extra: { nextFireAt: number | null; nextFireReason: DashboardState['nextFireReason']; schedulerActive: boolean }): DashboardState {
  const s = getSettings()
  const counts = wordCounts()
  const q = quotaState()
  const roundsToday =
    get<{ n: number }>("select count(*) n from rounds where status in ('done', 'aborted') and planned_at >= ?", startOfDay(Date.now()))?.n ?? 0
  return {
    nextFireAt: extra.nextFireAt,
    nextFireReason: extra.nextFireReason,
    dueToday: dueCount(),
    mastered: counts.mastered,
    fresh: counts.fresh,
    needMeaning: counts.needMeaning,
    totalWords: counts.total,
    delayUsed: q.used,
    delayQuota: q.quota,
    delayMinutes: s.delayMinutes,
    mode: s.mode,
    lockLevel: s.lockLevel,
    roundsToday,
    wordsToday: wordsRatedToday(),
    recentRounds: recentRounds(5),
    windows: s.windows as TimeWindow[],
    intervalMinutes: s.intervalMinutes,
    schedulerActive: extra.schedulerActive,
  }
}

export { isMastered }
