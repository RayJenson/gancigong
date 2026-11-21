/**
 * Tauri 桥接：把 GanciApi 映射到 Rust 侧的 invoke 命令与事件。
 * Electron preload 注入了 window.ganci 时不会加载本文件。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
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

function subscribe<T>(event: string, cb: (payload: T) => void): () => void {
  const pending = listen<T>(event, (e) => cb(e.payload))
  return () => {
    void pending.then((unlisten) => unlisten())
  }
}

const api: GanciApi = {
  settingsAll: () => invoke<SettingsBundle>('settings_all'),
  settingsSet: (patch: Partial<Settings>) => invoke<Settings>('settings_set', { patch }),

  themeState: () => invoke<ThemeState>('theme_state'),
  themeBackgroundPick: () => invoke<string | null>('theme_background_pick'),
  themeBackgroundClear: () => invoke<boolean>('theme_background_clear'),

  listsList: () => invoke<ListInfo[]>('lists_list'),
  listsCreate: (name: string, remark?: string) => invoke<number>('lists_create', { name, remark: remark ?? '' }),
  listsRename: (id: number, name: string, remark?: string) =>
    invoke<boolean>('lists_rename', { id, name, remark }),
  listsDelete: (id: number) => invoke<number>('lists_delete', { id }),

  unitsList: (listId?: number | null) => invoke<UnitInfo[]>('units_list', { listId: listId ?? null }),
  unitsCreate: (listId: number, name: string) => invoke<number>('units_create', { listId, name }),
  unitsRename: (id: number, name: string) => invoke<boolean>('units_rename', { id, name }),
  unitsDelete: (id: number) => invoke<number>('units_delete', { id }),

  wordsList: (query: WordQuery) => invoke<{ rows: WordRow[]; total: number }>('words_list', { query }),
  wordsCreate: (listId: number, input: WordInput) =>
    invoke<UpsertResult>('words_create', { listId, input }),
  wordsUpdate: (id: number, input: WordInput) => invoke<WordRow>('words_update', { id, input }),
  wordsDelete: (ids: number[]) => invoke<number>('words_delete', { ids }),
  wordsMove: (ids: number[], unitId: number | null) => invoke<number>('words_move', { ids, unitId }),
  wordsPickCsv: () => invoke<CsvPick | null>('words_pick_csv'),
  wordsImport: (path: string, listId: number | null, unitId?: number | null) =>
    invoke<ImportResult>('words_import', { path, listId, unitId: unitId ?? null }),
  wordsExport: (listId: number | null) => invoke<ExportResult | null>('words_export', { listId }),
  openDataDir: () => invoke<string>('open_data_dir'),
  dictLookup: (term: string) => invoke<LookupHit | null>('dict_lookup', { term }),

  dashboardState: () => invoke<DashboardState>('dashboard_state'),
  statsOverview: () => invoke<StatsOverview>('stats_overview'),
  flowStatus: () => invoke<FlowStatus>('flow_status'),

  reviewStartNow: (scope?: 'mixed' | 'new' | 'due') =>
    invoke<{ ok: boolean; reason?: string; roundId?: number }>('review_start_now', { scope: scope ?? null }),
  reviewPlan: (roundId: number) => invoke<RoundPlan | null>('review_plan', { roundId }),
  reviewRate: (roundId: number, wordId: number, rating: Rating) =>
    invoke<{ nextDueAt: number; intervalDays: number } | null>('review_rate', { roundId, wordId, rating }),
  reviewFinish: (roundId: number) => invoke<boolean>('review_finish', { roundId }),
  reviewDelay: (roundId: number, reason: string) => invoke<DelayResult>('review_delay', { roundId, reason }),
  reviewAbort: (roundId: number) => invoke<boolean>('review_abort', { roundId }),

  learnPause: () => invoke<boolean>('learn_pause'),
  learnResume: () => invoke<boolean>('learn_resume'),
  learnStart: (scope?: 'new' | 'wrong', extra?: boolean) =>
    invoke<LearnRound>('learn_start', { scope: scope ?? null, extra: extra ?? false }),
  learnWrongList: () => invoke<WrongWord[]>('learn_wrong_list'),
  learnWrongMark: (wordId: number) => invoke<number>('learn_wrong_mark', { wordId }),
  learnFinish: (startedAt: number, entries: LearnEntry[], scope?: 'new' | 'wrong') =>
    invoke<LearnFinish>('learn_finish', { startedAt, entries, scope: scope ?? null }),

  learnProgressGet: (scope: 'new' | 'wrong') => invoke<string | null>('learn_progress_get', { scope }),
  learnProgressSave: (scope: 'new' | 'wrong', payload: string) =>
    invoke<boolean>('learn_progress_save', { scope, payload }),
  learnProgressClear: (scope: 'new' | 'wrong') => invoke<boolean>('learn_progress_clear', { scope }),

  wrongsList: (scope: 'today' | 'all') => invoke<WrongBookEntry[]>('wrongs_list', { scope }),
  wrongsCounts: () => invoke<WrongBookCounts>('wrongs_counts'),
  wrongsRemove: (wordIds: number[]) => invoke<number>('wrongs_remove', { wordIds }),

  kioskStatus: () => invoke<{ engaged: boolean; pid: number | null }>('kiosk_status'),

  floatMenuToggle: () => invoke<void>('float_menu_toggle'),
  floatMenuClose: () => invoke<void>('float_menu_close'),
  openMain: (path?: string) => invoke<void>('open_main', { path: path ?? null }),

  onDataChanged: (cb: () => void) => subscribe<void>('data:changed', () => cb()),
  onNavigate: (cb: (path: string) => void) => subscribe<string>('app:navigate', cb),
  onScheduleChanged: (cb: (status: FlowStatus) => void) => subscribe<FlowStatus>('schedule:changed', cb),
  onDelayDenied: (cb: (payload: { roundId: number; used: number; quota: number }) => void) =>
    subscribe<{ roundId: number; used: number; quota: number }>('review:delay-denied', cb),
}

if (!window.ganci) window.ganci = api
