<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { NButton, NIcon, useDialog, useMessage, type DialogReactive } from 'naive-ui'
import { VolumeHighOutline } from '@vicons/ionicons5'
import { useAppStore } from '@renderer/stores/app'
import { playError, playKey } from '@renderer/lib/typing-sound'
import type { CardData, Rating, WrongWord } from '@shared/types'

type Stage = 'loading' | 'typing' | 'choice' | 'flip' | 'done' | 'empty'
type FlipLabel = 'known' | 'vague' | 'forgot'

const STEPS = [
  { key: 'typing', label: '打字记词' },
  { key: 'choice', label: '选择释义' },
  { key: 'flip', label: '认识程度' },
] as const

const store = useAppStore()
const route = useRoute()
const router = useRouter()
const dialog = useDialog()
const message = useMessage()

/** new = 学新词；wrong = 复习错词本 */
const scope = ref<'new' | 'wrong'>(route.query.scope === 'wrong' ? 'wrong' : 'new')
/** extra = 每日目标已完成，用户主动加练一批 */
const extra = ref(route.query.extra === '1')
const stage = ref<Stage>('loading')
const cards = ref<CardData[]>([])
const pos = ref(0)
const startedAt = ref(0)
const wrongCount = ref(0)
const wrongToday = ref<WrongWord[]>([])
const summary = ref<{ rated: number; known: number; wrong: WrongWord[] } | null>(null)
const finishing = ref(false)
const loadingRound = ref(false)

// 子轮一：打字
const typed = ref<string[]>([])
const typingWrong = ref<{ pos: number; ch: string } | null>(null)
const typingLocked = ref(false)

// 子轮二：ABCD
const selected = ref<string | null>(null)
const correctPick = ref<string | null>(null)
const choiceWrong = ref(0)
const choiceLocked = ref(false)
const revealed = ref(false)

// 子轮三：3D 翻牌
const flipped = ref(false)
const flipLabel = ref<FlipLabel | null>(null)
const ratings = ref<Record<number, Rating>>({})
const labels = ref<Record<number, FlipLabel>>({})

let typingWrongTimer: number | undefined
let typingAdvanceTimer: number | undefined
let choiceTimer: number | undefined

/** 中断快照：退出后下次进入同一范围时从这里接着学 */
interface LearnSnapshot {
  version: 1
  scope: 'new' | 'wrong'
  startedAt: number
  day: string
  listId: number | null
  cards: CardData[]
  stage: 'typing' | 'choice' | 'flip'
  pos: number
  ratings: Record<number, Rating>
  labels: Record<number, FlipLabel>
  flipped: boolean
}

let dialogOpen = false
let activeDialog: DialogReactive | null = null
let saveChain: Promise<void> = Promise.resolve()
const leaving = ref(false)

function dayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function currentListId(): number | null {
  return scope.value === 'wrong' ? null : store.dashboard?.activeListId ?? null
}

const currentCard = computed<CardData | null>(() => cards.value[pos.value] ?? null)
const activeIndex = computed(() => STEPS.findIndex((s) => s.key === stage.value))
const progress = computed(() => {
  if (stage.value === 'done') return 100
  if (activeIndex.value < 0 || !cards.value.length) return 0
  return Math.round(((activeIndex.value * cards.value.length + pos.value) / (cards.value.length * 3)) * 100)
})
const summaryCounts = computed(() => {
  let known = 0
  let vague = 0
  let forgot = 0
  for (const label of Object.values(labels.value)) {
    if (label === 'known') known += 1
    else if (label === 'vague') vague += 1
    else forgot += 1
  }
  return { known, vague, forgot }
})
const roundHint = computed(() => {
  if (cards.value.length) {
    const source = scope.value === 'wrong' ? '错词本' : store.dashboard?.activeListName || '全部词库'
    return `本轮 ${cards.value.length} 词 · ${source}`
  }
  if (scope.value === 'wrong') return '从错词本里按最近答错时间取词'
  return extra.value ? '再学一批新词' : '按每日新词目标取词'
})

