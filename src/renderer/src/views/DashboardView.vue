<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Component } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NModal, NSelect, useDialog, useMessage } from 'naive-ui'
import {
  AlertCircleOutline,
  AnalyticsOutline,
  ArrowForwardOutline,
  CheckmarkCircleOutline,
  CreateOutline,
  LayersOutline,
  LibraryOutline,
  TimeOutline,
} from '@vicons/ionicons5'
import { useAppStore } from '@renderer/stores/app'
import { formatCountdown, toHHMM } from '@shared/time'
import type { ListInfo, PracticeScope } from '@shared/types'

const store = useAppStore()
const router = useRouter()
const message = useMessage()
const dialog = useDialog()
const lists = ref<ListInfo[]>([])
const now = ref(Date.now())
const startingReview = ref(false)
const showPractice = ref(false)
const practiceScope = ref<PracticeScope>('dueToday')
const scopeCounts = ref<Record<string, number>>({})
const countsLoading = ref(false)
let ticker: number | undefined
let unsubscribe: (() => void) | null = null

interface PracticeScopeMeta {
  id: PracticeScope
  name: string
  desc: string
  icon: Component
}

const PRACTICE_SCOPES: PracticeScopeMeta[] = [
  { id: 'dueToday', name: '今日要复习', desc: '今天到期和已经到期的单词', icon: TimeOutline },
  { id: 'learnedToday', name: '今日学过', desc: '今天背过或复习过的单词', icon: CheckmarkCircleOutline },
  { id: 'wrong', name: '打错过', desc: '累计答错过的单词，错得多的排前面', icon: AlertCircleOutline },
  { id: 'learned', name: '已经学过', desc: '进入过学习或复习的单词', icon: LibraryOutline },
  { id: 'all', name: '全部单词', desc: '词库里所有带释义的单词', icon: LayersOutline },
]

const REASON_LABEL: Record<string, string> = {
  scheduled: '按计划提醒',
  delayed: '已延后',
  out_of_words: '暂时没有待学单词',
  no_due: '暂无待复习单词',
  paused: '不在复习时段',
  learning: '学习中 · 提醒已暂停',
  idle: '调度未启动',
}

const statusLabel: Record<string, string> = {
  done: '已完成',
  aborted: '中断',
  skipped: '跳过',
  open: '进行中',
}

