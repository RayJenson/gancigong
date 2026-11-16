export const ESCAPE_SHORTCUT = 'CommandOrControl+Alt+Escape'

/** 渲染进程 → 主进程 */
export const Invoke = {
  SettingsGetAll: 'settings:get-all',
  SettingsSet: 'settings:set',
  SettingsResetSchedule: 'settings:reset-schedule',

  ListsList: 'lists:list',
  ListsCreate: 'lists:create',
  ListsRename: 'lists:rename',
  ListsDelete: 'lists:delete',

  WordsList: 'words:list',
  WordsCreate: 'words:create',
  WordsUpdate: 'words:update',
  WordsDelete: 'words:delete',
  WordsPickCsv: 'words:pick-csv',
  WordsImport: 'words:import',
  WordsExport: 'words:export',
  WordsOpenDataDir: 'words:open-data-dir',
  DictLookup: 'dict:lookup',

  DashboardState: 'dashboard:state',
  StatsOverview: 'stats:overview',
  FlowStatus: 'flow:status',

  ReviewStartNow: 'review:start-now',
  ReviewPlan: 'review:plan',
  ReviewRate: 'review:rate',
  ReviewFinish: 'review:finish',
  ReviewDelay: 'review:delay',
  ReviewAbort: 'review:abort',
  ReviewCardDone: 'review:card-done',

  KioskStatus: 'kiosk:status',
} as const

/** 主进程 → 渲染进程 */
export const Push = {
  DataChanged: 'data:changed',
  ScheduleChanged: 'schedule:changed',
  RoundAborted: 'review:aborted',
  DelayDenied: 'review:delay-denied',
} as const