/** 每日新词配额用完但词库还有新词：提示去首页加练，而不是说词书学完了 */
const dailyQuotaReached = computed(() => {
  const d = store.dashboard
  if (scope.value !== 'new' || extra.value || !d) return false
  return d.fresh > 0 && d.newToday >= d.dailyNewWords
})

interface Slot {
  ch: string
  letter: boolean
  pos: number
}

const typingSlots = computed<Slot[]>(() => {
  let index = 0
  return [...(currentCard.value?.term ?? '')].map((ch) => {
    const letter = /[a-zA-Z]/.test(ch)
    return { ch, letter, pos: letter ? index++ : -1 }
  })
})
const typingLetterCount = computed(() => typingSlots.value.filter((s) => s.letter).length)

function clearTimers(): void {
  if (typingWrongTimer) clearTimeout(typingWrongTimer)
  if (typingAdvanceTimer) clearTimeout(typingAdvanceTimer)
  if (choiceTimer) clearTimeout(choiceTimer)
  typingWrongTimer = undefined
  typingAdvanceTimer = undefined
  choiceTimer = undefined
}

function speak(term: string, manual = false): void {
  if ((!manual && !store.settings.ttsEnabled) || !term || !('speechSynthesis' in window)) return
  try {
    const utterance = new SpeechSynthesisUtterance(term)
    utterance.lang = 'en-US'
    utterance.rate = 0.92
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  } catch {
    /* 系统没装英文语音包时静默跳过 */
  }
}

function resetTypingState(): void {
  typed.value = []
  typingWrong.value = null
  typingLocked.value = false
  if (typingWrongTimer) clearTimeout(typingWrongTimer)
  if (typingAdvanceTimer) clearTimeout(typingAdvanceTimer)
  typingWrongTimer = undefined
  typingAdvanceTimer = undefined
}

function resetChoiceState(): void {
  selected.value = null
  correctPick.value = null
  choiceWrong.value = 0
  choiceLocked.value = false
  revealed.value = false
  if (choiceTimer) clearTimeout(choiceTimer)
  choiceTimer = undefined
}

function resetFlipState(): void {
  flipped.value = false
  flipLabel.value = null
}

function enterTyping(index: number): void {
  stage.value = 'typing'
  pos.value = index
  resetTypingState()
  speak(cards.value[index]?.term ?? '')
  void saveProgress()
}

function enterChoice(index: number): void {
  if (index >= cards.value.length) {
    enterFlip(0)
    return
  }
  stage.value = 'choice'
  pos.value = index
  resetChoiceState()
  // 没有足够干扰项的单词没法出选择题，直接算通过
  if ((cards.value[index]?.options.length ?? 0) < 2) enterChoice(index + 1)
  else {
    speak(cards.value[index]?.term ?? '')
    void saveProgress()
  }
}

function enterFlip(index: number): void {
  stage.value = 'flip'
  pos.value = index
  resetFlipState()
  speak(cards.value[index]?.term ?? '')
  void saveProgress()
}

function charText(slot: Slot): string {
  if (!slot.letter) return slot.ch === ' ' ? '\u00a0' : slot.ch
  if (typingWrong.value && typingWrong.value.pos === slot.pos) return typingWrong.value.ch
  if (slot.pos < typed.value.length) return typed.value[slot.pos]
  return slot.ch
}

function charClass(slot: Slot): string[] {
  if (!slot.letter) return ['text-muted/60']
  if (typingWrong.value && typingWrong.value.pos === slot.pos) return ['text-danger learn-shake']
  if (slot.pos < typed.value.length) return ['text-brand']
  if (slot.pos === typed.value.length) {
    return ['text-ink underline decoration-brand/50 decoration-2 underline-offset-[12px]']
  }
  return ['text-ink/25']
}

function advanceTyping(): void {
  typingAdvanceTimer = undefined
  typingLocked.value = false
  typed.value = []
  typingWrong.value = null
  if (pos.value + 1 < cards.value.length) enterTyping(pos.value + 1)
  else enterChoice(0)
}

