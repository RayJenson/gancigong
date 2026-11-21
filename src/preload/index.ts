import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { Invoke, Push } from '@shared/ipc'
import type {
  CsvPick,
  DashboardState,
  DelayResult,
  ExportResult,
  FlowStatus,
  GanciApi,
  ImportResult,
  LearnEntry,
  LearnFinish,
  LearnRound,
  ListInfo,
  LookupHit,
  Rating,
  RoundPlan,
  Settings,
  SettingsBundle,
  StatsOverview,
  ThemeState,
  UnitInfo,
  UpsertResult,
  WordInput,
  WordQuery,
  WordRow,
  WrongBookCounts,
  WrongBookEntry,
  WrongWord,
} from '@shared/types'

type Envelope<T> = { ok: true; data: T } | { ok: false; error: string }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T> | undefined
  if (res && res.ok) return res.data
  throw new Error(res && !res.ok ? res.error : '主进程没有响应')
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

const api: GanciApi = {
  settingsAll: () => call<SettingsBundle>(Invoke.SettingsGetAll),
  settingsSet: (patch: Partial<Settings>) => call<Settings>(Invoke.SettingsSet, patch),

  themeState: () => call<ThemeState>(Invoke.ThemeState),
  themeBackgroundPick: () => call<string | null>(Invoke.ThemePickBackground),
  themeBackgroundClear: () => call<boolean>(Invoke.ThemeClearBackground),

  listsList: () => call<ListInfo[]>(Invoke.ListsList),
  listsCreate: (name: string, remark?: string) => call<number>(Invoke.ListsCreate, name, remark ?? ''),
  listsRename: (id: number, name: string, remark?: string) => call<boolean>(Invoke.ListsRename, id, name, remark),
  listsDelete: (id: number) => call<number>(Invoke.ListsDelete, id),

  unitsList: (listId?: number | null) => call<UnitInfo[]>(Invoke.UnitsList, listId ?? null),
  unitsCreate: (listId: number, name: string) => call<number>(Invoke.UnitsCreate, listId, name),
  unitsRename: (id: number, name: string) => call<boolean>(Invoke.UnitsRename, id, name),
  unitsDelete: (id: number) => call<number>(Invoke.UnitsDelete, id),

  wordsList: (query: WordQuery) => call<{ rows: WordRow[]; total: number }>(Invoke.WordsList, query),
  wordsCreate: (listId: number, input: WordInput) => call<UpsertResult>(Invoke.WordsCreate, listId, input),
  wordsUpdate: (id: number, input: WordInput) => call<WordRow>(Invoke.WordsUpdate, id, input),
  wordsDelete: (ids: number[]) => call<number>(Invoke.WordsDelete, ids),
  wordsMove: (ids: number[], unitId: number | null) => call<number>(Invoke.WordsMove, ids, unitId),
  wordsPickCsv: () => call<CsvPick | null>(Invoke.WordsPickCsv),
  wordsImport: (path: string, listId: number | null, unitId?: number | null) =>
    call<ImportResult>(Invoke.WordsImport, path, listId, unitId ?? null),
  wordsExport: (listId: number | null) => call<ExportResult | null>(Invoke.WordsExport, listId),
  openDataDir: () => call<string>(Invoke.WordsOpenDataDir),
  dictLookup: (term: string) => call<LookupHit | null>(Invoke.DictLookup, term),

  dashboardState: () => call<DashboardState>(Invoke.DashboardState),
  statsOverview: () => call<StatsOverview>(Invoke.StatsOverview),
  flowStatus: () => call<FlowStatus>(Invoke.FlowStatus),

  reviewStartNow: (scope?: 'mixed' | 'new' | 'due') =>
    call<{ ok: boolean; reason?: string; roundId?: number }>(Invoke.ReviewStartNow, scope ?? null),
  reviewPlan: (roundId: number) => call<RoundPlan | null>(Invoke.ReviewPlan, roundId),
  reviewRate: (roundId: number, wordId: number, rating: Rating) =>
    call<{ nextDueAt: number; intervalDays: number } | null>(Invoke.ReviewRate, roundId, wordId, rating),
  reviewFinish: (roundId: number) => call<boolean>(Invoke.ReviewFinish, roundId),
  reviewDelay: (roundId: number, reason: string) => call<DelayResult>(Invoke.ReviewDelay, roundId, reason),
  reviewAbort: (roundId: number) => call<boolean>(Invoke.ReviewAbort, roundId),

  learnPause: () => call<boolean>(Invoke.LearnPause),
  learnResume: () => call<boolean>(Invoke.LearnResume),
  learnStart: (scope?: 'new' | 'wrong', extra?: boolean) =>
    call<LearnRound>(Invoke.LearnStart, scope ?? null, extra ?? false),
  learnWrongList: () => call<WrongWord[]>(Invoke.LearnWrongList),
  learnWrongMark: (wordId: number) => call<number>(Invoke.LearnWrongMark, wordId),
  learnFinish: (startedAt: number, entries: LearnEntry[], scope?: 'new' | 'wrong') =>
    call<LearnFinish>(Invoke.LearnFinish, startedAt, entries, scope ?? null),

  learnProgressGet: (scope: 'new' | 'wrong') => call<string | null>(Invoke.LearnProgressGet, scope),
  learnProgressSave: (scope: 'new' | 'wrong', payload: string) =>
    call<boolean>(Invoke.LearnProgressSave, scope, payload),
  learnProgressClear: (scope: 'new' | 'wrong') => call<boolean>(Invoke.LearnProgressClear, scope),

  wrongsList: (scope: 'today' | 'all') => call<WrongBookEntry[]>(Invoke.WrongsList, scope),
  wrongsCounts: () => call<WrongBookCounts>(Invoke.WrongsCounts),
  wrongsRemove: (wordIds: number[]) => call<number>(Invoke.WrongsRemove, wordIds),

  kioskStatus: () => call<{ engaged: boolean; pid: number | null }>(Invoke.KioskStatus),

  floatMenuToggle: () => call<void>(Invoke.FloatMenuToggle),
  floatMenuClose: () => call<void>(Invoke.FloatMenuClose),
  openMain: (path?: string) => call<void>(Invoke.OpenMain, path ?? null),

  onDataChanged: (cb: () => void) => subscribe<undefined>(Push.DataChanged, cb),
  onNavigate: (cb: (path: string) => void) => subscribe<string>(Push.Navigate, cb),
  onScheduleChanged: (cb: (status: FlowStatus) => void) => subscribe<FlowStatus>(Push.ScheduleChanged, cb),
  onDelayDenied: (cb: (payload: { roundId: number; used: number; quota: number }) => void) =>
    subscribe<{ roundId: number; used: number; quota: number }>(Push.DelayDenied, cb),
}

contextBridge.exposeInMainWorld('ganci', api)