const dash = computed(() => store.dashboard)
const listOptions = computed(() => [
  { label: '全部词库', value: 0 },
  ...lists.value.map((l) => ({ label: `${l.name}（${l.wordCount}）`, value: l.id })),
])
const listChoice = computed({
  get: () => dash.value?.activeListId ?? 0,
  set: (value: number) => void switchList(value),
})
const activeName = computed(() => dash.value?.activeListName || '全部词库')
const greeting = computed(() => {
  const hour = new Date(now.value).getHours()
  if (hour < 6) return '夜深了'
  if (hour < 12) return '早上好'
  if (hour < 18) return '下午好'
  return '晚上好'
})
const dateText = computed(() =>
  new Date(now.value).toLocaleDateString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
)
const modeLabel = computed(() => {
  if (!dash.value) return ''
  if (dash.value.mode === 'gentle') return '温和弹窗'
  return dash.value.lockLevel === 'kiosk' ? '强制全屏 · Kiosk' : '强制全屏'
})
const nextAt = computed(() => dash.value?.nextFireAt ?? null)
const nextCountdown = computed(() => (nextAt.value === null ? '' : formatCountdown(nextAt.value, now.value)))
const nextReason = computed(
  () => REASON_LABEL[dash.value?.nextFireReason ?? 'idle'] ?? '未排程'
)
const masteredPct = computed(() => {
  const d = dash.value
  if (!d || d.totalWords === 0) return 0
  return Math.min(100, Math.round((d.mastered / d.totalWords) * 100))
})
const delayPips = computed(() => {
  const d = dash.value
  if (!d) return []
  return Array.from({ length: d.delayQuota }, (_, i) => i < d.delayQuota - d.delayUsed)
})
const canLearn = computed(() => (dash.value?.totalWords ?? 0) > 0 && (dash.value?.fresh ?? 0) > 0)
const dailyTarget = computed(() => dash.value?.dailyNewWords ?? 0)
const newToday = computed(() => dash.value?.newToday ?? 0)
const targetDone = computed(() => dailyTarget.value > 0 && newToday.value >= dailyTarget.value)
/** 加练一批的数量，与后端单轮上限对齐 */
const EXTRA_BATCH = 10
const extraCount = computed(() => Math.min(EXTRA_BATCH, dash.value?.fresh ?? 0))
const newWordsCleared = computed(() => (dash.value?.fresh ?? 0) === 0)
const showReviewCta = computed(
  () => (targetDone.value || newWordsCleared.value) && (dash.value?.reviewDue ?? 0) > 0
)
const heroCopy = computed(() => {
  const d = dash.value
  if (!d) return ''
  if (d.totalWords === 0) return '这本词书还是空的，先导入词表或切换词书'
  if (targetDone.value) {
    return d.fresh > 0
      ? `每日目标 ${d.dailyNewWords} 个已完成，学得动就再来一批`
      : '今天的新词已经学完，去复习巩固记忆'
  }
  if (d.fresh === 0) return '词库里的新词已经学完，去复习巩固记忆'
  return `每日新词目标 ${d.dailyNewWords} 个 · 今日已学 ${d.newToday} 个`
})
const heroCta = computed(() => {
  const d = dash.value
  if (!d) return ''
  if (d.totalWords === 0) return '去导入词表'
  if (d.fresh === 0) return '新词已学完'
  return targetDone.value ? `再学习 ${extraCount.value} 个新单词` : '开始背单词'
})

onMounted(async () => {
  ticker = window.setInterval(() => {
    now.value = Date.now()
  }, 1000)
  await reloadLists()
  unsubscribe = window.ganci.onDataChanged(() => {
    void reloadLists()
  })
})

onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
  unsubscribe?.()
})

async function reloadLists(): Promise<void> {
  try {
    lists.value = await window.ganci.listsList()
  } catch {
    /* 词库没读到不阻塞首页 */
  }
}

async function switchList(value: number): Promise<void> {
  await store.save({ activeListId: value || null })
}

async function startReview(): Promise<void> {
  startingReview.value = true
  try {
    const result = await window.ganci.reviewStartNow('due')
    if (!result.ok) {
      if (result.reason === 'already_running') {
        message.info('已经有一轮在进行了')
      } else {
        message.warning('现在没有到期的单词，稍后调度器会提醒你')
      }
    }
  } catch (err) {
    message.error(err instanceof Error ? err.message : '启动失败')
  } finally {
    startingReview.value = false
    void store.refreshDashboard()
  }
}

const selectedScopeCount = computed(() => scopeCounts.value[practiceScope.value] ?? 0)

const practiceHint = computed(() => {
  if (countsLoading.value) return '正在统计各范围的单词…'
  if (selectedScopeCount.value === 0) return '这个范围还没有单词，换一个试试'
  return `本轮最多抽 ${Math.min(20, selectedScopeCount.value)} 个词 · 不计入复习进度`
})

async function openPractice(): Promise<void> {
  showPractice.value = true
  countsLoading.value = true
  scopeCounts.value = {}
  try {
    const listId = store.settings.activeListId ?? null
    const results = await Promise.all(
      PRACTICE_SCOPES.map((scope) => window.ganci.wordsList({ listId, scope: scope.id, limit: 1 }))
    )
    const next: Record<string, number> = {}
    PRACTICE_SCOPES.forEach((scope, i) => {
      next[scope.id] = results[i].total
    })
    scopeCounts.value = next
    const first = PRACTICE_SCOPES.find((scope) => (next[scope.id] ?? 0) > 0)
    if (first) practiceScope.value = first.id
  } catch (err) {
    message.error(err instanceof Error ? err.message : '读取练习范围失败')
  } finally {
    countsLoading.value = false
  }
}

