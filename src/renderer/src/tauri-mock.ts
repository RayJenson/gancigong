/**
 * Tauri 内存验收用的假数据桥接：仅在缺少 Electron preload 时加载。
 * 不参与真实业务，正式接入 Tauri 时由 invoke 实现替换。
 */
import { DEFAULT_SETTINGS } from '@shared/types'
import type {
  CardData,
  DashboardState,
  DayStat,
  GanciApi,
  ImportResult,
  ListInfo,
  LookupHit,
  RoundPlan,
  Settings,
  SettingsBundle,
  StatsOverview,
  UnitInfo,
  WordRow,
} from '@shared/types'

const now = Date.now()
const day = 86_400_000

const lists: ListInfo[] = [
  { id: 1, name: '四级核心词', remark: '2026 上半年冲刺', wordCount: 186, dueCount: 24, unitCount: 2 },
  { id: 2, name: '考研高频', remark: '阅读真题整理', wordCount: 115, dueCount: 8, unitCount: 0 },
]

const units: UnitInfo[] = [
  { id: 1, listId: 1, name: 'Unit 1 基础', position: 1, wordCount: 120, dueCount: 14 },
  { id: 2, listId: 1, name: 'Unit 2 进阶', position: 2, wordCount: 66, dueCount: 10 },
]

const words: WordRow[] = [
  { id: 1, listId: 1, unitId: 1, unitName: 'Unit 1 基础', term: 'abandon', phonetic: '/əˈbændən/', meaning: 'v. 放弃；抛弃', example: 'He abandoned the plan halfway.', tags: 'cet4', needMeaning: 0, createdAt: now - day * 40, intervalDays: 6, dueAt: now + day, reps: 4, lapses: 1, lastRating: 1 },
  { id: 2, listId: 1, unitId: 1, unitName: 'Unit 1 基础', term: 'deliberate', phonetic: '/dɪˈlɪbərət/', meaning: 'adj. 故意的；深思熟虑的', example: 'It was a deliberate attempt to mislead.', tags: 'cet4', needMeaning: 1, createdAt: now - day * 30, intervalDays: 2, dueAt: now - day, reps: 3, lapses: 2, lastRating: 0 },
  { id: 3, listId: 1, unitId: 2, unitName: 'Unit 2 进阶', term: 'inevitable', phonetic: '/ɪnˈevɪtəbl/', meaning: 'adj. 不可避免的', example: 'Delay was inevitable after the storm.', tags: 'cet4', needMeaning: 0, createdAt: now - day * 25, intervalDays: 9, dueAt: now + day * 3, reps: 5, lapses: 0, lastRating: 1 },
  { id: 4, listId: 2, unitId: null, unitName: '', term: 'compelling', phonetic: '/kəmˈpelɪŋ/', meaning: 'adj. 令人信服的；引人入胜的', example: 'She made a compelling argument.', tags: 'kaoyan', needMeaning: 1, createdAt: now - day * 18, intervalDays: 1, dueAt: now - 3_600_000, reps: 2, lapses: 3, lastRating: 0 },
  { id: 5, listId: 2, unitId: null, unitName: '', term: 'scrutiny', phonetic: '/ˈskruːtəni/', meaning: 'n. 仔细审查', example: 'The policy came under public scrutiny.', tags: 'kaoyan', needMeaning: 0, createdAt: now - day * 12, intervalDays: 4, dueAt: now + 3_600_000, reps: 3, lapses: 1, lastRating: 1 },
]

let settings: Settings = { ...DEFAULT_SETTINGS, activeListId: 1 }

const bundle: SettingsBundle = {
  settings,
  dictionary: {
    loaded: true,
    count: 12_486,
    source: 'build-in ecdict',
    generatedAt: '2026-10-01',
    bytes: 4_120_576,
  },
  dataDir: 'C:\\Users\\Public\\Documents\\gancigong-data',
}

