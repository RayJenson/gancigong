import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { basename } from 'node:path'
import { applyAutostart } from './autostart'
import { get, logEvent } from './db'
import { dictionaryStatus, lookup } from './dictionary'
import { exportCsv, importCsvFile } from './importer'
import { kioskPid, isKioskEngaged } from './kiosk'
import {
  abortFromRenderer,
  completeRound,
  flowStatus,
  rateCard,
  requestDelay,
  startRound,
} from './flow'
import {
  buildDashboard,
  dailySeries,
  getActiveRound,
  quotaState,
  streakDays,
  todayKnowRate,
  topLapses,
  wordsRatedToday,
} from './rounds'
import { setSettings, getSettings } from './settings'
import { recompute, syncWordAvailability } from './scheduler'
import {
  createList,
  createWord,
  deleteList,
  deleteWords,
  ensureDefaultList,
  listLists,
  listWords,
  renameList,
  updateWord,
  wordCounts,
} from './words'
import { Invoke, Push } from '@shared/ipc'
import type { Rating, Settings, WordInput, WordQuery } from '@shared/types'

type Handler = (...args: unknown[]) => unknown

function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logEvent('ipc_error', { channel, message })
      return { ok: false, error: message }
    }
  })
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

export function registerIpc(getMainWindow: () => BrowserWindow | null): void {
  handle(Invoke.SettingsGetAll, () => ({
    settings: getSettings(),
    dictionary: dictionaryStatus(),
    dataDir: app.getPath('userData'),
  }))

  handle(Invoke.SettingsSet, (patch) => {
    const before = getSettings()
    const next = setSettings(patch as Partial<Settings>)
    if (next.autostart !== before.autostart) applyAutostart(next.autostart)
    const scheduleChanged =
      JSON.stringify(next.windows) !== JSON.stringify(before.windows) ||
      next.intervalMinutes !== before.intervalMinutes ||
      next.activeListId !== before.activeListId
    if (scheduleChanged) recompute()
    logEvent('settings_changed', { before, after: next })
    broadcast(Push.ScheduleChanged, flowStatus())
    broadcast(Push.DataChanged)
    return next
  })

  handle(Invoke.ListsList, () => listLists())
  handle(Invoke.ListsCreate, (name, remark) => createList(String(name ?? ''), String(remark ?? '')))
  handle(Invoke.ListsRename, (id, name, remark) => {
    renameList(Number(id), String(name), remark === undefined ? undefined : String(remark))
    broadcast(Push.DataChanged)
    return true
  })
  handle(Invoke.ListsDelete, (id) => {
    const removed = deleteList(Number(id))
    const s = getSettings()
    if (s.activeListId === Number(id)) setSettings({ activeListId: null })
    syncWordAvailability()
    broadcast(Push.DataChanged)
    return removed
  })

  handle(Invoke.WordsList, (query) => listWords((query ?? {}) as WordQuery))
  handle(Invoke.WordsCreate, (listId, input) => {
    const target = Number(listId) || ensureDefaultList()
    const result = createWord(target, input as WordInput)
    syncWordAvailability()
    broadcast(Push.DataChanged)
    return result
  })
  handle(Invoke.WordsUpdate, (id, input) => {
    const row = updateWord(Number(id), input as WordInput)
    broadcast(Push.DataChanged)
    return row
  })
  handle(Invoke.WordsDelete, (ids) => {
    const n = deleteWords(((ids ?? []) as number[]).map(Number))
    syncWordAvailability()
    broadcast(Push.DataChanged)
    return n
  })

  handle(Invoke.WordsPickCsv, () => dialog.showOpenDialog({
    title: '选择词表 CSV',
    properties: ['openFile'],
    filters: [{ name: 'CSV / TSV / TXT 词表', extensions: ['csv', 'tsv', 'txt'] }],
  }).then((result) => {
    if (result.canceled || !result.filePaths.length) return null
    return { path: result.filePaths[0], name: basename(result.filePaths[0]) }
  }))

  handle(Invoke.WordsImport, (filePath, listId) => {
    const result = importCsvFile(String(filePath), listId === null || listId === undefined ? null : Number(listId))
    syncWordAvailability()
    broadcast(Push.DataChanged)
    return result
  })

  handle(Invoke.WordsExport, async (listId) => {
    const listName = listId
      ? get<{ name: string }>('select name from lists where id = ?', Number(listId))?.name
      : null
    const choice = await dialog.showSaveDialog({
      title: '导出词表',
      defaultPath: `${listName ?? '赶词工词库'}.csv`,
      filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
    })
    if (choice.canceled || !choice.filePath) return null
    const count = exportCsv(listId === null || listId === undefined ? null : Number(listId), choice.filePath)
    return { count, path: choice.filePath }
  })

  handle(Invoke.WordsOpenDataDir, () => shell.openPath(app.getPath('userData')))
  handle(Invoke.DictLookup, (term) => lookup(String(term ?? '')))

  handle(Invoke.DashboardState, () => {
    const status = flowStatus()
    return buildDashboard({
      nextFireAt: status.nextFireAt,
      nextFireReason: status.reason,
      schedulerActive: status.schedulerActive,
    })
  })

  handle(Invoke.StatsOverview, () => {
    const status = flowStatus()
    return {
      counts: wordCounts(),
      daily: dailySeries(14),
      topLapses: topLapses(20),
      streak: streakDays(),
      wordsToday: wordsRatedToday(),
      knowRateToday: todayKnowRate(),
      delay: quotaState(),
      roundsDone: get<{ n: number }>("select count(*) n from rounds where status = 'done'")?.n ?? 0,
      nextFireAt: status.nextFireAt,
      settings: { mode: getSettings().mode, lockLevel: getSettings().lockLevel },
    }
  })

  handle(Invoke.ReviewStartNow, () => startRound(true))

  handle(Invoke.ReviewPlan, (roundId) => {
    const round = getActiveRound(Number(roundId))
    if (!round) return null
    return {
      roundId: round.id,
      mode: round.mode,
      lockLevel: round.lockLevel,
      ttsEnabled: round.ttsEnabled,
      delayQuotaLeft: quotaState().left,
      cards: round.cards,
    }
  })

  handle(Invoke.ReviewRate, (roundId, wordId, rating) => rateCard(Number(roundId), Number(wordId), Number(rating) as Rating))
  handle(Invoke.ReviewFinish, (roundId) => {
    completeRound(Number(roundId))
    return true
  })
  handle(Invoke.ReviewDelay, (roundId, reason) => requestDelay(Number(roundId), String(reason ?? 'button')))
  handle(Invoke.ReviewAbort, (roundId) => {
    abortFromRenderer(Number(roundId))
    return true
  })

  handle(Invoke.FlowStatus, () => flowStatus())

  handle(Invoke.KioskStatus, () => ({ engaged: isKioskEngaged(), pid: kioskPid() }))
}