function startPractice(): void {
  if (selectedScopeCount.value === 0) return
  showPractice.value = false
  void router.push({ path: '/practice', query: { scope: practiceScope.value } })
}

const NUDGE_KEY = 'ganci.review-first-nudge'

function dayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 每天第一次点「学新词」时，若还有到期未复习的词，先劝一轮 */
function goPrimary(): void {
  const d = dash.value
  if (!d) return
  if (d.totalWords === 0) {
    router.push('/words')
    return
  }
  if (!canLearn.value) return
  const target = targetDone.value ? '/learn?extra=1' : '/learn'
  const proceed = () => router.push(target)
  if (d.fresh > 0 && d.dueToday > 0 && localStorage.getItem(NUDGE_KEY) !== dayKey()) {
    localStorage.setItem(NUDGE_KEY, dayKey())
    dialog.warning({
      title: `今日还有 ${d.dueToday} 个单词未复习`,
      content: '先按遗忘曲线把到期的旧词复习一遍，再学新词记得更牢；也可以先学新词，回头再补复习。',
      positiveText: '去复习',
      negativeText: '先学新词',
      maskClosable: false,
      onPositiveClick: () => {
        void startReview()
      },
      onNegativeClick: proceed,
    })
    return
  }
  proceed()
}
</script>

<template>
  <div v-if="!dash" class="p-6 text-muted">加载中…</div>

  <div v-else class="dash">
    <header class="dash-head">
      <div>
        <div class="eyebrow">{{ dateText }}</div>
        <h1 class="greeting">{{ greeting }}</h1>
        <div class="subline">今天也把新词啃下来</div>
      </div>
      <div class="head-side">
        <n-select
          v-model:value="listChoice"
          size="small"
          style="width: 200px"
          :options="listOptions"
          :consistent-menu-width="false"
        />
        <span class="mode-chip"><span class="dot" />{{ modeLabel }}</span>
      </div>
    </header>

    <section class="hero">
      <div class="hero-main">
        <div class="hero-eyebrow">
          今日新词
          <span class="hero-list">{{ activeName }}</span>
          <span class="hero-goal" :class="{ done: targetDone }">
            今日 {{ dash.newToday }} / {{ dash.dailyNewWords }}
          </span>
        </div>
        <div class="hero-count">
          <span class="hero-num">{{ dash.fresh }}</span>
          <span class="hero-unit">个新词</span>
        </div>
        <p class="hero-copy">{{ heroCopy }}</p>
        <div class="hero-actions">
          <button class="btn btn-primary" :disabled="!canLearn && dash.totalWords > 0" @click="goPrimary">
            {{ heroCta }}
            <n-icon :component="ArrowForwardOutline" :size="16" />
          </button>
          <button v-if="showReviewCta" class="btn btn-ghost" :disabled="startingReview" @click="startReview">
            {{ startingReview ? '启动中…' : `去复习 ${dash.reviewDue} 个单词` }}
          </button>
          <button v-else class="btn btn-ghost" @click="router.push('/words')">管理词库</button>
        </div>
      </div>

      <div class="hero-side">
        <div class="hero-stat">
          <span>今日已学</span>
          <div><b>{{ dash.wordsToday }}</b><em>词</em></div>
        </div>
        <div class="hero-stat">
          <span>完成轮次</span>
          <div><b>{{ dash.roundsToday }}</b><em>轮</em></div>
        </div>
        <div class="hero-stat">
          <span>已掌握</span>
          <div><b>{{ dash.mastered }}</b><em>词</em></div>
        </div>
        <div class="hero-progress">
          <div class="hero-progress-head">
            <span>掌握进度</span>
            <span>{{ dash.mastered }} / {{ dash.totalWords }}</span>
          </div>
          <div class="track">
            <div class="fill" :style="{ width: `${masteredPct}%` }" />
          </div>
        </div>
      </div>

      <div class="hero-mark" aria-hidden="true">词</div>
    </section>

    <section class="grid-row">
      <div class="panel review-panel">
        <div class="panel-head">
          <span class="eyebrow">复习节奏</span>
          <button class="mini-btn" :disabled="dash.reviewDue === 0 || startingReview" @click="startReview">
            {{ startingReview ? '启动中…' : dash.reviewDue > 0 ? '立即复习' : dash.dueToday > 0 ? '等待到期' : '暂无到期' }}
          </button>
        </div>
        <div class="review-time">
          <span class="review-clock">{{ nextAt ? toHHMM(nextAt) : '—' }}</span>
          <span v-if="nextAt" class="review-countdown">{{ nextCountdown }}</span>
        </div>
        <div class="review-reason">{{ nextReason }}</div>
        <div class="review-line" />
        <div class="review-foot">
          <div class="due">
            <span class="eyebrow">今日待复习</span>
            <div><b>{{ dash.dueToday }}</b><em>词</em></div>
          </div>
          <div class="delay">
            <span class="eyebrow">延后余量</span>
            <div class="pips">
              <i v-for="(filled, i) in delayPips" :key="i" :class="{ on: filled }" />
            </div>
            <span class="delay-note">剩 {{ dash.delayQuota - dash.delayUsed }}/{{ dash.delayQuota }} · 每次 {{ dash.delayMinutes }} 分钟</span>
          </div>
        </div>
        <div v-if="dash.dueTomorrow > 0 || dash.dueAfterTomorrow > 0" class="review-plan">
          <span>明天 <b>{{ dash.dueTomorrow }}</b> 词</span>
          <span>后天 <b>{{ dash.dueAfterTomorrow }}</b> 词</span>
        </div>
      </div>

      <button
        class="panel wrong-panel"
        :class="{ 'is-active': dash.wrongTotal > 0 }"
        @click="router.push('/wrongs')"
      >
        <div class="panel-head">
          <span class="eyebrow">错词本</span>
          <n-icon
            :component="dash.wrongTotal > 0 ? AlertCircleOutline : CheckmarkCircleOutline"
            :size="16"
            :class="dash.wrongTotal > 0 ? 'text-danger' : 'text-brand'"
          />
        </div>
        <div class="wrong-count">{{ dash.wrongTotal }}</div>
        <div class="wrong-copy">
          {{ dash.wrongTotal > 0 ? `今日答错 ${dash.wrongToday} 个 · 只有手动移出才会消失` : '还没答错过，保持住' }}
        </div>
        <div class="wrong-link">
          查看错词本
          <n-icon :component="ArrowForwardOutline" :size="13" />
        </div>
      </button>

      <div class="panel tools-panel">
        <div class="panel-head"><span class="eyebrow">工具</span></div>
        <button class="tool-row" @click="router.push('/words')">
          <n-icon :component="LibraryOutline" :size="15" />
          <span class="tool-name">词库</span>
          <span class="tool-meta">{{ lists.length }} 个词表</span>
        </button>
        <button class="tool-row" @click="openPractice">
          <n-icon :component="CreateOutline" :size="15" />
          <span class="tool-name">打字练习</span>
          <span class="tool-meta">不计进度</span>
        </button>
        <button class="tool-row" @click="router.push('/stats')">
          <n-icon :component="AnalyticsOutline" :size="15" />
          <span class="tool-name">学习统计</span>
          <span class="tool-meta">连贯天数</span>
        </button>
        <div class="tools-foot">待补充释义 {{ dash.needMeaning }} 条</div>
      </div>
    </section>

    <section class="panel rounds-panel">
      <div class="panel-head">
        <span class="eyebrow">最近几轮</span>
        <button class="text-link" @click="router.push('/stats')">全部统计 →</button>
      </div>
      <div v-if="dash.recentRounds.length" class="rounds">
        <div class="rounds-head">
          <span>时间</span>
          <span>完成</span>
          <span>正确率</span>
          <span>状态</span>
        </div>
        <div v-for="r in dash.recentRounds.slice(0, 4)" :key="r.id" class="round-row">
          <span class="num-display">{{ toHHMM(r.plannedAt) }}</span>
          <span class="num-display">{{ r.rated }}/{{ r.planned }}</span>
          <span class="num-display">{{ r.knowRate === null ? '—' : `${r.knowRate}%` }}</span>
          <span class="round-status" :class="`is-${r.status}`">{{ statusLabel[r.status] ?? r.status }}</span>
        </div>
      </div>
      <div v-else class="rounds-empty">还没有完成过复习，先背一轮新词吧</div>
    </section>

    <n-modal
      v-model:show="showPractice"
      preset="card"
      title="打字练习"
      style="width: 540px; max-width: calc(100vw - 40px)"
    >
      <p class="scope-hint">选一个范围，逐个敲出单词；打错的字母会标红。</p>
      <div class="scope-list" role="radiogroup" aria-label="练习范围">
        <button
          v-for="scope in PRACTICE_SCOPES"
          :key="scope.id"
          type="button"
          role="radio"
          class="scope-card"
          :class="{ 'is-active': practiceScope === scope.id, 'is-wrong': scope.id === 'wrong' }"
          :aria-checked="practiceScope === scope.id"
          :disabled="!countsLoading && (scopeCounts[scope.id] ?? 0) === 0"
          @click="practiceScope = scope.id"
        >
          <span class="scope-ico">
            <n-icon :component="scope.icon" :size="16" />
          </span>
          <span class="scope-body">
            <span class="scope-name">{{ scope.name }}</span>
            <span class="scope-desc">{{ scope.desc }}</span>
          </span>
          <span class="scope-count">{{ countsLoading ? '…' : `${scopeCounts[scope.id] ?? 0} 词` }}</span>
          <span class="scope-radio" aria-hidden="true" />
        </button>
      </div>
      <template #footer>
        <div class="pm-foot">
          <span class="pm-hint">{{ practiceHint }}</span>
          <div class="pm-actions">
            <n-button @click="showPractice = false">取消</n-button>
            <n-button
              type="primary"
              :disabled="countsLoading || selectedScopeCount === 0"
              @click="startPractice"
            >
              开始练习
            </n-button>
          </div>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.dash {
  margin: 0 auto;
  max-width: 1180px;
  padding: 26px 30px 28px;
}

