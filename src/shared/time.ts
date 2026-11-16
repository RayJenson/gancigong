import type { TimeWindow } from './types'

const DAY_MS = 86_400_000

export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

export function toHHMM(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 有效时段：start < end，其余按非法丢弃 */
export function validWindows(windows: TimeWindow[]): { start: number; end: number }[] {
  return windows
    .map((w) => ({ start: parseHHMM(w.start), end: parseHHMM(w.end) }))
    .filter((w): w is { start: number; end: number } => w.start !== null && w.end !== null && w.end > w.start)
    .sort((a, b) => a.start - b.start)
}

export function inAnyWindow(ts: number, windows: TimeWindow[]): boolean {
  const mins = (ts - startOfDay(ts)) / 60_000
  return validWindows(windows).some((w) => mins >= w.start && mins <= w.end)
}

/**
 * 从 from 起（含）往后找第一个落在时段网格上的触发点。
 * 网格以每个时段的起始时刻为基准，按 intervalMinutes 步进。
 */
export function nextGridPoint(
  from: number,
  windows: TimeWindow[],
  intervalMinutes: number
): number | null {
  const valid = validWindows(windows)
  const step = Math.max(1, Math.round(intervalMinutes)) * 60_000
  const floor = Math.max(from, startOfDay(from))
  for (let dayOffset = 0; dayOffset < 400; dayOffset++) {
    const dayStart = startOfDay(from) + dayOffset * DAY_MS
    if (dayStart > floor + 400 * DAY_MS) break
    for (const w of valid) {
      const openAt = dayStart + w.start * 60_000
      const closeAt = dayStart + w.end * 60_000
      for (let t = openAt; t <= closeAt; t += step) {
        if (t >= floor) return t
      }
    }
  }
  return null
}

/** 把推迟后的时间点钳回时段内：时段内原样返回，否则取下一个时段网格点 */
export function clampIntoWindow(ts: number, windows: TimeWindow[], intervalMinutes: number): number | null {
  if (inAnyWindow(ts, windows)) return ts
  return nextGridPoint(ts + 1, windows, intervalMinutes)
}

export function formatCountdown(target: number | null, now: number): string {
  if (target === null) return '暂无排程'
  const diff = target - now
  if (diff <= 0) return '现在'
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return `${Math.max(0, Math.floor(diff / 1000))} 秒后`
  if (mins < 60) return `${mins} 分钟后`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时 ${mins % 60} 分后`
  return `${Math.floor(hours / 24)} 天后`
}

/** 到期时间的友好表达：今天 HH:mm / 明天 HH:mm / N 天前 · YYYY-MM-DD */
export function formatDue(dueAt: number | null | undefined, now: number): string {
  if (!dueAt) return '新词'
  const days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY_MS)
  if (days < 0) return `已到期 ${Math.abs(days)} 天`
  if (days === 0) return `今天 ${toHHMM(dueAt)}`
  if (days === 1) return `明天 ${toHHMM(dueAt)}`
  if (days < 8) return `${days} 天后`
  return dayKey(dueAt)
}
