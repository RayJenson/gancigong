import { getSettings } from './settings'
import { wordCounts } from './words'
import { clampIntoWindow, nextGridPoint } from '@shared/time'

export type FireReason = 'scheduled' | 'delayed' | 'out_of_words' | 'paused' | 'idle'

let timer: NodeJS.Timeout | null = null
let nextFireAt: number | null = null
let setAt: number | null = null
let reason: FireReason = 'idle'
let onFire: ((at: number) => void) | null = null
let busy: (() => boolean) | null = null

function assign(next: number | null): void {
  if (next !== nextFireAt) setAt = next === null ? null : Date.now()
  nextFireAt = next
}

export function startScheduler(fire: (at: number) => void, isBusy: () => boolean): void {
  onFire = fire
  busy = isBusy
  if (!timer) timer = setInterval(tick, 1000)
  recompute()
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  onFire = null
  busy = null
}

/** 配置变化后重算下一次触发点 */
export function recompute(notAfter?: number): void {
  const s = getSettings()
  // 一本词都没有就别预告倒计时，等录入第一批词后由 syncWordAvailability 接回网格
  if (wordCounts().total === 0) {
    markOutOfWords()
    return
  }
  if (!s.windows.length) {
    assign(null)
    reason = 'paused'
    return
  }
  const from = Math.max(Date.now(), notAfter ?? 0)
  const point = nextGridPoint(from + 1000, s.windows, s.intervalMinutes)
  assign(point)
  reason = point === null ? 'paused' : 'scheduled'
}

/** 延后：下一次触发点挪到 now + delayMinutes，落在时段外则钳回时段 */
export function applyDelay(): { at: number | null } {
  const s = getSettings()
  const target = Date.now() + s.delayMinutes * 60_000
  const clamped = clampIntoWindow(target, s.windows, s.intervalMinutes)
  assign(clamped)
  reason = clamped === null ? 'paused' : 'delayed'
  return { at: clamped }
}

/** 词库空到抽不出任何词：停掉排程，直到有词录入再恢复 */
export function markOutOfWords(): void {
  assign(null)
  reason = 'out_of_words'
}

/** 因「暂无词」停摆后重新接上网格；已经在跑的排程不动，避免覆盖延后的时间点 */
function resumeIfPaused(): void {
  if (nextFireAt === null && reason === 'out_of_words') recompute()
}

/** 词数变了（录入/导入/删词/删词表）之后对齐排程，否则面板会一直预告一个抽不出词的倒计时 */
export function syncWordAvailability(): void {
  if (wordCounts().total === 0) {
    // 时段本身没配时「已暂停」更重要，别用「没词」盖掉它
    if (reason !== 'paused') markOutOfWords()
  } else {
    resumeIfPaused()
  }
}

export function scheduleStatus(): {
  nextFireAt: number | null
  setAt: number | null
  reason: FireReason
  active: boolean
} {
  return { nextFireAt, setAt, reason, active: timer !== null }
}

function tick(): void {
  if (nextFireAt === null || !onFire) return
  if (Date.now() < nextFireAt) return
  if (busy?.()) return
  const at = nextFireAt
  // 先把排程接回网格，再触发；本轮若抽不出词会由 markOutOfWords 停摆，不会被这里覆盖
  recomputeFrom(at)
  onFire(at)
}

function recomputeFrom(at: number): void {
  const s = getSettings()
  const point = nextGridPoint(at + 1000, s.windows, s.intervalMinutes)
  if (point && point > Date.now()) {
    assign(point)
    reason = 'scheduled'
  } else {
    recompute()
  }
}