.eyebrow {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--color-muted);
}

.dash-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 18px;
}

.greeting {
  margin: 5px 0 0;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--color-ink);
}

.subline {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-muted);
}

.head-side {
  display: flex;
  align-items: center;
  gap: 10px;
}

.mode-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-line);
  border-radius: 999px;
  background: var(--color-surface);
  padding: 5px 11px;
  font-size: 10.5px;
  color: var(--color-muted);
  white-space: nowrap;
}

.mode-chip .dot {
  height: 5px;
  width: 5px;
  border-radius: 50%;
  background: var(--color-brand);
}

.hero {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.5fr) minmax(240px, 1fr);
  gap: 30px;
  overflow: hidden;
  border-radius: 18px;
  padding: 24px 30px;
  background:
    radial-gradient(
      120% 160% at 88% -30%,
      color-mix(in srgb, var(--color-brand-fill) 58%, #0e2a1f) 0%,
      transparent 55%
    ),
    linear-gradient(
      140deg,
      color-mix(in srgb, var(--color-brand-fill) 46%, #0c241a) 0%,
      color-mix(in srgb, var(--color-brand-fill) 30%, #081b14) 100%
    );
  color: #f6f1e4;
  box-shadow:
    0 18px 40px color-mix(in srgb, var(--color-brand-press) 28%, transparent),
    inset 0 1px 0 rgb(255 255 255 / 0.08);
}

.hero-main,
.hero-side {
  position: relative;
  z-index: 1;
}

.hero-eyebrow {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: rgb(246 241 228 / 0.55);
}

.hero-list {
  padding-left: 10px;
  border-left: 1px solid rgb(246 241 228 / 0.2);
  font-weight: 500;
  letter-spacing: 0.02em;
  color: rgb(246 241 228 / 0.75);
}

.hero-goal {
  border: 1px solid rgb(246 241 228 / 0.2);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: rgb(246 241 228 / 0.7);
  font-variant-numeric: tabular-nums;
}

.hero-goal.done {
  border-color: rgb(217 169 98 / 0.55);
  background: rgb(217 169 98 / 0.14);
  color: #ecd3a6;
}

.hero-count {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 8px;
}

.hero-num {
  font-family: var(--font-term);
  font-size: 58px;
  font-weight: 600;
  line-height: 0.92;
  letter-spacing: -0.02em;
  color: #f7f2e5;
  font-variant-numeric: tabular-nums;
}

.hero-unit {
  font-size: 14px;
  color: rgb(246 241 228 / 0.62);
}

.hero-copy {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: rgb(246 241 228 / 0.66);
}

.hero-actions {
  display: flex;
  gap: 10px;
  margin-top: 15px;
}

.btn {
  display: inline-flex;
  height: 38px;
  align-items: center;
  gap: 8px;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 0 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease, transform 140ms ease;
}

.btn:active:not(:disabled) {
  transform: translateY(1px);
}

.btn-primary {
  background: #f2e7cd;
  color: color-mix(in srgb, var(--color-brand-fill) 62%, #0b1d14);
  box-shadow: 0 6px 18px rgb(0 0 0 / 0.16);
}

.btn-primary:hover:not(:disabled) {
  background: #fffaf0;
}

.btn-primary:disabled {
  opacity: 0.42;
  cursor: not-allowed;
  box-shadow: none;
}

.btn-ghost {
  background: transparent;
  border-color: rgb(246 241 228 / 0.24);
  color: rgb(246 241 228 / 0.85);
}

.btn-ghost:hover {
  background: rgb(255 255 255 / 0.05);
  border-color: rgb(246 241 228 / 0.45);
}

.hero-side {
  display: flex;
  flex-direction: column;
  justify-content: center;
  border-left: 1px solid rgb(246 241 228 / 0.14);
  padding-left: 30px;
}

.hero-stat {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid rgb(246 241 228 / 0.1);
}

.hero-stat span {
  font-size: 11px;
  letter-spacing: 0.08em;
  color: rgb(246 241 228 / 0.55);
}

.hero-stat b {
  font-family: var(--font-term);
  font-size: 22px;
  font-weight: 600;
  color: #f6f1e4;
  font-variant-numeric: tabular-nums;
}

.hero-stat em {
  margin-left: 4px;
  font-size: 11px;
  font-style: normal;
  color: rgb(246 241 228 / 0.5);
}

.hero-progress {
  margin-top: 13px;
}

.hero-progress-head {
  display: flex;
  justify-content: space-between;
  font-size: 10.5px;
  color: rgb(246 241 228 / 0.55);
}

.track {
  height: 4px;
  margin-top: 6px;
  overflow: hidden;
  border-radius: 999px;
  background: rgb(246 241 228 / 0.14);
}

.fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #d9a962, #ecd3a6);
  transition: width 300ms ease;
}

.hero-mark {
  position: absolute;
  top: -38px;
  right: 18px;
  font-family: var(--font-term);
  font-size: 190px;
  line-height: 1;
  color: rgb(246 241 228 / 0.045);
  pointer-events: none;
  user-select: none;
}

.grid-row {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(0, 0.95fr) minmax(0, 0.95fr);
  gap: 14px;
  margin-top: 14px;
}

.panel {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  padding: 16px 18px;
  box-shadow: 0 1px 2px rgb(28 36 31 / 0.03);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.review-time {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-top: 10px;
}

.review-clock {
  font-family: var(--font-term);
  font-size: 32px;
  line-height: 1;
  letter-spacing: -0.01em;
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
}

.review-countdown {
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-raised));
  padding: 3px 8px;
  font-size: 11px;
  color: color-mix(in srgb, var(--color-accent) 72%, var(--color-ink));
}

.review-reason {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--color-muted);
}

