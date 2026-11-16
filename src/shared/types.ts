export type ReviewMode = 'gentle' | 'fullscreen'
/** auto = 新词默写、复习过的选义；spell = 固定默写；choice = 固定看词选义 */
export type PracticeMode = 'auto' | 'spell' | 'choice'
export type LockLevel = 'app' | 'kiosk'
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
  mode: ReviewMode
  practiceMode: PracticeMode
  lockLevel: LockLevel
  lockAllDisplays: boolean
  delayQuotaPerDay: number
  delayMinutes: number
  ttsEnabled: boolean
  autostart: boolean
  activeListId: number | null
}

export const DEFAULT_SETTINGS: Settings = {
  windows: [{ id: 'w1', start: '09:00', end: '21:30' }],
  intervalMinutes: 20,
  wordsPerRound: 10,
  mode: 'gentle',
  practiceMode: 'auto',
  lockLevel: 'app',
  lockAllDisplays: true,
  delayQuotaPerDay: 3,
  delayMinutes: 10,
  ttsEnabled: true,
  autostart: false,
  activeListId: null,
}

export interface WordRow {
  id: number
  listId: number
  term: string
  phonetic: string
  meaning: string
  example: string
  tags: string
  needMeaning: number
  createdAt: number
  intervalDays?: number
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

export interface DashboardState {
  nextFireAt: number | null
  nextFireReason: 'scheduled' | 'delayed' | 'out_of_words' | 'paused' | 'idle'
  dueToday: number
  mastered: number
  fresh: number
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
}

export interface WordInput {
  term: string
  phonetic?: string
  meaning?: string
  example?: string
  tags?: string
}

export interface WordQuery {
  listId?: number | null
  query?: string
  needMeaningOnly?: boolean
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
  topLapses: { term: string; meaning: string; lapses: number; reps: number; intervalDays: number }[]
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

  listsList(): Promise<ListInfo[]>
  listsCreate(name: string, remark?: string): Promise<number>
  listsRename(id: number, name: string, remark?: string): Promise<boolean>
  listsDelete(id: number): Promise<number>

  wordsList(query: WordQuery): Promise<{ rows: WordRow[]; total: number }>
  wordsCreate(listId: number, input: WordInput): Promise<UpsertResult>
  wordsUpdate(id: number, input: WordInput): Promise<WordRow>
  wordsDelete(ids: number[]): Promise<number>
  wordsPickCsv(): Promise<CsvPick | null>
  wordsImport(path: string, listId: number | null): Promise<ImportResult>
  wordsExport(listId: number | null): Promise<ExportResult | null>
  openDataDir(): Promise<string>
  dictLookup(term: string): Promise<LookupHit | null>

  dashboardState(): Promise<DashboardState>
  statsOverview(): Promise<StatsOverview>
  flowStatus(): Promise<FlowStatus>

  reviewStartNow(): Promise<{ ok: boolean; reason?: string; roundId?: number }>
  reviewPlan(roundId: number): Promise<RoundPlan | null>
  reviewRate(roundId: number, wordId: number, rating: Rating): Promise<{ nextDueAt: number; intervalDays: number } | null>
  reviewFinish(roundId: number): Promise<boolean>
  reviewDelay(roundId: number, reason: string): Promise<DelayResult>
  reviewAbort(roundId: number): Promise<boolean>

  kioskStatus(): Promise<{ engaged: boolean; pid: number | null }>

  onDataChanged(cb: () => void): () => void
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
  reason: 'scheduled' | 'delayed' | 'out_of_words' | 'paused' | 'idle'
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
