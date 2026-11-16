<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { NIcon } from 'naive-ui'
import { AnalyticsOutline, GridOutline, LibraryOutline, SettingsOutline } from '@vicons/ionicons5'
import { useAppStore } from '@renderer/stores/app'
import { formatCountdown, toHHMM } from '@shared/time'

const store = useAppStore()
const route = useRoute()
const bare = computed(() => route.meta.bare === true)
const now = ref(Date.now())

const NAV = [
  { key: 'dashboard', label: '复习台', icon: GridOutline, to: '/' },
  { key: 'words', label: '词库', icon: LibraryOutline, to: '/words' },
  { key: 'settings', label: '设置', icon: SettingsOutline, to: '/settings' },
  { key: 'stats', label: '统计', icon: AnalyticsOutline, to: '/stats' },
]

const REASON_LABEL: Record<string, string> = {
  scheduled: '按计划',
  delayed: '延后中',
  out_of_words: '暂无到期词',
  paused: '不在复习时段',
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
  if (nextFire.value === null) return REASON_LABEL[store.dashboard?.nextFireReason ?? 'idle'] ?? '未排程'
  return `${toHHMM(nextFire.value)} · ${formatCountdown(nextFire.value, now.value)}`
})
const nextReason = computed(() => REASON_LABEL[store.dashboard?.nextFireReason ?? 'idle'] ?? '')
</script>

<template>
  <!-- 复习弹窗与副屏遮罩不带应用外壳 -->
  <router-view v-if="bare" />

  <div v-else class="flex h-full">
    <aside class="flex w-[200px] shrink-0 flex-col border-r border-line bg-surface">
      <div class="px-5 pt-5 pb-4">
        <div class="text-[17px] font-semibold tracking-wide text-ink">赶词工</div>
        <div class="mt-1 text-[11px] text-muted">别让单词等你</div>
      </div>

      <nav class="flex-1 px-2">
        <RouterLink
          v-for="item in NAV"
          :key="item.key"
          :to="item.to"
          class="mb-1 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[13px] text-ink/75 no-underline transition-colors hover:bg-canvas"
          :class="
            route.meta.nav === item.key
              ? '!bg-canvas font-semibold text-brand shadow-[inset_2px_0_0_0_var(--color-brand)]'
              : ''
          "
        >
          <NIcon :component="item.icon" :size="16" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="mx-3 mb-3 rounded-card border border-line bg-canvas px-3 py-2.5">
        <div class="text-[11px] text-muted">下次提醒</div>
        <div class="num-display mt-0.5 text-[13px] font-semibold text-accent">{{ nextLabel }}</div>
        <div class="mt-0.5 text-[11px] text-muted">{{ nextReason }}</div>
      </div>

      <div class="border-t border-line px-5 py-3 text-[11px] text-muted">
        <div>{{ store.dictionary ? `${store.dictionary.count.toLocaleString()} 条离线词义` : '词典未加载' }}</div>
        <div class="mt-1">数据只存在这台电脑</div>
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-y-auto">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
  </div>
</template>