const dashboard: DashboardState = {
  nextFireAt: now + 12 * 60_000,
  scheduleSetAt: now - 8 * 60_000,
  nextFireReason: 'scheduled',
  activeListId: 1,
  activeListName: '四级核心词',
  dueToday: 32,
  dueTomorrow: 24,
  dueAfterTomorrow: 16,
  reviewDue: 18,
  mastered: 128,
  fresh: 64,
  dailyNewWords: 10,
  newToday: 4,
  needMeaning: 9,
  totalWords: words.length,
  delayUsed: 1,
  delayQuota: 3,
  delayMinutes: 10,
  mode: 'gentle',
  lockLevel: 'app',
  roundsToday: 2,
  wordsToday: 20,
  recentRounds: [
    { id: 3, plannedAt: now - 3 * 3_600_000, mode: 'gentle', planned: 10, rated: 10, status: 'done', knowRate: 0.8 },
    { id: 2, plannedAt: now - 5 * 3_600_000, mode: 'gentle', planned: 10, rated: 9, status: 'aborted', knowRate: 0.67 },
    { id: 1, plannedAt: now - 7 * 3_600_000, mode: 'gentle', planned: 10, rated: 10, status: 'done', knowRate: 0.9 },
  ],
  windows: DEFAULT_SETTINGS.windows,
  intervalMinutes: 20,
  schedulerActive: true,
  wrongToday: 0,
  wrongTotal: 0,
}

const daily: DayStat[] = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(now - (6 - i) * day)
  const words = [12, 18, 0, 24, 20, 16, 20][i]
  const known = Math.round(words * [0.75, 0.83, 0, 0.79, 0.85, 0.81, 0.8][i])
  return { day: d.toISOString().slice(0, 10), words, known, rate: words ? known / words : null }
})

const stats: StatsOverview = {
  counts: { total: words.length, mastered: 128, fresh: 64, needMeaning: 9, dueNow: 32 },
  daily,
  topLapses: words.slice(0, 5).map((w) => ({
    term: w.term,
    meaning: w.meaning,
    lapses: w.lapses ?? 0,
    reps: w.reps ?? 0,
    intervalDays: w.intervalDays ?? 0,
  })),
  streak: 6,
  wordsToday: 20,
  knowRateToday: 0.8,
  delay: { used: 1, quota: 3, left: 2 },
  roundsDone: 2,
  nextFireAt: dashboard.nextFireAt,
  settings: { mode: 'gentle', lockLevel: 'app' },
}

const cards: CardData[] = words.slice(0, 3).map((w, i) => ({
  wordId: w.id,
  term: w.term,
  phonetic: w.phonetic,
  meaning: w.meaning,
  example: w.example,
  forms: [{ form: 'abandoned', label: '过去式' }],
  mode: i === 0 ? 'spell' : 'choice',
  options: i === 0 ? [] : [w.meaning, 'adj. 不可避免的', 'n. 仔细审查'],
}))

const plan: RoundPlan = {
  roundId: 1,
  mode: 'gentle',
  lockLevel: 'app',
  ttsEnabled: true,
  delayQuotaLeft: 2,
  cards,
}

function lookup(term: string): LookupHit {
  const hit = words.find((w) => w.term.toLowerCase() === term.toLowerCase()) ?? words[0]
  return {
    term: hit.term,
    phonetic: hit.phonetic,
    meaning: hit.meaning,
    tags: hit.tags ? hit.tags.split(',') : [],
    forms: [{ form: `${hit.term}s`, label: '复数' }],
  }
}

function importResult(fileName: string): ImportResult {
  return {
    created: 0,
    updated: 0,
    skipped: 0,
    filledFromDict: 0,
    missingMeaning: 0,
    totalRows: 0,
    errors: [],
    fileName,
  }
}

