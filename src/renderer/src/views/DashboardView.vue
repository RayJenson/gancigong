<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NTag, useMessage } from 'naive-ui'
import { useAppStore } from '@renderer/stores/app'
import { formatCountdown, startOfDay, toHHMM } from '@shared/time'
import type { ReviewMode } from '@shared/types'

const store = useAppStore()
const router = useRouter()
const message = useMessage()
const now = ref(Date.now())
const starting = ref(false)
let ticker: number | undefined

onMounted(() => {
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})

const dash = computed(() => store.dashboard)
const modeLabel = computed(() => {
  if (!dash.value) return ''
  if (dash.value.mode === 'gentle') return '温和弹窗'
  return dash.value.lockLevel === 'kiosk' ? '强制全屏 · Kiosk 级' : '强制全屏 · 应用级'
})

const nextText = computed(() => {
  const at = dash.value?.nextFireAt ?? null
  if (at === null) return '当前不在复习时段'
  return `${toHHMM(at)}　${formatCountdown(at, now.value)}`
})

const delayPips = computed(() => {
  const d = dash.value
  if (!d) return []
  return Array.from({ length: d.delayQuota }, (_, i) => i < d.delayQuota - d.delayUsed)
})

const dayTicks = computed(() => {
  const base = startOfDay(now.value)
  return { base, day: 86_400_000 }
})

const firedToday = computed(() =>
  (dash.value?.recentRounds ?? [])
    .filter((r) => r.plannedAt >= dayTicks.value.base)
    .map((r) => (r.plannedAt - dayTicks.value.base) / dayTicks.value.day)
)

function windowSpan(start: string, end: string): { left: number; width: number } {
  const toFrac = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return (h * 60 + (m || 0)) / 1440
  }
  const a = toFrac(start)
  const b = toFrac(end)
  return { left: a * 100, width: Math.max(0.5, (b - a) * 100) }
}

async function startNow(): Promise<void> {
  starting.value = true
  try {
    const result = await window.ganci.reviewStartNow()
    if (!result.ok) {
      const reason = result.reason === 'no_words' ? '词库里还没有可复习的单词，先去导入一份 CSV' : '已经有一轮复习在进行中'
      message[result.reason === 'no_words' ? 'warning' : 'info'](reason)
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : '启动失败')
  } finally {
    starting.value = false
    void store.refreshDashboard()
  }
}

const statusLabel: Record<string, string> = {
  done: '已完成',
  aborted: '中断',
  skipped: '跳过',
  empty: '无词',
  open: '进行中',
}

function modeChip(mode: string): ReviewMode | string {
  return mode === 'gentle' ? '弹窗' : '全屏'
}
</script>

