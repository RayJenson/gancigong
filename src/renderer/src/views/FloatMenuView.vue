<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from 'vue'
import { NIcon } from 'naive-ui'
import {
  AlertCircleOutline,
  AnalyticsOutline,
  BookOutline,
  EyeOffOutline,
  HomeOutline,
  LibraryOutline,
  RefreshOutline,
  SettingsOutline,
} from '@vicons/ionicons5'
import { useNextRound } from '@renderer/lib/next-round'

interface QuickAction {
  key: string
  label: string
  icon: Component
  path?: string
}

const QUICK: QuickAction[] = [
  { key: 'review', label: '立即复习', icon: RefreshOutline },
  { key: 'learn', label: '背单词', icon: BookOutline, path: '/learn' },
  { key: 'words', label: '词库', icon: LibraryOutline, path: '/words' },
  { key: 'wrongs', label: '错词本', icon: AlertCircleOutline, path: '/wrongs' },
  { key: 'stats', label: '统计', icon: AnalyticsOutline, path: '/stats' },
  { key: 'settings', label: '设置', icon: SettingsOutline, path: '/settings' },
]

const due = ref<number | null>(null)
const wrongs = ref<number | null>(null)
const busy = ref(false)
const hint = ref('')
const { hasSchedule, fraction, timeLabel, reasonLabel } = useNextRound()
const nextHint = computed(() => (hasSchedule.value ? timeLabel.value : reasonLabel.value || '暂无排程'))
let hintTimer: number | undefined
let offData: (() => void) | null = null
let offSchedule: (() => void) | null = null

async function close(): Promise<void> {
  try {
    await window.ganci.floatMenuClose()
  } catch {
    /* 窗口可能已经被关闭 */
  }
}

function flashHint(text: string): void {
  hint.value = text
  if (hintTimer) clearTimeout(hintTimer)
  hintTimer = window.setTimeout(() => {
    hint.value = ''
  }, 2600)
}

async function run(action: QuickAction): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    if (action.key === 'review') {
      const result = await window.ganci.reviewStartNow('mixed')
      if (result.ok) {
        await close()
        return
      }
      flashHint(result.reason === 'already_running' ? '已经有一轮复习在进行中' : '暂时没有可复习的词')
      return
    }
    if (action.path) {
      await window.ganci.openMain(action.path)
      await close()
    }
  } catch {
    flashHint('操作失败，请回到主界面重试')
  } finally {
    busy.value = false
  }
}

async function openHome(): Promise<void> {
  await window.ganci.openMain('/')
  await close()
}

async function hideBall(): Promise<void> {
  await window.ganci.settingsSet({ floatBall: false })
  await close()
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') void close()
}

async function refreshCounts(): Promise<void> {
  try {
    const d = await window.ganci.dashboardState()
    due.value = d.reviewDue
    wrongs.value = d.wrongTotal
  } catch {
    /* 统计读不到就显示占位 */
  }
}

onMounted(() => {
  document.documentElement.dataset.window = 'float'
  window.addEventListener('keydown', onKey)
  void refreshCounts()
  offData = window.ganci.onDataChanged(() => void refreshCounts())
  offSchedule = window.ganci.onScheduleChanged(() => void refreshCounts())
})

onBeforeUnmount(() => {
  delete document.documentElement.dataset.window
  window.removeEventListener('keydown', onKey)
  offData?.()
  offSchedule?.()
  if (hintTimer) clearTimeout(hintTimer)
})
</script>

<template>
  <div class="menu-root">
    <div class="panel" role="menu" aria-label="赶词工快捷菜单">
      <header class="menu-head">
        <div class="menu-title">赶词工</div>
        <div class="menu-sub">今日待复习 {{ due ?? '—' }} · 错词本 {{ wrongs ?? '—' }}</div>
      </header>

      <div class="next-round" :class="{ 'is-idle': !hasSchedule }">
        <div class="next-row">
          <span class="next-label">下一轮复习</span>
          <span class="next-time">{{ nextHint }}</span>
        </div>
        <div
          class="next-track"
          role="progressbar"
          aria-label="距下一轮复习的剩余时间"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="Math.round(fraction * 100)"
        >
          <span class="next-fill" :style="{ width: `${fraction * 100}%` }" />
        </div>
      </div>

      <div class="menu-grid">
        <button
          v-for="action in QUICK"
          :key="action.key"
          class="menu-cell"
          type="button"
          role="menuitem"
          :disabled="busy"
          @click="run(action)"
        >
          <NIcon :component="action.icon" :size="17" />
          <span>{{ action.label }}</span>
        </button>
      </div>

      <p v-if="hint" class="menu-hint">{{ hint }}</p>

      <div class="menu-foot">
        <button class="menu-row" type="button" @click="openHome">
          <NIcon :component="HomeOutline" :size="15" />
          <span>打开主界面</span>
        </button>
        <button class="menu-row" type="button" @click="hideBall">
          <NIcon :component="EyeOffOutline" :size="15" />
          <span>隐藏悬浮球</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.menu-root {
  height: 100%;
  width: 100%;
  padding: 8px;
  background: transparent;
}

.panel {
  display: flex;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  padding: 12px 10px 8px;
}

.menu-head {
  padding: 0 8px 10px;
  border-bottom: 1px solid var(--line);
}

.menu-title {
  font-size: 13px;
  font-weight: 700;
  color: var(--ink);
}

.menu-sub {
  margin-top: 3px;
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.next-round {
  padding: 9px 8px 9px;
  border-bottom: 1px solid var(--line);
}

.next-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}

.next-label {
  flex: none;
  font-size: 11px;
  color: var(--muted);
}

.next-time {
  overflow: hidden;
  color: var(--ink);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.next-round.is-idle .next-time {
  color: var(--muted);
}

.next-track {
  position: relative;
  height: 4px;
  margin-top: 7px;
  overflow: hidden;
  border-radius: 999px;
  background: color-mix(in srgb, var(--brand) 12%, var(--surface-2));
}

.next-fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: inherit;
  background: linear-gradient(90deg, color-mix(in srgb, var(--brand) 62%, var(--accent)), var(--brand));
  transition: width 1s linear;
}

.next-round.is-idle .next-fill {
  opacity: 0;
}

.menu-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  padding: 8px 2px;
}

.menu-cell {
  display: flex;
  height: 54px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ink);
  font-size: 11.5px;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}

.menu-cell:hover {
  background: color-mix(in srgb, var(--brand) 9%, var(--surface-2));
  color: var(--brand);
}

.menu-cell:disabled {
  opacity: 0.55;
  cursor: default;
}

.menu-cell:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 55%, transparent);
  outline-offset: -2px;
}

.menu-hint {
  margin: 0 8px 6px;
  font-size: 11px;
  color: var(--danger);
}

.menu-foot {
  display: flex;
  flex-direction: column;
  margin-top: auto;
  padding-top: 4px;
  border-top: 1px solid var(--line);
}

.menu-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  padding: 8px 8px;
  color: var(--muted);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}

.menu-row:hover {
  background: var(--surface-2);
  color: var(--ink);
}

.menu-row:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--brand) 55%, transparent);
  outline-offset: -2px;
}
</style>