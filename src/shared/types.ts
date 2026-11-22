export type ReviewMode = 'gentle' | 'fullscreen'
/** auto = 新词默写、复习过的选义；spell = 固定默写；choice = 固定看词选义 */
export type PracticeMode = 'auto' | 'spell' | 'choice'
export type LockLevel = 'app' | 'kiosk'
/** light = 亮色；dark = 暗色；system = 跟随系统 */
export type ThemeMode = 'light' | 'dark' | 'system'
/** 主题色色板：松柏绿 / 海岛蓝 / 樱花粉 / 暮山紫 / 琥珀橙 / 烟墨灰 */
export type ThemeAccent = 'pine' | 'ocean' | 'sakura' | 'violet' | 'amber' | 'slate'
/** 打字练习取词范围：全部 / 今日要复习 / 今日新学 / 已经学过 / 打错过 */
export type PracticeScope = 'all' | 'dueToday' | 'learnedToday' | 'learned' | 'wrong'
/** 练习巩固取词范围：今日已学回顾 / 错词回顾 / 复习中单词 */
export type ReinforceScope = 'studiedToday' | 'wrongReview' | 'reviewing'
/** 0 = 不认识，1 = 认识 */
export type Rating = 0 | 1
export type RoundStatus = 'open' | 'done' | 'aborted' | 'skipped' | 'empty'

export interface TimeWindow {
  id: string
  start: string
  end: string
}

export interface Settings {
  windows: TimeWindow[]
  intervalMinutes: number
  wordsPerRound: number
  dailyNewWords: number
  mode: ReviewMode
  practiceMode: PracticeMode
  lockLevel: LockLevel
  lockAllDisplays: boolean
  delayQuotaPerDay: number
  delayMinutes: number
  ttsEnabled: boolean
  autostart: boolean
  activeListId: number | null
  themeMode: ThemeMode
  themeAccent: ThemeAccent
  /** 自定义背景文件名（存于数据目录 theme/），空串表示无 */
  themeBackground: string
  /** 背景可见强度 0–100 */
  themeScrim: number
  /** 桌面悬浮球常驻开关 */
  floatBall: boolean
  /** 悬浮球上次的位置（逻辑像素），null = 默认位置 */
  floatX: number | null
  floatY: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  windows: [{ id: 'w1', start: '09:00', end: '21:30' }],
  intervalMinutes: 20,
  wordsPerRound: 10,
  dailyNewWords: 10,
  mode: 'gentle',
  practiceMode: 'auto',
  lockLevel: 'app',
  lockAllDisplays: true,
  delayQuotaPerDay: 3,
  delayMinutes: 10,
  ttsEnabled: true,
  autostart: false,
  activeListId: null,
  themeMode: 'system',
  themeAccent: 'pine',
  themeBackground: '',
  themeScrim: 60,
  floatBall: true,
  floatX: null,
  floatY: null,
}

export interface ThemeState {
  mode: ThemeMode
  accent: ThemeAccent
  /** 背景图 data URL，没有自定义背景时为 null */
  backgroundUrl: string | null
  scrim: number
}

export interface WordRow {
  id: number
  listId: number
  unitId: number | null
  unitName: string
  term: string
  phonetic: string
  meaning: string
  example: string
  tags: string
  needMeaning: number
  createdAt: number
  intervalDays?: number
  /** 艾宾浩斯复习间隔（分钟），比 intervalDays 更细 */
  intervalMinutes?: number
  dueAt?: number | null
  reps?: number
  lapses?: number
  lastRating?: number | null
}

/** spell = 看中文默写；choice = 看英文选释义；reveal = 翻牌（缺释义时的兜底） */
export type CardMode = 'spell' | 'choice' | 'reveal'

export interface CardData {
  wordId: number
  term: string
  phonetic: string
  meaning: string
  example: string
  forms: { form: string; label: string }[]
  mode: CardMode
  /** choice 的候选释义（含正确答案），已打乱；其余模式为空数组 */
  options: string[]
}

export interface RoundPlan {
  roundId: number
  mode: ReviewMode
  lockLevel: LockLevel
  ttsEnabled: boolean
  delayQuotaLeft: number
  cards: CardData[]
}

export interface WrongWord {
  wordId: number
  term: string
  phonetic: string
  meaning: string
}

/** 永久错词本条目：只有用户手动移出才会消失 */
export interface WrongBookEntry {
  wordId: number
  term: string
  phonetic: string
  meaning: string
  lastWrongAt: number
}

export interface WrongBookCounts {
  today: number
  total: number
}

/** 背单词一大轮：最多 10 个新词，cards 都带 ABCD 选项 */
export interface LearnRound {
  cards: CardData[]
  wrongToday: WrongWord[]
}

