export const ESCAPE_SHORTCUT = 'CommandOrControl+Alt+Escape'

/** 渲染进程 → 主进程 */
export const Invoke = {
  SettingsGetAll: 'settings:get-all',
  SettingsSet: 'settings:set',
  SettingsResetSchedule: 'settings:reset-schedule',

  ThemeState: 'theme:state',
  ThemePickBackground: 'theme:pick-background',
  ThemeClearBackground: 'theme:clear-background',

  ListsList: 'lists:list',
  ListsCreate: 'lists:create',
  ListsRename: 'lists:rename',
  ListsDelete: 'lists:delete',

  UnitsList: 'units:list',
  UnitsCreate: 'units:create',
  UnitsRename: 'units:rename',
  UnitsDelete: 'units:delete',

  WordsList: 'words:list',
  WordsCreate: 'words:create',
  WordsUpdate: 'words:update',
  WordsDelete: 'words:delete',
  WordsMove: 'words:move',
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

  LearnPause: 'learn:pause',
  LearnResume: 'learn:resume',
  LearnStart: 'learn:start',
  LearnWrongList: 'learn:wrong-list',
  LearnWrongMark: 'learn:wrong-mark',
  LearnFinish: 'learn:finish',
  LearnProgressGet: 'learn:progress-get',
  LearnProgressSave: 'learn:progress-save',
  LearnProgressClear: 'learn:progress-clear',

  WrongsList: 'wrongs:list',
  WrongsCounts: 'wrongs:counts',
  WrongsRemove: 'wrongs:remove',

  KioskStatus: 'kiosk:status',

  FloatMenuToggle: 'float:menu-toggle',
  FloatMenuClose: 'float:menu-close',
  OpenMain: 'app:open-main',
} as const

/** 主进程 → 渲染进程 */
export const Push = {
  DataChanged: 'data:changed',
  ScheduleChanged: 'schedule:changed',
  RoundAborted: 'review:aborted',
  DelayDenied: 'review:delay-denied',
  Navigate: 'app:navigate',
} as const
