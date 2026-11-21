import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { DEFAULT_SETTINGS } from '@shared/types'
import { accentPreset, type AccentPreset } from '@renderer/lib/accents'
import { applyThemeDom, watchSystemTheme, type ResolvedTheme } from '@renderer/lib/theme'
import type { DashboardState, DictionaryStatus, FlowStatus, Settings, ThemeAccent, ThemeMode } from '@shared/types'

export const useAppStore = defineStore('app', () => {
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
  const dictionary = ref<DictionaryStatus | null>(null)
  const dashboard = ref<DashboardState | null>(null)
  const flow = ref<FlowStatus | null>(null)
  const dataDir = ref('')
  const error = ref<string>('')
  const ready = ref(false)
  const themeBackgroundUrl = ref<string | null>(null)
  const resolvedTheme = ref<ResolvedTheme>('light')
  const activeAccent = computed<AccentPreset>(() => accentPreset(settings.value.themeAccent))
  let themeStarted = false

  async function bootstrap(): Promise<void> {
    try {
      const bundle = await window.ganci.settingsAll()
      settings.value = bundle.settings
      dictionary.value = bundle.dictionary
      dataDir.value = bundle.dataDir
      await Promise.all([refreshDashboard(), refreshFlow()])
      ready.value = true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function refreshFlow(): Promise<void> {
    try {
      flow.value = await window.ganci.flowStatus()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function refreshDashboard(): Promise<void> {
    try {
      dashboard.value = await window.ganci.dashboardState()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  async function save(patch: Partial<Settings>): Promise<boolean> {
    try {
      settings.value = await window.ganci.settingsSet(patch)
      await refreshDashboard()
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  const activeWindowLabel = computed(() => {
    const w = settings.value.windows
    if (!w.length) return '未设置复习时段'
    return w.map((x) => `${x.start}–${x.end}`).join('、')
  })

  function applyThemeNow(): void {
    resolvedTheme.value = applyThemeDom({
      mode: settings.value.themeMode,
      accent: settings.value.themeAccent,
      backgroundUrl: themeBackgroundUrl.value,
      scrim: settings.value.themeScrim,
    })
  }

  /** 复习弹窗等独立窗口也要先拿到主题，所以不依赖完整 bootstrap */
  async function initTheme(): Promise<void> {
    if (themeStarted) return
    themeStarted = true
    try {
      const state = await window.ganci.themeState()
      themeBackgroundUrl.value = state.backgroundUrl
      settings.value = {
        ...settings.value,
        themeMode: state.mode,
        themeAccent: state.accent,
        themeScrim: state.scrim,
      }
    } catch {
      /* 主题读不到就按默认渲染，不阻塞页面 */
    }
    applyThemeNow()
    watchSystemTheme(() => {
      if (settings.value.themeMode === 'system') applyThemeNow()
    })
  }

  watch(
    [() => settings.value.themeMode, () => settings.value.themeAccent, () => settings.value.themeScrim, themeBackgroundUrl],
    applyThemeNow
  )

  let scrimTimer: ReturnType<typeof setTimeout> | null = null

  async function setThemeMode(mode: ThemeMode): Promise<void> {
    settings.value = { ...settings.value, themeMode: mode }
    await save({ themeMode: mode })
  }

  async function setThemeAccent(accent: ThemeAccent): Promise<void> {
    if (settings.value.themeAccent === accent) return
    settings.value = { ...settings.value, themeAccent: accent }
    await save({ themeAccent: accent })
  }

  /** 滑杆拖动先本地生效，停下来再落库，避免每一步都等磁盘 */
  function setThemeScrim(scrim: number): void {
    settings.value = { ...settings.value, themeScrim: scrim }
    if (scrimTimer) clearTimeout(scrimTimer)
    scrimTimer = setTimeout(() => {
      scrimTimer = null
      void save({ themeScrim: scrim })
    }, 250)
  }

  async function pickThemeBackground(): Promise<string | null> {
    const url = await window.ganci.themeBackgroundPick()
    if (url) themeBackgroundUrl.value = url
    return url
  }

  async function clearThemeBackground(): Promise<void> {
    await window.ganci.themeBackgroundClear()
    themeBackgroundUrl.value = null
  }

  return {
    settings,
    dictionary,
    dashboard,
    flow,
    dataDir,
    error,
    ready,
    themeBackgroundUrl,
    resolvedTheme,
    activeAccent,
    bootstrap,
    refreshDashboard,
    refreshFlow,
    save,
    activeWindowLabel,
    initTheme,
    setThemeMode,
    setThemeAccent,
    setThemeScrim,
    pickThemeBackground,
    clearThemeBackground,
  }
})