export interface LearnEntry {
  wordId: number
  rating: Rating
}

export interface LearnFinish {
  rated: number
  known: number
  wrongToday: WrongWord[]
}

export interface DashboardState {
  nextFireAt: number | null
  /** nextFireAt 被设定的时刻，用于计算下一轮进度；null = 当前无排程 */
  scheduleSetAt: number | null
  nextFireReason: 'scheduled' | 'delayed' | 'out_of_words' | 'no_due' | 'paused' | 'learning' | 'idle'
  activeListId: number | null
  activeListName: string
  dueToday: number
  dueTomorrow: number
  dueAfterTomorrow: number
  reviewDue: number
  mastered: number
  fresh: number
  /** 每日新词目标 */
  dailyNewWords: number
  /** 今天已经学会的新词数 */
  newToday: number
  needMeaning: number
  totalWords: number
  delayUsed: number
  delayQuota: number
  delayMinutes: number
  mode: ReviewMode
  lockLevel: LockLevel
  roundsToday: number
  wordsToday: number
  recentRounds: RoundSummary[]
  windows: TimeWindow[]
  intervalMinutes: number
  schedulerActive: boolean
  /** 今日答错过的词（错词本里今天有记录） */
  wrongToday: number
  /** 错词本里的全部错词 */
  wrongTotal: number
}

export interface DictEntry {
  w: string
  p: string
  m: string
  f: { form: string; label: string }[]
  t: string[]
}

export interface ListInfo {
  id: number
  name: string
  remark: string
  wordCount: number
  dueCount: number
  unitCount: number
}

/** 词表下的可选单元；词表可以完全没有单元 */
export interface UnitInfo {
  id: number
  listId: number
  name: string
  position: number
  wordCount: number
  dueCount: number
}

export interface WordInput {
  term: string
  phonetic?: string
  meaning?: string
  example?: string
  tags?: string
  /** 不传 = 不改；0 = 移出单元；>0 = 归入单元 */
  unitId?: number | null
}

export interface WordQuery {
  listId?: number | null
  /** 0 = 只看未分单元的单词 */
  unitId?: number | null
  query?: string
  needMeaningOnly?: boolean
  /** 取词范围，不传 = 全部单词 */
  scope?: PracticeScope | ReinforceScope | null
  sort?: 'due' | 'term' | 'lapses' | 'created'
  limit?: number
  offset?: number
}

export interface UpsertResult {
  row: WordRow
  fromDictionary: boolean
}

export interface WordCounts {
  total: number
  mastered: number
  fresh: number
  needMeaning: number
  dueNow: number
}

export interface QuotaState {
  used: number
  quota: number
  left: number
}

export interface DayStat {
  day: string
  words: number
  known: number
  rate: number | null
}

export interface RoundSummary {
  id: number
  plannedAt: number
  mode: string
  planned: number
  rated: number
  status: string
  knowRate: number | null
}

export interface DictionaryStatus {
  loaded: boolean
  count: number
  source: string
  generatedAt: string
  bytes: number
}

export interface SettingsBundle {
  settings: Settings
  dictionary: DictionaryStatus
  dataDir: string
}

export interface StatsOverview {
  counts: WordCounts
  daily: DayStat[]
  topLapses: {
    term: string
    meaning: string
    lapses: number
    reps: number
    intervalDays: number
    intervalMinutes?: number
  }[]
  streak: number
  wordsToday: number
  knowRateToday: number | null
  delay: QuotaState
  roundsDone: number
  nextFireAt: number | null
  settings: { mode: ReviewMode; lockLevel: LockLevel }
}

export interface CsvPick {
  path: string
  name: string
}

export interface ExportResult {
  count: number
  path: string
}

export interface DelayResult {
  ok: boolean
  left: number
  minutes: number
}

/** 桥接给渲染层的 API，preload 实现、renderer 消费 */
export interface GanciApi {
  settingsAll(): Promise<SettingsBundle>
  settingsSet(patch: Partial<Settings>): Promise<Settings>

  themeState(): Promise<ThemeState>
  /** 选择图片 → 复制进数据目录 → 返回 data URL；取消返回 null */
  themeBackgroundPick(): Promise<string | null>
  themeBackgroundClear(): Promise<boolean>

  listsList(): Promise<ListInfo[]>
  listsCreate(name: string, remark?: string): Promise<number>
  listsRename(id: number, name: string, remark?: string): Promise<boolean>
  listsDelete(id: number): Promise<number>