function finishTypingWord(): void {
  typingLocked.value = true
  // 打完后再念一遍，留足一句话的时间再翻到下一个词
  speak(currentCard.value?.term ?? '')
  typingAdvanceTimer = window.setTimeout(advanceTyping, 1100)
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && !event.isComposing) {
    event.preventDefault()
    if (dialogOpen) {
      // destroy() 不会触发 onClose，标记要自己清
      dialogOpen = false
      activeDialog?.destroy()
      activeDialog = null
    } else {
      requestExit()
    }
    return
  }
  if (stage.value !== 'typing' || typingLocked.value) return
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
  if (event.key.length !== 1 || !/[a-zA-Z]/.test(event.key)) return
  event.preventDefault()

  const expected = typingSlots.value.filter((s) => s.letter)[typed.value.length]?.ch
  if (!expected) return
  if (event.key.toLowerCase() !== expected.toLowerCase()) {
    playError()
    typingWrong.value = { pos: typed.value.length, ch: event.key.toUpperCase() }
    if (typingWrongTimer) clearTimeout(typingWrongTimer)
    typingWrongTimer = window.setTimeout(() => {
      typingWrong.value = null
    }, 520)
    return
  }
  typed.value.push(expected)
  playKey()
  if (typed.value.length === typingLetterCount.value) finishTypingWord()
}

function optionClass(option: string): string[] {
  const classes = ['option-card']
  if (correctPick.value === option) classes.push('option-card--correct')
  else if (selected.value === option) classes.push('option-card--wrong')
  return classes
}

async function markWrong(wordId: number): Promise<void> {
  try {
    wrongCount.value = await window.ganci.learnWrongMark(wordId)
  } catch {
    /* 错词落库失败不阻塞学习流程 */
  }
}

function advanceChoice(): void {
  choiceTimer = undefined
  if (pos.value + 1 < cards.value.length) enterChoice(pos.value + 1)
  else enterFlip(0)
}

function pickOption(option: string): void {
  const card = currentCard.value
  if (!card || choiceLocked.value || revealed.value) return
  const answer = card.meaning.trim()
  if (option === answer) {
    correctPick.value = option
    choiceLocked.value = true
    // 选完再念一遍，加深音形义对应
    speak(card.term)
    choiceTimer = window.setTimeout(advanceChoice, 1200)
    return
  }

  selected.value = option
  choiceWrong.value += 1
  if (choiceWrong.value >= 2) {
    revealed.value = true
    correctPick.value = answer
    choiceLocked.value = true
    void markWrong(card.wordId)
    speak(card.term)
    choiceTimer = window.setTimeout(advanceChoice, 1500)
    return
  }
  choiceLocked.value = true
  choiceTimer = window.setTimeout(() => {
    selected.value = null
    choiceLocked.value = false
    choiceTimer = undefined
  }, 560)
}

function chooseFlip(label: FlipLabel): void {
  const card = currentCard.value
  if (!card || flipped.value) return
  flipLabel.value = label
  labels.value[card.wordId] = label
  ratings.value[card.wordId] = label === 'known' ? 1 : 0
  flipped.value = true
  // 自评完成后再念一遍，作为这一遍学习的收尾
  speak(card.term)
  void saveProgress()
  if (label === 'forgot') void markWrong(card.wordId)
}

function nextFlip(): void {
  if (pos.value + 1 < cards.value.length) {
    pos.value += 1
    resetFlipState()
    speak(currentCard.value?.term ?? '')
    void saveProgress()
  } else {
    void finishRound()
  }
}

async function finishRound(): Promise<void> {
  if (finishing.value) return
  finishing.value = true
  const entries = cards.value.map((c) => ({
    wordId: c.wordId,
    rating: (ratings.value[c.wordId] ?? 0) as Rating,
  }))
  try {
    const result = await window.ganci.learnFinish(startedAt.value, entries, scope.value)
    summary.value = { rated: result.rated, known: result.known, wrong: result.wrongToday }
    wrongToday.value = result.wrongToday
    wrongCount.value = result.wrongToday.length
    stage.value = 'done'
    // 先等最后几次自动保存落库，再清快照，避免旧快照又被写回来
    await saveChain
    await window.ganci.learnProgressClear(scope.value).catch(() => {})
    void store.refreshDashboard()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '本轮结果保存失败')
  } finally {
    finishing.value = false
  }
}

