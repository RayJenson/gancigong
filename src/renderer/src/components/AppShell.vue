<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NIcon, NTooltip } from 'naive-ui'
import {
  AnalyticsOutline,
  AlertCircleOutline,
  ChevronBackOutline,
  ChevronForwardOutline,
  GridOutline,
  LibraryOutline,
  SettingsOutline,
  TimeOutline,
} from '@vicons/ionicons5'
import { useAppStore } from '@renderer/stores/app'
import { formatCountdown, toHHMM } from '@shared/time'
import TitleBar from './TitleBar.vue'

const store = useAppStore()
const route = useRoute()
const router = useRouter()
const bare = computed(() => route.meta.bare === true)
const immersive = computed(() => route.meta.immersive === true)
const now = ref(Date.now())

const RAIL_COLLAPSED_KEY = 'ganci.rail-collapsed'
const collapsed = ref(localStorage.getItem(RAIL_COLLAPSED_KEY) === '1')

function toggleRail(): void {
  collapsed.value = !collapsed.value
  localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed.value ? '1' : '0')
}

const NAV = [
  { key: 'dashboard', label: '主页', icon: GridOutline, to: '/' },
  { key: 'words', label: '词库', icon: LibraryOutline, to: '/words' },
  { key: 'wrongs', label: '错词本', icon: AlertCircleOutline, to: '/wrongs' },
  { key: 'stats', label: '统计', icon: AnalyticsOutline, to: '/stats' },
  { key: 'settings', label: '设置', icon: SettingsOutline, to: '/settings' },
]

const REASON_LABEL: Record<string, string> = {
  scheduled: '按计划',
  delayed: '延后中',
  out_of_words: '暂无到期词',
  no_due: '暂无待复习',
  paused: '不在复习时段',
  learning: '学习中 · 提醒暂停',
  idle: '调度未启动',
}

let unsubscribe: Array<() => void> = []
let ticker: number | undefined

onMounted(async () => {
  if (bare.value) return
  await store.bootstrap()
  unsubscribe.push(window.ganci.onDataChanged(() => void store.refreshDashboard()))
  unsubscribe.push(
    window.ganci.onScheduleChanged((status) => {
      store.flow = status
      void store.refreshDashboard()
    })
  )
  unsubscribe.push(
    window.ganci.onNavigate((path) => {
      if (path.startsWith('/')) void router.push(path)
    })
  )
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  unsubscribe.forEach((f) => f())
  if (ticker) clearInterval(ticker)
})

const nextFire = computed(() => store.dashboard?.nextFireAt ?? null)
const nextLabel = computed(() => {
  if (nextFire.value === null) return '—'
  return `${toHHMM(nextFire.value)} · ${formatCountdown(nextFire.value, now.value)}`
})
const nextReason = computed(() => REASON_LABEL[store.dashboard?.nextFireReason ?? 'idle'] ?? '')
</script>

<template>
  <!-- 复习弹窗与副屏遮罩不带应用外壳 -->
  <router-view v-if="bare" />

  <div v-else class="app-frame">
    <TitleBar />
    <div class="app-body">
    <aside v-if="!immersive" class="rail" :class="{ 'is-collapsed': collapsed }">
      <div v-show="!collapsed" class="rail-label">工作台</div>
      <nav class="rail-nav">
        <N-tooltip
          v-for="item in NAV"
          :key="item.key"
          placement="right"
          :delay="120"
          :disabled="!collapsed"
        >
          <template #trigger>
            <RouterLink
              :to="item.to"
              class="nav-item"
              :class="{ active: route.meta.nav === item.key }"
              :aria-label="item.label"
            >
              <NIcon :component="item.icon" :size="16" class="nav-ico" />
              <span v-show="!collapsed" class="nav-text">{{ item.label }}</span>
              <span class="nav-dot" />
            </RouterLink>
          </template>
          {{ item.label }}
        </N-tooltip>
      </nav>

      <div class="rail-divider" />

      <N-tooltip placement="right" :delay="120" :disabled="!collapsed">
        <template #trigger>
          <button
            class="nav-item rail-toggle"
            type="button"
            aria-label="折叠或展开导航栏"
            :aria-expanded="!collapsed"
            @click="toggleRail"
          >
            <NIcon
              :component="collapsed ? ChevronForwardOutline : ChevronBackOutline"
              :size="15"
              class="nav-ico"
            />
            <span v-show="!collapsed" class="nav-text">收起导航</span>
          </button>
        </template>
        {{ collapsed ? '展开导航' : '收起导航' }}
      </N-tooltip>

      <div class="rail-spacer" />

      <div v-show="!collapsed" class="reminder-card">
        <div class="rail-label inside">下次提醒</div>
        <div class="reminder-time">{{ nextLabel }}</div>
        <div class="reminder-reason">{{ nextReason }}</div>
        <div class="reminder-dict">
          <span>{{ store.dictionary ? `${store.dictionary.count.toLocaleString()} 条词义` : '词典未加载' }}</span>
          <span>离线</span>
        </div>
      </div>

      <div v-show="collapsed" class="rail-mini">
        <N-tooltip placement="right" :delay="120">
          <template #trigger>
            <button class="mini-chip" type="button" aria-label="下次提醒">
              <NIcon :component="TimeOutline" :size="15" />
              <span class="mini-badge" />
            </button>
          </template>
          下次提醒 {{ nextLabel }} · {{ nextReason }}
        </N-tooltip>
        <N-tooltip placement="right" :delay="120">
          <template #trigger>
            <span class="mini-status" role="img" aria-label="数据只存在这台电脑">
              <span class="status-dot" />
            </span>
          </template>
          数据只存在这台电脑
        </N-tooltip>
      </div>

      <div v-show="!collapsed" class="rail-foot">
        <span class="status-dot" />
        <span>数据只存在这台电脑</span>
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
    </div>
  </div>