.review-line {
  height: 1px;
  margin: 13px 0 12px;
  background: var(--color-line);
}

.review-foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 14px;
}

.due b {
  display: inline-block;
  margin-top: 2px;
  font-family: var(--font-term);
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.due em {
  margin-left: 3px;
  font-size: 11px;
  font-style: normal;
  color: var(--color-muted);
}

.delay {
  text-align: right;
}

.pips {
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  margin-top: 7px;
}

.pips i {
  height: 4px;
  width: 14px;
  border-radius: 2px;
  background: var(--color-line);
}

.pips i.on {
  background: var(--color-brand);
}

.delay-note {
  display: block;
  margin-top: 5px;
  font-size: 10.5px;
  color: var(--color-muted);
}

.review-plan {
  display: flex;
  gap: 14px;
  margin-top: 10px;
  font-size: 10.5px;
  color: var(--color-muted);
}

.review-plan b {
  font-family: var(--font-term);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
}

.mini-btn {
  border: 1px solid color-mix(in srgb, var(--color-brand) 30%, var(--color-raised));
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-brand) 8%, var(--color-raised));
  padding: 5px 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-brand);
  cursor: pointer;
  transition: background-color 140ms ease;
}

.mini-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-brand) 14%, var(--color-raised));
}

.mini-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.wrong-panel {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  text-align: left;
  font: inherit;
  color: inherit;
  cursor: pointer;
  transition: border-color 140ms ease, transform 140ms ease, background-color 140ms ease;
}