function buildSnapshot(): LearnSnapshot | null {
  if (!cards.value.length) return null
  if (!(stage.value === 'typing' || stage.value === 'choice' || stage.value === 'flip')) return null
  return {
    version: 1,
    scope: scope.value,
    startedAt: startedAt.value,
    day: dayKey(),
    listId: currentListId(),
    cards: cards.value,
    stage: stage.value,
    pos: pos.value,
    ratings: { ...ratings.value },
    labels: { ...labels.value },
    flipped: stage.value === 'flip' && flipped.value,
  }
}

/** 每次跨题、跨阶段都落一次库，意外关窗口也能续上 */
function saveProgress(): Promise<void> {
  const snapshot = buildSnapshot()
  if (!snapshot) return saveChain
  const scopeKey = snapshot.scope
  const payload = JSON.stringify(snapshot)
  saveChain = saveChain.then(async () => {
    try {
      await window.ganci.learnProgressSave(scopeKey, payload)
    } catch {
      /* 自动保存失败不打断学习 */
    }
  })
  return saveChain
}

function isValidSnapshot(s: LearnSnapshot): boolean {
  if (s.version !== 1 || s.scope !== scope.value) return false
  if (s.day !== dayKey() || s.listId !== currentListId()) return false
  if (!s.startedAt || !Array.isArray(s.cards) || !s.cards.length) return false
  if (!['typing', 'choice', 'flip'].includes(s.stage)) return false
  if (!Number.isInteger(s.pos) || s.pos < 0 || s.pos >= s.cards.length) return false
  if (s.stage === 'choice' && (s.cards[s.pos]?.options.length ?? 0) < 2) return false
  return true
}

