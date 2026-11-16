<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref } from 'vue'
import { NDataTable, type DataTableColumns } from 'naive-ui'
import type { StatsOverview } from '@shared/types'
import { formatCountdown } from '@shared/time'

const stats = ref<StatsOverview | null>(null)
const loading = ref(false)
const now = ref(Date.now())

async function reload(): Promise<void> {
  loading.value = true
  try {
    stats.value = await window.ganci.statsOverview()
  } finally {
    loading.value = false
  }
}

let unsubscribe: (() => void) | null = null
let ticker: number | undefined
onMounted(async () => {
  await reload()
  unsubscribe = window.ganci.onDataChanged(() => void reload())
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => {
  unsubscribe?.()
  if (ticker) clearInterval(ticker)
})

const metrics = computed(() => {
  const s = stats.value
  return [
    { label: '今日复习词数', value: s ? String(s.wordsToday) : '—', tone: 'text-ink' },
    { label: '今日认识率', value: s ? percent(s.knowRateToday) : '—', tone: 'text-brand' },
    { label: '连续打卡', value: s ? `${s.streak} 天` : '—', tone: 'text-accent' },
    { label: '完成轮次', value: s ? String(s.roundsDone) : '—', tone: 'text-ink' },
  ]
})

/** 主进程统一给出 0–100 的百分比 */
function percent(rate: number | null): string {
  return rate === null ? '—' : `${Math.round(rate)}%`
}

const maxWords = computed(() => Math.max(1, ...(stats.value?.daily.map((d) => d.words) ?? [1])))

const bars = computed(() =>
  (stats.value?.daily ?? []).map((d) => {
    const unknown = Math.max(0, d.words - d.known)
    return {
      day: d.day.slice(5),
      words: d.words,
      known: d.known,
      unknown,
      totalHeight: d.words === 0 ? 2 : Math.max(6, Math.round((d.words / maxWords.value) * 100)),
      knownHeight: d.words === 0 ? 0 : Math.round((d.known / d.words) * 100),
      rate: percent(d.rate),
    }
  })
)

const nextFireLabel = computed(() => {
  const at = stats.value?.nextFireAt ?? null
  return at ? `${formatCountdown(at, now.value)} · ${stats.value?.settings.mode === 'fullscreen' ? '强制全屏' : '温和弹窗'}` : '暂无排程'
})

type LapseRow = StatsOverview['topLapses'][number]

const columns = computed<DataTableColumns<LapseRow>>(() => [
  { title: '#', key: 'i', width: 44, render: (_r, i) => h('span', { class: 'num-display text-muted' }, String(i + 1)) },
  { title: '单词', key: 'term', width: 140, render: (r) => h('span', { class: 'font-term text-[13px] font-semibold' }, r.term) },
  { title: '释义', key: 'meaning', ellipsis: { tooltip: true }, render: (r) => h('span', { class: 'text-ink/80' }, r.meaning) },
  {
    title: '遗忘',
    key: 'lapses',
    width: 66,
    render: (r) => h('span', { class: 'num-display text-danger' }, String(r.lapses)),
  },
  { title: '复习', key: 'reps', width: 66, render: (r) => h('span', { class: 'num-display text-ink/80' }, String(r.reps)) },
  {
    title: '间隔',
    key: 'intervalDays',
    width: 66,
    render: (r) => h('span', { class: 'num-display text-ink/80' }, r.intervalDays ? `${r.intervalDays}天` : '—'),
  },
])
</script>

<template>
  <div class="mx-auto max-w-[980px] px-8 py-7">
    <header class="flex items-center justify-between">
      <h1 class="text-[20px] font-semibold">统计</h1>
      <div class="text-[12px] text-muted">下一次提醒：{{ nextFireLabel }}</div>
    </header>

    <div class="mt-5 grid grid-cols-4 gap-3">
      <div v-for="m in metrics" :key="m.label" class="card-surface px-4 py-3">
        <div class="text-[12px] text-muted">{{ m.label }}</div>
        <div class="num-display mt-1 text-[24px] font-semibold" :class="m.tone">{{ m.value }}</div>
      </div>
    </div>

    <section class="card-surface mt-4 px-5 py-4">
      <div class="flex items-center justify-between">
        <h2 class="text-[14px] font-semibold">近 14 天</h2>
        <div class="flex items-center gap-3 text-[12px] text-muted">
          <span><i class="mr-1 inline-block h-2 w-2 rounded-sm bg-brand align-middle"></i>认识</span>
          <span><i class="mr-1 inline-block h-2 w-2 rounded-sm bg-danger/70 align-middle"></i>不认识</span>
        </div>
      </div>
      <div class="mt-4 flex h-[150px] items-end gap-1.5">
        <div v-for="b in bars" :key="b.day" class="group relative flex-1" :title="`${b.day} · ${b.words} 词 · 认识率 ${b.rate}`">
          <div class="flex flex-col justify-end overflow-hidden rounded-t-sm" :style="{ height: `${b.totalHeight}%` }">
            <div class="w-full bg-danger/70" :style="{ height: `${100 - b.knownHeight}%` }"></div>
            <div class="w-full bg-brand" :style="{ height: `${b.knownHeight}%` }"></div>
          </div>
          <div class="mt-1 text-center text-[10px] text-muted">{{ b.day }}</div>
        </div>
      </div>
      <div v-if="!bars.length" class="py-8 text-center text-[13px] text-muted">还没有复习记录，先完成第一轮。</div>
    </section>

    <section class="card-surface mt-4 px-5 py-4">
      <h2 class="text-[14px] font-semibold">最容易忘记的词</h2>
      <p class="mt-1 text-[12px] text-muted">按遗忘次数排序。这些词会被更频繁地抽出来，直到连续答对把间隔拉起来。</p>
      <n-data-table
        class="mt-3"
        size="small"
        :columns="columns"
        :data="stats?.topLapses ?? []"
        :loading="loading"
        :row-key="(r: LapseRow) => r.term"
        :pagination="false"
        max-height="320px"
      />
    </section>

    <section class="card-surface mt-4 px-5 py-4">
      <h2 class="text-[14px] font-semibold">词库构成</h2>
      <div class="mt-3 grid grid-cols-5 gap-3 text-[13px]">
        <div>总计 <b class="num-display block text-[18px]">{{ stats?.counts.total ?? 0 }}</b></div>
        <div>已掌握 <b class="num-display block text-[18px] text-brand">{{ stats?.counts.mastered ?? 0 }}</b></div>
        <div>新词 <b class="num-display block text-[18px]">{{ stats?.counts.fresh ?? 0 }}</b></div>
        <div>今日到期 <b class="num-display block text-[18px] text-accent">{{ stats?.counts.dueNow ?? 0 }}</b></div>
        <div>缺释义 <b class="num-display block text-[18px] text-danger">{{ stats?.counts.needMeaning ?? 0 }}</b></div>
      </div>
      <div class="mt-3 text-[12px] text-muted">
        延后：今日已用 {{ stats?.delay.used ?? 0 }} / {{ stats?.delay.quota ?? 0 }} 次，还剩 {{ stats?.delay.left ?? 0 }} 次。
      </div>
    </section>
  </div>
</template>