.wrong-panel:hover {
  border-color: color-mix(in srgb, var(--color-brand) 35%, var(--color-raised));
  transform: translateY(-1px);
}

.wrong-panel.is-active {
  border-color: color-mix(in srgb, var(--color-danger) 26%, var(--color-raised));
  background: linear-gradient(165deg, var(--color-surface), color-mix(in srgb, var(--color-danger) 4%, var(--color-raised)));
}

.wrong-count {
  margin-top: 8px;
  font-family: var(--font-term);
  font-size: 40px;
  line-height: 1;
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
}

.wrong-panel.is-active .wrong-count {
  color: var(--color-danger);
}

.wrong-copy {
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--color-muted);
}

.wrong-link {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: auto;
  padding-top: 12px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--color-brand);
}

.tools-panel {
  display: flex;
  flex-direction: column;
}

.tool-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  border-top: 1px solid var(--color-line);
  background: transparent;
  padding: 7px 0;
  font-size: 12px;
  color: var(--color-ink);
  text-align: left;
  cursor: pointer;
}

.tool-row:first-of-type {
  margin-top: 6px;
}

.tool-row:hover .tool-name {
  color: var(--color-brand);
}

.tool-name {
  font-weight: 600;
}

.tool-meta {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--color-muted);
}

.tools-foot {
  margin-top: auto;
  padding-top: 10px;
  border-top: 1px dashed var(--color-line);
  font-size: 10.5px;
  color: var(--color-muted);
}