  unitsList(listId?: number | null): Promise<UnitInfo[]>
  unitsCreate(listId: number, name: string): Promise<number>
  unitsRename(id: number, name: string): Promise<boolean>
  unitsDelete(id: number): Promise<number>

  wordsList(query: WordQuery): Promise<{ rows: WordRow[]; total: number }>
  wordsCreate(listId: number, input: WordInput): Promise<UpsertResult>
  wordsUpdate(id: number, input: WordInput): Promise<WordRow>
  wordsDelete(ids: number[]): Promise<number>
  wordsMove(ids: number[], unitId: number | null): Promise<number>
  wordsPickCsv(): Promise<CsvPick | null>
  wordsImport(path: string, listId: number | null, unitId?: number | null): Promise<ImportResult>
  wordsExport(listId: number | null): Promise<ExportResult | null>
  openDataDir(): Promise<string>
  dictLookup(term: string): Promise<LookupHit | null>

  dashboardState(): Promise<DashboardState>
  statsOverview(): Promise<StatsOverview>
  flowStatus(): Promise<FlowStatus>

  /** new = 只背新词；due = 只复习到期词；mixed = 到期→新词→临近到期 */
  reviewStartNow(scope?: 'mixed' | 'new' | 'due'): Promise<{ ok: boolean; reason?: string; roundId?: number }>
  reviewPlan(roundId: number): Promise<RoundPlan | null>
  reviewRate(
    roundId: number,
    wordId: number,
    rating: Rating
  ): Promise<{ nextDueAt: number; intervalDays: number; intervalMinutes?: number } | null>
  reviewFinish(roundId: number): Promise<boolean>
  reviewDelay(roundId: number, reason: string): Promise<DelayResult>
  reviewAbort(roundId: number): Promise<boolean>

  /** 进入学习页时暂停复习提醒 */
  learnPause(): Promise<boolean>
  /** 离开学习页时恢复提醒并重排下一次触发点 */
  learnResume(): Promise<boolean>
  /** new = 取新词；wrong = 取错词本里的词 */
  /** extra = 今日目标已完成后又主动加练一批 */
  learnStart(scope?: 'new' | 'wrong', extra?: boolean): Promise<LearnRound>
  learnWrongList(): Promise<WrongWord[]>
  /** 返回错词本里今日答错的词数 */
  learnWrongMark(wordId: number): Promise<number>
  /** 答对不再自动移出错词本，只有手动移出才删除 */
  learnFinish(startedAt: number, entries: LearnEntry[], scope?: 'new' | 'wrong'): Promise<LearnFinish>

  /** 错词本列表：scope = today | all */
  wrongsList(scope: 'today' | 'all'): Promise<WrongBookEntry[]>
  wrongsCounts(): Promise<WrongBookCounts>
  /** 手动把词移出错词本，返回删除条数 */
  wrongsRemove(wordIds: number[]): Promise<number>

  /** 读取中断的学习快照，没有则返回 null */
  learnProgressGet(scope: 'new' | 'wrong'): Promise<string | null>
  learnProgressSave(scope: 'new' | 'wrong', payload: string): Promise<boolean>
  learnProgressClear(scope: 'new' | 'wrong'): Promise<boolean>

  kioskStatus(): Promise<{ engaged: boolean; pid: number | null }>

  /** 悬浮球：打开/收起快捷菜单（菜单是独立置顶窗口） */
  floatMenuToggle(): Promise<void>
  floatMenuClose(): Promise<void>
  /** 显示主窗口并跳到指定路由（以 / 开头） */
  openMain(path?: string): Promise<void>

  onDataChanged(cb: () => void): () => void
  onNavigate(cb: (path: string) => void): () => void
  onScheduleChanged(cb: (status: FlowStatus) => void): () => void
  onDelayDenied(cb: (payload: { roundId: number; used: number; quota: number }) => void): () => void
}

export interface LookupHit {
  term: string
  phonetic: string
  meaning: string
  tags: string[]
  forms: { form: string; label: string }[]
  matchedVia?: string
}

export interface FlowStatus {
  nextFireAt: number | null
  /** nextFireAt 被设定的时刻，用于计算下一轮进度；null = 当前无排程 */
  scheduleSetAt: number | null
  reason: 'scheduled' | 'delayed' | 'out_of_words' | 'no_due' | 'paused' | 'learning' | 'idle'
  schedulerActive: boolean
  sessionRoundId: number | null
  kioskEngaged: boolean
  escapeShortcutReady: boolean
  escapeShortcutCombo: string
  delay: QuotaState
}

export interface ImportResult {
  created: number
  updated: number
  skipped: number
  filledFromDict: number
  missingMeaning: number
  totalRows: number
  errors: string[]
  fileName: string
}
