import { get, run, transaction } from './db'
import { DEFAULT_SETTINGS, type Settings, type TimeWindow } from '@shared/types'

type NumericKey = 'intervalMinutes' | 'wordsPerRound' | 'delayQuotaPerDay' | 'delayMinutes'

const NUMBER_LIMITS: Record<NumericKey, [number, number]> = {
  intervalMinutes: [1, 240],
  wordsPerRound: [1, 60],
  delayQuotaPerDay: [0, 20],
  delayMinutes: [1, 120],
}

function asRow(s: Settings): Record<string, unknown> {
  return s as unknown as Record<string, unknown>
}

function rowsToSettings(): Settings {
  const out = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const row = get<{ value_json: string }>('select value_json from settings where key = ?', key)
    if (!row) continue
    try {
      asRow(out)[key] = JSON.parse(row.value_json)
    } catch {
      /* 单条配置损坏则回退默认值 */
    }
  }
  return sanitize(out)
}

function sanitize(s: Settings): Settings {
  const windows = (Array.isArray(s.windows) ? s.windows : [])
    .filter((w): w is TimeWindow => !!w && typeof w.start === 'string' && typeof w.end === 'string' && w.start !== w.end)
    .map((w, i) => ({ id: w.id || `w${i + 1}`, start: w.start, end: w.end }))
  s.windows = windows.length ? windows : DEFAULT_SETTINGS.windows

  for (const [key, [min, max]] of Object.entries(NUMBER_LIMITS) as [NumericKey, [number, number]][]) {
    const value = Number(s[key])
    s[key] = Number.isFinite(value) ? Math.round(Math.min(max, Math.max(min, value))) : DEFAULT_SETTINGS[key]
  }
  if (s.mode !== 'gentle' && s.mode !== 'fullscreen') s.mode = DEFAULT_SETTINGS.mode
  if (s.practiceMode !== 'auto' && s.practiceMode !== 'spell' && s.practiceMode !== 'choice') {
    s.practiceMode = DEFAULT_SETTINGS.practiceMode
  }
  if (s.lockLevel !== 'app' && s.lockLevel !== 'kiosk') s.lockLevel = DEFAULT_SETTINGS.lockLevel
  if (typeof s.ttsEnabled !== 'boolean') s.ttsEnabled = DEFAULT_SETTINGS.ttsEnabled
  if (typeof s.lockAllDisplays !== 'boolean') s.lockAllDisplays = DEFAULT_SETTINGS.lockAllDisplays
  if (typeof s.autostart !== 'boolean') s.autostart = DEFAULT_SETTINGS.autostart
  if (s.activeListId !== null && !Number.isInteger(s.activeListId)) s.activeListId = null
  return s
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (!cache) cache = rowsToSettings()
  return structuredClone(cache)
}

export function setSettings(patch: Partial<Settings>): Settings {
  const merged = sanitize({ ...(cache ?? rowsToSettings()), ...structuredClone(patch) })
  transaction(() => {
    for (const key of Object.keys(merged) as (keyof Settings)[]) {
      run(
        'insert into settings (key, value_json) values (?, ?) on conflict(key) do update set value_json = excluded.value_json',
        key,
        JSON.stringify(asRow(merged)[key])
      )
    }
  })
  cache = merged
  return structuredClone(merged)
}

export function touchSettings(): void {
  cache = null
}