.rounds-panel {
  margin-top: 14px;
  padding-bottom: 10px;
}

.rounds {
  margin-top: 8px;
}

.rounds-head,
.round-row {
  display: grid;
  grid-template-columns: 100px 160px 160px minmax(0, 1fr);
  align-items: center;
}

.rounds-head {
  border-bottom: 1px solid var(--color-line);
  padding: 6px 0;
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--color-muted);
}

.rounds-head span:last-child {
  text-align: right;
}

.round-row {
  border-bottom: 1px solid color-mix(in srgb, var(--color-line) 65%, transparent);
  padding: 8px 0;
  font-size: 12.5px;
}

.round-row:last-child {
  border-bottom: 0;
}

.round-status {
  justify-self: end;
  border-radius: 999px;
  background: var(--color-canvas);
  padding: 2px 8px;
  font-size: 10.5px;
  color: var(--color-muted);
}

.round-status.is-done {
  background: color-mix(in srgb, var(--color-brand) 9%, var(--color-raised));
  color: var(--color-brand);
}

.round-status.is-aborted {
  background: color-mix(in srgb, var(--color-danger) 8%, var(--color-raised));
  color: var(--color-danger);
}

.round-status.is-skipped {
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-raised));
  color: color-mix(in srgb, var(--color-accent) 72%, var(--color-ink));
}