<template>
  <div v-if="!dash" class="p-6 text-muted">加载中…</div>

  <div v-else class="mx-auto max-w-[900px] px-8 py-7">
    <header class="flex items-center justify-between">
      <h1 class="text-[20px] font-semibold">复习台</h1>
      <n-tag size="small" :bordered="false" type="success">{{ modeLabel }}</n-tag>
    </header>

    <section class="card-surface mt-5 p-6">
      <div class="text-[12px] text-muted">下一次提醒</div>
      <div class="num-display mt-1 text-[34px] font-semibold leading-tight text-accent">{{ nextText }}</div>

      <div class="mt-6 flex items-end justify-between gap-6">
        <div>
          <div class="text-[12px] text-muted">今日待复习</div>
          <div class="num-display mt-1 text-[30px] font-semibold leading-none">{{ dash.dueToday }}</div>
        </div>
        <div class="text-right">
          <div class="text-[12px] text-muted">今日已完成</div>
          <div class="num-display mt-1 text-[30px] font-semibold leading-none">
            {{ dash.wordsToday }}<span class="text-[14px] font-normal text-muted"> 词 / {{ dash.roundsToday }} 轮</span>
          </div>
        </div>
      </div>

      <div class="mt-6 flex gap-3">
        <n-button class="!py-6 flex-[2]" type="primary" size="large" :loading="starting" @click="startNow">
          立即开始复习
        </n-button>
        <n-button class="!py-6 flex-1" size="large" @click="router.push('/practice')">去练习</n-button>
      </div>
      <div class="mt-2 text-center text-[11px] text-muted">练习是自由打字模式，不计入复习进度</div>

      <div class="mt-4 flex items-center justify-between text-[12px]">
        <div class="flex items-center gap-2 text-muted">
          <span>延后余量</span>
          <span class="flex gap-1">
            <span
              v-for="(filled, i) in delayPips"
              :key="i"
              class="inline-block h-2.5 w-2.5 rounded-full"
              :class="filled ? 'bg-brand' : 'bg-line'"
            />
          </span>
          <span class="num-display">剩 {{ dash.delayQuota - dash.delayUsed }} / {{ dash.delayQuota }} 次</span>
          <span v-if="dash.delayQuota - dash.delayUsed <= 0" class="font-semibold text-danger">今日延后已用尽</span>
        </div>
        <div class="text-muted">每次推迟 {{ dash.delayMinutes }} 分钟</div>
      </div>
    </section>

    <section class="mt-4 grid grid-cols-3 gap-4">
      <div class="card-surface px-4 py-3.5">
        <div class="text-[12px] text-muted">已掌握</div>
        <div class="num-display mt-1 text-[20px] font-semibold">{{ dash.mastered }}</div>
      </div>
      <div class="card-surface px-4 py-3.5">
        <div class="text-[12px] text-muted">未开始的新词</div>
        <div class="num-display mt-1 text-[20px] font-semibold">{{ dash.fresh }}</div>
      </div>
      <div class="card-surface px-4 py-3.5">
        <div class="text-[12px] text-muted">待补充释义</div>
        <div class="num-display mt-1 text-[20px] font-semibold" :class="dash.needMeaning ? 'text-accent' : ''">
          {{ dash.needMeaning }}
        </div>
      </div>
    </section>

    <section v-if="dash.totalWords === 0" class="card-surface mt-4 px-5 py-6 text-center">
      <div class="text-[14px]">词库还是空的，先导入一份 CSV 词表</div>
      <n-button class="mt-3" type="primary" @click="router.push('/words')">去导入词表</n-button>
    </section>

    <section v-else class="card-surface mt-4 p-5">
      <div class="text-[13px] font-semibold">今日时段</div>
      <div class="relative mt-3 h-7 rounded bg-canvas">
        <div
          v-for="w in dash.windows"
          :key="w.id"
          class="absolute top-0 h-full rounded bg-brand/15"
          :style="windowSpan(w.start, w.end)"
        >
          <span class="absolute -top-0.5 left-1 text-[10px] leading-7 text-brand">{{ w.start }}</span>
        </div>
        <span
          v-for="(frac, i) in firedToday"
          :key="`f${i}`"
          class="absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-accent"
          :style="{ left: `${frac * 100}%` }"
        />
        <span class="absolute top-0 h-full w-px bg-ink/40" :style="{ left: `${((now - dayTicks.base) / dayTicks.day) * 100}%` }" />
      </div>
      <div class="num-display mt-1.5 flex justify-between text-[10px] text-muted">
        <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span>
      </div>
    </section>

    <section v-if="dash.recentRounds.length" class="card-surface mt-4 overflow-hidden">
      <div class="px-5 pt-4 pb-2 text-[13px] font-semibold">最近几轮</div>
      <table class="w-full text-[12px]">
        <tbody>
          <tr v-for="r in dash.recentRounds" :key="r.id" class="border-t border-line">
            <td class="num-display px-5 py-2 text-muted">{{ toHHMM(r.plannedAt) }}</td>
            <td class="px-2 py-2">{{ modeChip(r.mode) }}</td>
            <td class="num-display px-2 py-2">{{ r.rated }}/{{ r.planned }} 词</td>
            <td class="num-display px-2 py-2">{{ r.knowRate === null ? '—' : `${r.knowRate}% 认识` }}</td>
            <td class="px-5 py-2 text-right text-muted">{{ statusLabel[r.status] ?? r.status }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>
