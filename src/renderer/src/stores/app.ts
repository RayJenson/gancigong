import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { DashboardState, DictionaryStatus, FlowStatus, Settings } from '@shared/types'

export const useAppStore = defineStore('app', () => {
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
  const dictionary = ref<DictionaryStatus | null>(null)
  const dashboard = ref<DashboardState | null>(null)
  const flow = ref<FlowStatus | null>(null)
  const dataDir = ref('')
  const error = ref<string>('')
  const ready = ref(false)

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

  return {
    settings,
    dictionary,
    dashboard,
    flow,
    dataDir,
    error,
    ready,
    bootstrap,
    refreshDashboard,
    refreshFlow,
    save,
    activeWindowLabel,
  }
})
