import type { ThemeAccent, ThemeMode } from '@shared/types'
import { DEFAULT_ACCENT, isThemeAccent } from './accents'

export type ResolvedTheme = 'light' | 'dark'

const CACHE_KEY = 'ganci.theme-resolved'
const ACCENT_KEY = 'ganci.theme-accent'

const systemDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

export function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode === 'system') return systemDark() ? 'dark' : 'light'
  return mode
}

export function applyThemeDom(state: {
  mode: ThemeMode
  accent: ThemeAccent
  backgroundUrl: string | null
  scrim: number
}): ResolvedTheme {
  const root = document.documentElement
  const resolved = resolveTheme(state.mode)
  const accent = isThemeAccent(state.accent) ? state.accent : DEFAULT_ACCENT
  root.dataset.theme = resolved
  root.dataset.accent = accent
  root.dataset.skin = state.backgroundUrl ? 'on' : 'off'
  root.style.setProperty('--skin-strength', String(state.scrim / 100))
  try {
    localStorage.setItem(CACHE_KEY, resolved)
    localStorage.setItem(ACCENT_KEY, accent)
  } catch {
    /* 隐私模式写不进去也不影响 */
  }
  return resolved
}

/** 首屏挂载前先按上次结果铺底色，避免暗色模式闪一下白、主题色闪一下绿 */
export function applyCachedTheme(): void {
  const cached = localStorage.getItem(CACHE_KEY)
  const resolved: ResolvedTheme = cached === 'dark' || cached === 'light' ? cached : systemDark() ? 'dark' : 'light'
  const accent = localStorage.getItem(ACCENT_KEY)
  document.documentElement.dataset.theme = resolved
  document.documentElement.dataset.accent = isThemeAccent(accent) ? accent : DEFAULT_ACCENT
}

export function watchSystemTheme(callback: () => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  mq.addEventListener('change', callback)
  return () => mq.removeEventListener('change', callback)
}
