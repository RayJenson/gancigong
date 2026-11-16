import { BrowserWindow } from 'electron'
import { abortRound, consumeDelay, finishRound, getActiveRound, hasActiveRound, openRound, quotaState, rate, type ActiveRound } from './rounds'
import { applyDelay, markOutOfWords, recompute, scheduleStatus } from './scheduler'
import { getSettings } from './settings'
import { closeReviewWindows, currentSessionRound, openReviewWindows, type ReviewWindowHandlers } from './windows'
import { engageKiosk, isKioskEngaged, releaseKiosk, type KioskExit } from './kiosk'
import { escapeShortcutAvailable, escapeShortcutCombo } from './shortcuts'
import { logEvent, run } from './db'
import { Push } from '@shared/ipc'
import type { Rating } from '@shared/types'

interface FinalizeOptions {
  abort?: boolean
  delay?: boolean
  reason: string
}

export function notifyDataChanged(): void {
  const review = new Set(currentReviewWindows().map((w) => w.id))
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || review.has(win.id)) continue
    win.webContents.send(Push.DataChanged)
  }
}

function reviewHandlers(roundId: number): ReviewWindowHandlers {
  return {
    // 关闭意图统一由主进程裁决：温和模式折算成一次「延后」，强制模式不允许关
    onCloseAttempt: (id) => {
      requestDelay(id, 'close_button')
      return false
    },
    onWindowsClosed: (id) => {
      if (getActiveRound(id)) finalize(id, { abort: true, reason: 'windows_closed' })
    },
  }
}

function finalize(roundId: number, options: FinalizeOptions): void {
  if (getActiveRound(roundId)) {
    if (options.abort) abortRound(roundId, options.reason)
    else finishRound(roundId)
  }
  closeReviewWindows()
  if (isKioskEngaged()) releaseKiosk()
  if (options.delay) applyDelay()
  else recompute()
  notifyDataChanged()
}

export function startRound(manual: boolean): { ok: boolean; reason?: string; roundId?: number } {
  if (currentSessionRound() !== null || hasActiveRound()) return { ok: false, reason: 'already_running' }
  const s = getSettings()
  const round = openRound(s.mode, Date.now(), !manual)
  if (!round) {
    if (!manual) markOutOfWords()
    notifyDataChanged()
    return { ok: false, reason: manual ? 'no_words' : 'out_of_words' }
  }
  void launch(round)
  return { ok: true, roundId: round.id }
}

async function launch(round: ActiveRound): Promise<void> {
  try {
    const s = getSettings()
    if (round.mode === 'fullscreen' && !escapeShortcutAvailable()) {
      // 逃生键没注册上（被别的程序占了）就绝不锁桌面，退回温和弹窗
      round.mode = 'gentle'
      run('update rounds set mode = ? where id = ?', 'gentle', round.id)
      logEvent('escape_missing_degraded', { roundId: round.id })
    }
    if (round.mode === 'fullscreen' && round.lockLevel === 'kiosk') {
      const result = await engageKiosk((exit) => onKioskExit(exit, round.id))
      if (!result.ok) {
        round.lockLevel = 'app'
        run('update rounds set lock_level = ? where id = ?', 'app', round.id)
        logEvent('kiosk_failed', { error: result.error ?? '' })
      }
    }
    openReviewWindows(round, reviewHandlers(round.id), s.lockAllDisplays)
    notifyDataChanged()
  } catch (err) {
    logEvent('launch_error', { message: err instanceof Error ? err.message : String(err) })
    finalize(round.id, { abort: true, reason: 'launch_error' })
  }
}

function onKioskExit(exit: KioskExit, roundId: number): void {
  if (exit.reason === 'released') return
  // 钩子自己退了（逃生组合、心跳丢失、超时上限），桌面已经解锁，收尾本轮
  if (getActiveRound(roundId)) finalize(roundId, { abort: true, reason: `kiosk_${exit.reason}` })
}

export function requestDelay(roundId: number, reason: string): { ok: boolean; left: number; minutes: number } {
  const s = getSettings()
  const after = consumeDelay(roundId, reason)
  if (!after) {
    const before = quotaState()
    for (const win of currentReviewWindows()) win.webContents.send(Push.DelayDenied, { roundId, used: before.used, quota: before.quota })
    notifyDataChanged()
    return { ok: false, left: 0, minutes: s.delayMinutes }
  }
  finalize(roundId, { delay: true, reason })
  return { ok: true, left: after.left, minutes: s.delayMinutes }
}

function currentReviewWindows(): BrowserWindow[] {
  const id = currentSessionRound()
  if (id === null) return []
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && String(w.webContents.getURL()).includes(`round=${id}`))
}

export function handleEscape(reason: string): void {
  const id = currentSessionRound()
  if (id !== null && getActiveRound(id)) {
    finalize(id, { abort: true, reason })
    return
  }
  if (isKioskEngaged()) releaseKiosk()
  recompute()
  notifyDataChanged()
}

export function rateCard(roundId: number, wordId: number, rating: Rating): { nextDueAt: number; intervalDays: number } | null {
  if (!getActiveRound(roundId)) return null
  const result = rate(roundId, wordId, rating)
  notifyDataChanged()
  return result
}

export function completeRound(roundId: number): void {
  finalize(roundId, { reason: 'completed' })
}

export function abortFromRenderer(roundId: number): void {
  finalize(roundId, { abort: true, reason: 'renderer_abort' })
}

export function flowStatus() {
  const s = scheduleStatus()
  return {
    nextFireAt: s.nextFireAt,
    reason: s.reason,
    schedulerActive: s.active,
    sessionRoundId: currentSessionRound(),
    kioskEngaged: isKioskEngaged(),
    escapeShortcutReady: escapeShortcutAvailable(),
    escapeShortcutCombo: escapeShortcutCombo(),
    delay: quotaState(),
  }
}