.text-link {
  border: 0;
  background: transparent;
  padding: 0;
  font-size: 11px;
  color: var(--color-muted);
  cursor: pointer;
}

.text-link:hover {
  color: var(--color-brand);
}

.rounds-empty {
  padding: 18px 0 12px;
  font-size: 12px;
  color: var(--color-muted);
}

@media (max-width: 1120px) {
  .grid-row {
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
  }

  .tools-panel {
    grid-column: 1 / -1;
  }

  .tools-panel .tool-row {
    display: inline-flex;
    gap: 7px;
    border-top: 0;
    padding: 7px 14px 0 0;
  }

  .tools-panel .tool-row:first-of-type {
    margin-top: 8px;
  }

  .tools-foot {
    margin-top: 10px;
  }
}

@media (max-width: 980px) {
  .dash {
    padding: 22px;
  }

  .hero {
    grid-template-columns: minmax(0, 1fr);
    gap: 18px;
  }

  .hero-side {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0 18px;
    border-left: 0;
    border-top: 1px solid rgb(246 241 228 / 0.14);
    padding-top: 12px;
    padding-left: 0;
  }

  .hero-stat {
    flex-direction: column;
    align-items: flex-start;
    gap: 3px;
    border-bottom: 0;
  }

  .hero-progress {
    grid-column: 1 / -1;
    margin-top: 4px;
  }

  .hero-mark {
    font-size: 150px;
  }
}

/* 打字练习范围选择 */
.scope-hint {
  margin: -2px 0 14px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-muted);
}

.scope-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.scope-card {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--color-line);
  border-radius: 12px;
  background: var(--color-surface-2);
  padding: 10px 13px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.scope-card:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-brand) 45%, var(--color-line));
}

.scope-card.is-active {
  border-color: var(--color-brand);
  background: color-mix(in srgb, var(--color-brand) 7%, var(--color-surface));
}

.scope-card:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.scope-card:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-brand) 55%, transparent);
  outline-offset: 2px;
}

.scope-ico {
  display: grid;
  height: 32px;
  width: 32px;
  flex: none;
  place-items: center;
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-brand) 9%, var(--color-raised));
  color: var(--color-brand);
}

.scope-card.is-wrong .scope-ico {
  background: color-mix(in srgb, var(--color-danger) 10%, var(--color-raised));
  color: var(--color-danger);
}

.scope-body {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 2px;
}

.scope-name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-ink);
}

.scope-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-muted);
}

.scope-count {
  flex: none;
  border: 1px solid var(--color-line);
  border-radius: 999px;
  background: var(--color-surface);
  padding: 2px 8px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--color-muted);
  white-space: nowrap;
}

.scope-card.is-active .scope-count {
  border-color: color-mix(in srgb, var(--color-brand) 35%, var(--color-line));
  color: var(--color-brand);
}

.scope-radio {
  display: grid;
  height: 16px;
  width: 16px;
  flex: none;
  place-items: center;
  border: 1.5px solid var(--color-line);
  border-radius: 50%;
  transition: border-color 0.15s ease;
}

.scope-card.is-active .scope-radio {
  border-color: var(--color-brand);
}

.scope-card.is-active .scope-radio::after {
  content: '';
  height: 8px;
  width: 8px;
  border-radius: 50%;
  background: var(--color-brand);
}

.pm-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.pm-hint {
  font-size: 11px;
  color: var(--color-muted);
}

.pm-actions {
  display: flex;
  flex: none;
  gap: 8px;
}
</style>