const api: GanciApi = {
  settingsAll: async () => ({ ...bundle, settings }),
  settingsSet: async (patch: Partial<Settings>) => {
    settings = { ...settings, ...patch }
    return settings
  },

  themeState: async () => ({
    mode: settings.themeMode,
    accent: settings.themeAccent,
    backgroundUrl: null,
    scrim: settings.themeScrim,
  }),
  themeBackgroundPick: async () => null,
  themeBackgroundClear: async () => true,

  listsList: async () => lists,
  listsCreate: async (name: string, remark = '') => {
    const id = Math.max(...lists.map((l) => l.id)) + 1
    lists.push({ id, name, remark, wordCount: 0, dueCount: 0, unitCount: 0 })
    return id
  },
  listsRename: async (id, name, remark = '') => {
    const list = lists.find((l) => l.id === id)
    if (!list) return false
    list.name = name
    list.remark = remark
    return true
  },
  listsDelete: async (id) => {
    const index = lists.findIndex((l) => l.id === id)
    if (index < 0) return 0
    lists.splice(index, 1)
    return 1
  },

  unitsList: async (listId) => units.filter((u) => !listId || u.listId === listId),
  unitsCreate: async (listId, name) => {
    const id = Math.max(0, ...units.map((u) => u.id)) + 1
    units.push({
      id,
      listId,
      name,
      position: units.filter((u) => u.listId === listId).length + 1,
      wordCount: 0,
      dueCount: 0,
    })
    const list = lists.find((l) => l.id === listId)
    if (list) list.unitCount += 1
    return id
  },
  unitsRename: async (id, name) => {
    const unit = units.find((u) => u.id === id)
    if (!unit) return false
    unit.name = name
    return true
  },
  unitsDelete: async (id) => {
    const index = units.findIndex((u) => u.id === id)
    if (index < 0) return 0
    const listId = units[index].listId
    units.splice(index, 1)
    let moved = 0
    for (const w of words) {
      if (w.unitId === id) {
        w.unitId = null
        w.unitName = ''
        moved += 1
      }
    }
    const list = lists.find((l) => l.id === listId)
    if (list) list.unitCount = Math.max(0, list.unitCount - 1)
    return moved
  },

  wordsList: async (query) => {
    const keyword = (query.query ?? '').trim().toLowerCase()
    const dayStart = new Date()
    dayStart.setHours(0, 0, 0, 0)
    const endToday = dayStart.getTime() + 86_400_000 - 1
    const rows = words.filter(
      (w) =>
        (!query.listId || w.listId === query.listId) &&
        (query.unitId === undefined || query.unitId === null || (query.unitId === 0 ? w.unitId === null : w.unitId === query.unitId)) &&
        (!keyword || w.term.toLowerCase().includes(keyword) || w.meaning.includes(keyword)) &&
        (!query.needMeaningOnly || w.needMeaning === 1) &&
        (!query.scope ||
          query.scope === 'all' ||
          (query.scope === 'wrong' && (w.lapses ?? 0) > 0) ||
          (query.scope === 'learned' && (w.reps ?? 0) > 0) ||
          (query.scope === 'learnedToday' && (w.reps ?? 0) > 0) ||
          (query.scope === 'studiedToday' && (w.reps ?? 0) > 0) ||
          (query.scope === 'wrongReview' && (w.lapses ?? 0) > 0) ||
          (query.scope === 'reviewing' && (w.reps ?? 0) > 0 && (w.intervalMinutes ?? 0) < 10080) ||
          (query.scope === 'dueToday' && w.dueAt != null && w.dueAt <= endToday))
    )
    const offset = query.offset ?? 0
    const limit = query.limit ?? rows.length
    return { rows: rows.slice(offset, offset + limit), total: rows.length }
  },
  wordsCreate: async (listId, input) => {
    const unit = input.unitId ? units.find((u) => u.id === input.unitId) : null
    const row: WordRow = {
      id: Math.max(...words.map((w) => w.id)) + 1,
      listId,
      unitId: unit?.id ?? null,
      unitName: unit?.name ?? '',
      term: input.term,
      phonetic: input.phonetic ?? '',
      meaning: input.meaning ?? '',
      example: input.example ?? '',
      tags: input.tags ?? '',
      needMeaning: input.meaning ? 0 : 1,
      createdAt: Date.now(),
      intervalDays: 0,
      dueAt: Date.now(),
      reps: 0,
      lapses: 0,
      lastRating: null,
    }
    words.unshift(row)
    return { row, fromDictionary: false }
  },
  wordsUpdate: async (id, input) => {
    const row = words.find((w) => w.id === id)
    if (!row) throw new Error('单词不存在')
    const unit = input.unitId === undefined ? null : input.unitId ? units.find((u) => u.id === input.unitId) : null
    Object.assign(row, {
      term: input.term,
      phonetic: input.phonetic ?? '',
      meaning: input.meaning ?? '',
      example: input.example ?? '',
      tags: input.tags ?? '',
      needMeaning: input.meaning ? 0 : 1,
      ...(input.unitId === undefined ? {} : { unitId: unit?.id ?? null, unitName: unit?.name ?? '' }),
    })
    return row
  },
  wordsDelete: async (ids) => {
    let count = 0
    for (const id of ids) {
      const index = words.findIndex((w) => w.id === id)
      if (index >= 0) {
        words.splice(index, 1)
        count += 1
      }
    }
    return count
  },
  wordsMove: async (ids, unitId) => {
    const unit = unitId ? units.find((u) => u.id === unitId) : null
    let count = 0
    for (const w of words) {
      if (!ids.includes(w.id)) continue
      w.unitId = unit?.id ?? null
      w.unitName = unit?.name ?? ''
      count += 1
    }
    return count
  },
  wordsPickCsv: async () => null,
  wordsImport: async (path) => importResult(path.split(/[\\/]/).pop() ?? 'demo.csv'),
  wordsExport: async () => ({ count: words.length, path: bundle.dataDir + '\\words.csv' }),
  openDataDir: async () => bundle.dataDir,
  dictLookup: async (term) => lookup(term),

  dashboardState: async () => dashboard,
  statsOverview: async () => stats,
  flowStatus: async () => ({
    nextFireAt: dashboard.nextFireAt,
    scheduleSetAt: dashboard.scheduleSetAt,
    reason: 'scheduled',
    schedulerActive: true,
    sessionRoundId: null,
    kioskEngaged: false,
    escapeShortcutReady: true,
    escapeShortcutCombo: 'Ctrl+Shift+X',
    delay: { used: 1, quota: 3, left: 2 },
  }),

  reviewStartNow: async () => ({ ok: true, roundId: 1 }),
  reviewPlan: async () => plan,
  reviewRate: async () => ({ nextDueAt: Date.now() + day, intervalDays: 1 }),
  reviewFinish: async () => true,
  reviewDelay: async () => ({ ok: true, left: 2, minutes: 10 }),
  reviewAbort: async () => true,

  learnPause: async () => true,
  learnResume: async () => true,
  learnStart: async () => ({ cards, wrongToday: [] }),
  learnWrongList: async () => [],
  learnWrongMark: async () => 1,
  learnFinish: async () => ({ rated: 0, known: 0, wrongToday: [] }),
  learnProgressGet: async () => null,
  learnProgressSave: async () => true,
  learnProgressClear: async () => true,

  wrongsList: async () =>
    words
      .filter((w) => (w.lapses ?? 0) > 0)
      .map((w) => ({
        wordId: w.id,
        term: w.term,
        phonetic: w.phonetic,
        meaning: w.meaning,
        lastWrongAt: now - 3_600_000,
      })),
  wrongsCounts: async () => {
    const total = words.filter((w) => (w.lapses ?? 0) > 0).length
    return { today: total, total }
  },
  wrongsRemove: async (wordIds) => wordIds.length,

  kioskStatus: async () => ({ engaged: false, pid: null }),

  floatMenuToggle: async () => {},
  floatMenuClose: async () => {},
  openMain: async (path?: string) => {
    if (path && path.startsWith('/')) location.hash = `#${path}`
  },

  onDataChanged: () => () => {},
  onNavigate: () => () => {},
  onScheduleChanged: () => () => {},
  onDelayDenied: () => () => {},
}

window.ganci = api