</template>

<style scoped>
.app-frame {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}
.app-body {
  display: flex;
  min-height: 0;
  flex: 1;
}
.rail {
  display: flex;
  width: 218px;
  flex: none;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--color-line);
  background: var(--color-surface);
  padding: 18px 12px 14px;
  transition: width 200ms cubic-bezier(0.4, 0, 0.2, 1), padding 200ms cubic-bezier(0.4, 0, 0.2, 1);
}

.rail.is-collapsed {
  width: 74px;
  padding-left: 10px;
  padding-right: 10px;
}

.rail-label {
  padding: 0 10px 8px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: color-mix(in srgb, var(--color-muted) 78%, transparent);
}

.rail-label.inside {
  padding: 0 0 6px;
}

.rail-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  border-radius: 9px;
  padding: 9px 10px;
  font-size: 13px;
  color: color-mix(in srgb, var(--color-ink) 68%, transparent);
  text-decoration: none;
  white-space: nowrap;
  transition: background-color 140ms ease, color 140ms ease, padding 200ms ease;
}

.nav-item:hover {
  background: color-mix(in srgb, var(--color-canvas) 70%, var(--color-raised));
  color: var(--color-ink);
}

.nav-item.active {
  background: color-mix(in srgb, var(--color-brand) 9%, var(--color-raised));
  color: var(--color-brand);
  font-weight: 600;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-brand) 14%, transparent);
}

.nav-ico {
  flex: none;
  opacity: 0.85;
  transition: opacity 140ms ease;
}

.nav-item:hover .nav-ico,
.nav-item.active .nav-ico {
  opacity: 1;
}

.nav-text {
  overflow: hidden;
  text-overflow: ellipsis;
}

.nav-dot {
  margin-left: auto;
  height: 5px;
  width: 5px;
  border-radius: 50%;
  background: var(--color-accent);
  opacity: 0;
}

.nav-item.active .nav-dot {
  opacity: 1;
}

.rail.is-collapsed .nav-item {
  justify-content: center;
  gap: 0;
  padding: 10px 0;
}

.rail.is-collapsed .nav-dot {
  display: none;
}

/* 折叠时用左侧短竖条替代右侧小圆点，活动项仍然一眼可见 */
.rail.is-collapsed .nav-item.active::before {
  content: '';
  position: absolute;
  left: -10px;
  top: 50%;
  height: 18px;
  width: 3px;
  transform: translateY(-50%);
  border-radius: 0 3px 3px 0;
  background: var(--color-brand);
}

.rail-divider {
  height: 1px;
  margin: 8px 6px 6px;
  background: var(--color-line);
  transition: margin 200ms ease;
}

.rail.is-collapsed .rail-divider {
  margin: 8px 10px 6px;
}

.rail-toggle {
  width: 100%;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: 12.5px;
  color: var(--color-muted);
  text-align: left;
  cursor: pointer;
}

.rail.is-collapsed .rail-toggle {
  text-align: center;
}

.rail-spacer {
  flex: 1;
  min-height: 16px;
}

.reminder-card {
  border: 1px solid var(--color-line);
  border-radius: 12px;
  background:
    radial-gradient(120% 90% at 100% 0%, rgb(194 121 44 / 0.08), transparent 60%),
    linear-gradient(165deg, var(--color-surface), var(--color-surface-2));
  padding: 12px 12px 10px;
}

.reminder-time {
  font-family: var(--font-term);
  font-size: 20px;
  line-height: 1.2;
  color: var(--color-brand);
  font-variant-numeric: tabular-nums;
}

.reminder-reason {
  margin-top: 2px;
  font-size: 11px;
  color: var(--color-muted);
}

.reminder-dict {
  display: flex;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--color-line);
  font-size: 10.5px;
  color: var(--color-muted);
}

.rail-foot {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 12px 8px 2px;
  font-size: 10.5px;
  color: var(--color-muted);
}

.status-dot {
  height: 6px;
  width: 6px;
  border-radius: 50%;
  background: #3e9c74;
  box-shadow: 0 0 0 3px rgb(62 156 116 / 0.14);
}

.rail-mini {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 4px 0 2px;
}

.mini-chip {
  position: relative;
  display: grid;
  height: 34px;
  width: 34px;
  place-items: center;
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: linear-gradient(165deg, var(--color-surface), var(--color-surface-2));
  color: var(--color-brand);
  cursor: default;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.mini-chip:hover {
  border-color: color-mix(in srgb, var(--color-brand) 32%, var(--color-raised));
  background: linear-gradient(165deg, var(--color-surface), var(--color-surface-2));
}

.mini-badge {
  position: absolute;
  top: 7px;
  right: 7px;
  height: 5px;
  width: 5px;
  border-radius: 50%;
  background: var(--color-accent);
}

.mini-status {
  display: grid;
  padding: 2px;
  place-items: center;
  cursor: default;
}
</style>