async function readSnapshot(): Promise<LearnSnapshot | null> {
  try {
    const raw = await window.ganci.learnProgressGet(scope.value)
    if (!raw) return null
    const parsed = JSON.parse(raw) as LearnSnapshot
    return isValidSnapshot(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function restoreSnapshot(s: LearnSnapshot, wrongList: WrongWord[] | null): Promise<void> {
  cards.value = s.cards
  startedAt.value = s.startedAt
  ratings.value = { ...s.ratings }
  labels.value = { ...s.labels }
  stage.value = s.stage
  pos.value = s.pos
  resetTypingState()
  resetChoiceState()
  resetFlipState()
  if (s.stage === 'flip' && s.flipped) {
    const label = labels.value[s.cards[s.pos].wordId]
    if (label) {
      flipLabel.value = label
      flipped.value = true
    }
  }
  if (wrongList) {
    wrongToday.value = wrongList
  } else {
    try {
      wrongToday.value = await window.ganci.learnWrongList()
    } catch {
      wrongToday.value = []
    }
  }
  wrongCount.value = wrongToday.value.length
  speak(cards.value[s.pos]?.term ?? '')
}

async function loadRound(allowResume = false): Promise<void> {
  if (loadingRound.value) return
  loadingRound.value = true
  clearTimers()
  stage.value = 'loading'
  summary.value = null
  cards.value = []
  pos.value = 0
  wrongToday.value = []
  ratings.value = {}
  labels.value = {}
  resetTypingState()
  resetChoiceState()
  resetFlipState()
  try {
    if (allowResume) {
      const snapshot = await readSnapshot()
      if (snapshot) {
        if (scope.value === 'wrong') {
          const list = await window.ganci.learnWrongList().catch(() => [] as WrongWord[])
          const alive = new Set(list.map((w) => w.wordId))
          if (snapshot.cards.some((c) => alive.has(c.wordId))) {
            await restoreSnapshot(snapshot, list)
            return
          }
        } else {
          await restoreSnapshot(snapshot, null)
          return
        }
      }
      // 隔天、换了词库或被删空的快照都不再可用
      await window.ganci.learnProgressClear(scope.value).catch(() => {})
    }

    const result = await window.ganci.learnStart(scope.value, extra.value)
    wrongToday.value = result.wrongToday
    wrongCount.value = result.wrongToday.length
    if (!result.cards.length) {
      stage.value = 'empty'
      return
    }
    cards.value = result.cards
    startedAt.value = Date.now()
    enterTyping(0)
  } catch (err) {
    message.error(err instanceof Error ? err.message : '加载新词失败')
    stage.value = 'empty'
  } finally {
    loadingRound.value = false
  }
}

async function switchScope(next: 'new' | 'wrong'): Promise<void> {
  scope.value = next
  extra.value = false
  await router.replace({ path: '/learn', query: next === 'wrong' ? { scope: 'wrong' } : {} })
  await loadRound(true)
}

function canInterrupt(): boolean {
  return (
    cards.value.length > 0 &&
    (stage.value === 'typing' || stage.value === 'choice' || stage.value === 'flip')
  )
}

async function leaveScreen(to: string): Promise<void> {
  if (leaving.value) return
  leaving.value = true
  clearTimers()
  if (canInterrupt()) await saveProgress()
  await router.push(to)
}

/** 只有点“退出并保存”才真正离开；取消或 Esc 关掉弹窗都留在本页 */
function requestExit(to = '/'): void {
  if (leaving.value) return
  if (!canInterrupt()) {
    void leaveScreen(to)
    return
  }
  if (dialogOpen) return
  dialogOpen = true
  activeDialog = dialog.warning({
    title: '确定要退出学习吗？',
    content: `一鼓作气效果更好哦。进度会保存，下次进入从第 ${pos.value + 1} / ${cards.value.length} 个词接着学。`,
    positiveText: '退出并保存',
    negativeText: '继续学习',
    maskClosable: false,
    onPositiveClick: () => {
      dialogOpen = false
      activeDialog = null
      void leaveScreen(to)
    },
    onNegativeClick: () => {
      dialogOpen = false
      activeDialog = null
    },
    onClose: () => {
      dialogOpen = false
      activeDialog = null
    },
  })
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  // 学习期间暂停复习提醒；离开页面时恢复
  void window.ganci.learnPause()
  // bare 路由不经过 AppShell 的 bootstrap，这里自己补齐
  if (!store.dashboard) await store.bootstrap()
  void loadRound(true)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  clearTimers()
  void window.ganci.learnResume()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <header class="shrink-0 border-b border-line bg-surface">
      <div class="mx-auto flex w-full max-w-[1080px] items-center gap-4 px-8 py-3.5">
        <button
          class="flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-canvas px-3 py-1.5 text-[12.5px] text-muted transition-colors hover:border-brand/40 hover:text-ink"
          @click="requestExit()"
        >
          <span class="text-[14px] leading-none">←</span>
          退出学习
        </button>
        <h1 class="text-[19px] font-semibold">{{ scope === 'wrong' ? '复习错词本' : '背单词' }}</h1>
        <span class="text-[12px] text-muted">{{ roundHint }}</span>

        <div class="ml-auto flex items-center gap-3 text-[12px]">
          <button
            class="cursor-pointer rounded-full border-0 bg-canvas px-3 py-1 text-muted hover:text-brand"
            title="查看错词本"
            @click="requestExit('/wrongs')"
          >
            错词本 <b class="num-display text-ink">{{ store.dashboard?.wrongTotal ?? wrongCount }}</b>
          </button>
          <template v-if="stage === 'typing' || stage === 'choice' || stage === 'flip'">
            <span
              v-for="(step, i) in STEPS"
              :key="step.key"
              class="rounded-full px-2.5 py-1"
              :class="i === activeIndex ? 'bg-brand-fill text-white' : 'text-muted'"
            >
              {{ i + 1 }} {{ step.label }}
            </span>
          </template>
        </div>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 justify-center px-8 py-5">
      <section class="card-surface flex min-h-0 w-full max-w-[1080px] flex-1 flex-col px-10 py-6">
      <div v-if="stage === 'loading'" class="flex flex-1 items-center justify-center text-[13px] text-muted">
        {{ scope === 'wrong' ? '正在准备错词…' : '正在准备新词…' }}
      </div>

      <div v-else-if="stage === 'empty'" class="flex flex-1 flex-col items-center justify-center">
        <div class="text-[15px] font-semibold">
          {{ scope === 'wrong' ? '错词本里暂时没有可复习的词' : dailyQuotaReached ? '今天的新词目标已完成' : '这本词书暂时没有待学的新词' }}
        </div>
        <div class="mt-2 text-[12px] text-muted">
          {{
            scope === 'wrong'
              ? '去背新词，答错的会自动收进错词本'
              : dailyQuotaReached
                ? '回首页点「再学习」可以加练一批，也可以先去复习'
                : '去词库导入更多单词，或先复习到期词'
          }}
        </div>
        <div v-if="wrongToday.length" class="mt-7 w-full max-w-[560px]">
          <div class="mb-2 text-[12px] font-semibold text-muted">今日答错</div>
          <div class="max-h-[240px] overflow-y-auto rounded-card border border-line">
            <div
              v-for="w in wrongToday"
              :key="w.wordId"
              class="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5 text-[13px] last:border-0"
            >
              <span class="font-term">{{ w.term }}</span>
              <span class="truncate text-muted">{{ w.meaning }}</span>
            </div>
          </div>
        </div>
        <div class="mt-8 flex gap-3">
          <n-button v-if="scope === 'wrong'" type="primary" @click="switchScope('new')">去背新词</n-button>
          <n-button v-else type="primary" @click="requestExit('/words')">去词库</n-button>
          <n-button @click="requestExit()">返回主页</n-button>
        </div>
      </div>

      <div v-else-if="stage === 'done'" class="flex flex-1 flex-col items-center justify-center">
        <div class="text-[12px] text-muted">本轮完成</div>
        <div class="mt-2 text-[30px] font-semibold">
          {{ scope === 'wrong' ? `复盘了 ${cards.length} 个错词` : `又啃下 ${cards.length} 个新词` }}
        </div>

        <div class="num-display mt-8 flex gap-12 text-center">
          <div>
            <div class="text-[26px] font-semibold text-brand">{{ summaryCounts.known }}</div>
            <div class="mt-1 text-[11px] text-muted">认识</div>
          </div>
          <div>
            <div class="text-[26px] font-semibold text-warning">{{ summaryCounts.vague }}</div>
            <div class="mt-1 text-[11px] text-muted">模糊</div>
          </div>
          <div>
            <div class="text-[26px] font-semibold text-danger">{{ summaryCounts.forgot }}</div>
            <div class="mt-1 text-[11px] text-muted">不记得</div>
          </div>
        </div>

        <div v-if="summary?.wrong.length" class="mt-8 w-full max-w-[560px]">
          <div class="mb-2 text-[12px] font-semibold text-muted">
            {{
              scope === 'wrong'
                ? `本轮仍有 ${summary.wrong.length} 个词答错，会继续留在错词本`
                : `今天答错 ${summary.wrong.length} 个词，已收进错词本`
            }}
          </div>
          <div class="max-h-[200px] overflow-y-auto rounded-card border border-line">
            <div
              v-for="w in summary.wrong"
              :key="w.wordId"
              class="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5 text-[13px] last:border-0"
            >
              <span class="font-term">{{ w.term }}</span>
              <span class="truncate text-muted">{{ w.meaning }}</span>
            </div>
          </div>
        </div>

        <div class="mt-9 flex gap-3">
          <n-button type="primary" size="large" :loading="finishing || loadingRound" @click="loadRound(false)">
            {{ scope === 'wrong' ? '继续复习错词' : '继续下一轮' }}
          </n-button>
          <n-button size="large" @click="requestExit()">返回主页</n-button>
        </div>
      </div>

      <template v-else-if="currentCard">
        <div class="flex flex-1 flex-col items-center justify-center">
          <!-- 子轮一：照着单词和释义打字 -->
          <template v-if="stage === 'typing'">
            <div class="flex items-end gap-3">
              <div
                class="cursor-pointer whitespace-pre font-term text-[58px] leading-none"
                title="点击朗读单词"
                @click="speak(currentCard.term, true)"
              >
                <span v-for="(slot, i) in typingSlots" :key="i" :class="charClass(slot)">{{ charText(slot) }}</span>
              </div>
              <button
                class="mb-1 cursor-pointer border-0 bg-transparent text-muted hover:text-brand"
                title="朗读单词"
                @click="speak(currentCard.term, true)"
              >
                <n-icon :component="VolumeHighOutline" :size="22" />
              </button>
            </div>

            <div class="mt-3 text-[13px] text-muted">{{ currentCard.phonetic || '\u00a0' }}</div>
            <div class="mt-6 max-w-[640px] text-center text-[18px] leading-relaxed">
              {{ currentCard.meaning || '暂无释义' }}
            </div>
            <div v-if="currentCard.example" class="mt-3 max-w-[680px] text-center text-[13px] leading-6 text-muted">
              {{ currentCard.example }}
            </div>
            <div class="mt-9 text-[12px] text-muted">照着单词键入字母，打错的字母会标红</div>
          </template>

          <!-- 子轮二：看单词选释义，错两次进错词 -->
          <template v-else-if="stage === 'choice'">
            <div
              class="cursor-pointer text-[46px] font-term leading-none transition-opacity hover:opacity-70"
              title="点击朗读单词"
              @click="speak(currentCard.term, true)"
            >
              {{ currentCard.term }}
            </div>
            <div class="mt-2 text-[13px] text-muted">{{ currentCard.phonetic || '\u00a0' }}</div>
            <div class="mt-3 text-[12px] text-muted">选出正确的中文释义 · 错两次会进入错词本</div>

            <div class="mt-7 grid w-full max-w-[640px] grid-cols-2 gap-3">
              <button
                v-for="(option, i) in currentCard.options"
                :key="option"
                type="button"
                :class="optionClass(option)"
                @click="pickOption(option)"
              >
                <span class="option-key">{{ 'ABCD'[i] }}</span>
                <span class="option-text">{{ option }}</span>
              </button>
            </div>

            <div class="mt-5 h-5 text-center text-[12px]">
              <span v-if="revealed" class="text-danger">已记入错词本，正确答案是绿色项</span>
              <span v-else-if="choiceLocked && selected" class="text-muted">再想一想</span>
              <span v-else-if="choiceWrong === 1" class="text-warning">还有一次机会</span>
            </div>
          </template>

          <!-- 子轮三：3D 翻牌 + 自评 -->
          <template v-else-if="stage === 'flip'">
            <div class="flip-scene w-full max-w-[600px]">
              <div class="flip-card" :class="{ 'is-flipped': flipped }">
                <div class="flip-face flip-front">
                  <button
                    class="cursor-pointer border-0 bg-transparent text-muted hover:text-brand"
                    title="朗读单词"
                    @click="speak(currentCard.term, true)"
                  >
                    <n-icon :component="VolumeHighOutline" :size="20" />
                  </button>
                  <div
                    class="mt-2 cursor-pointer text-[46px] font-term leading-none transition-opacity hover:opacity-70"
                    title="点击朗读单词"
                    @click="speak(currentCard.term, true)"
                  >
                    {{ currentCard.term }}
                  </div>
                  <div class="mt-2 text-[13px] text-muted">{{ currentCard.phonetic || '\u00a0' }}</div>
                  <div class="mt-8 text-[12px] text-muted">这个单词，你记得吗？</div>
                </div>
                <div class="flip-face flip-back">
                  <div
                    class="cursor-pointer text-[36px] font-term leading-none transition-opacity hover:opacity-70"
                    title="点击朗读单词"
                    @click="speak(currentCard.term, true)"
                  >
                    {{ currentCard.term }}
                  </div>
                  <div class="mt-2 text-[13px] text-muted">{{ currentCard.phonetic || '\u00a0' }}</div>
                  <div class="mt-5 max-w-[520px] text-center text-[17px] leading-relaxed">
                    {{ currentCard.meaning || '暂无释义' }}
                  </div>
                  <div v-if="currentCard.example" class="mt-3 max-w-[540px] text-center text-[13px] leading-6 text-muted">
                    {{ currentCard.example }}
                  </div>
                  <div v-if="currentCard.forms.length" class="mt-3 max-w-[540px] text-center text-[12px] text-muted">
                    变形：{{ currentCard.forms.map((f) => `${f.form}（${f.label}）`).join('、') }}
                  </div>
                </div>
              </div>
            </div>

            <div class="mt-6 flex justify-center gap-3">
              <template v-if="!flipped">
                <button type="button" class="rate-btn rate-known" @click="chooseFlip('known')">认识</button>
                <button type="button" class="rate-btn rate-vague" @click="chooseFlip('vague')">模糊</button>
                <button type="button" class="rate-btn rate-forgot" @click="chooseFlip('forgot')">不记得</button>
              </template>
              <n-button v-else type="primary" size="large" @click="nextFlip">
                {{ pos + 1 >= cards.length ? '完成本轮' : '下一个' }}
              </n-button>
            </div>
          </template>
        </div>

        <div class="mt-4">
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              class="h-full rounded-full bg-brand transition-[width] duration-200"
              :style="{ width: `${progress}%` }"
            />
          </div>
          <div class="num-display mt-2 flex justify-between text-[11px] text-muted">
            <span>{{ pos + 1 }} / {{ cards.length }}</span>
            <span>{{ STEPS[activeIndex]?.label }}</span>
          </div>
        </div>
      </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.learn-shake {
  color: var(--color-danger);
  animation: learn-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

@keyframes learn-shake {
  10%,
  90% {
    transform: translateX(-1px);
  }
  20%,
  80% {
    transform: translateX(2px);
  }
  30%,
  50%,
  70% {
    transform: translateX(-3px);
  }
  40%,
  60% {
    transform: translateX(3px);
  }
}

.option-card {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: var(--color-surface);
  padding: 14px 16px;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.option-card:hover {
  border-color: var(--color-brand);
}

.option-key {
  display: inline-flex;
  height: 24px;
  width: 24px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: var(--color-canvas);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-muted);
}

.option-text {
  font-size: 14px;
  line-height: 1.5;
}

.option-card--correct {
  border-color: var(--color-brand);
  background: color-mix(in srgb, var(--color-brand) 10%, var(--color-raised));
}

.option-card--correct .option-key {
  background: var(--color-brand-fill);
  color: var(--color-on-brand);
}

.option-card--wrong {
  border-color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 9%, var(--color-raised));
}

.option-card--wrong .option-key {
  background: var(--color-danger);
  color: #fff;
}

.flip-scene {
  perspective: 1300px;
}

.flip-card {
  display: grid;
  transform-style: preserve-3d;
  transition: transform 560ms cubic-bezier(0.2, 0.7, 0.2, 1);
}

.flip-card.is-flipped {
  transform: rotateY(180deg);
}

.flip-face {
  grid-area: 1 / 1;
  display: flex;
  min-height: 300px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-line);
  border-radius: 14px;
  background: var(--color-surface);
  padding: 28px;
  backface-visibility: hidden;
}

.flip-back {
  transform: rotateY(180deg);
  background: color-mix(in srgb, var(--color-brand) 4%, var(--color-raised));
}

.rate-btn {
  min-width: 108px;
  border: 1px solid var(--color-line);
  border-radius: 9px;
  background: var(--color-surface);
  padding: 11px 20px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.rate-known {
  color: var(--color-brand);
  border-color: color-mix(in srgb, var(--color-brand) 40%, var(--color-raised));
}

.rate-known:hover {
  background: color-mix(in srgb, var(--color-brand) 8%, var(--color-raised));
}

.rate-vague {
  color: color-mix(in srgb, var(--color-accent) 82%, var(--color-ink));
  border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-raised));
}

.rate-vague:hover {
  background: color-mix(in srgb, var(--color-accent) 7%, var(--color-raised));
}

.rate-forgot {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-danger) 35%, var(--color-raised));
}

.rate-forgot:hover {
  background: color-mix(in srgb, var(--color-danger) 7%, var(--color-raised));
}
</style>
