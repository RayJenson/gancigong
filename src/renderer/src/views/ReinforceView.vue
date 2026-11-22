<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, useMessage } from 'naive-ui'
import type { Component } from 'vue'
import {
  AlbumsOutline,
  AlertCircleOutline,
  LanguageOutline,
  RefreshOutline,
  RepeatOutline,
  SwapHorizontalOutline,
  TimeOutline,
  VolumeHighOutline,
} from '@vicons/ionicons5'
import { useAppStore } from '@renderer/stores/app'
import type { ReinforceScope, WordRow } from '@shared/types'
import { playError, playKey } from '@renderer/lib/typing-sound'

type ReinforceMode = 'flip' | 'en2zh' | 'zh2en' | 'spell' | 'listen2zh'
type Phase = 'setup' | 'running' | 'done'

const SESSION_SIZE = 20
const POOL_LIMIT = 400
const OPTION_COUNT = 4

interface ModeMeta {
  id: ReinforceMode
  name: string
  desc: string
  icon: Component
}

interface ScopeMeta {
  id: ReinforceScope
  name: string
  desc: string
  icon: Component
}

interface TrainCard {
  word: WordRow
  options: string[]
  answer: string
}

interface Slot {
  ch: string
  letter: boolean
  pos: number
}

const MODES: ModeMeta[] = [
  { id: 'flip', name: '快速记', desc: '翻卡看释义，适合先混个脸熟', icon: AlbumsOutline },
  { id: 'en2zh', name: '看单词选中文', desc: '认词形，四选一找出正确释义', icon: LanguageOutline },
  { id: 'zh2en', name: '看中文选单词', desc: '由义回想词形，反向检索更牢', icon: SwapHorizontalOutline },
  { id: 'spell', name: '全拼默写', desc: '遮住单词，按字母完整拼出来', icon: RepeatOutline },
  { id: 'listen2zh', name: '听单词选中文', desc: '只听发音辨词，再选出释义', icon: VolumeHighOutline },
]

const SCOPES: ScopeMeta[] = [
  { id: 'studiedToday', name: '今日已学回顾', desc: '今天学过或复习过的词，趁热巩固', icon: TimeOutline },
  { id: 'wrongReview', name: '错词回顾', desc: '错词本里的词，专挑薄弱处练', icon: AlertCircleOutline },
  { id: 'reviewing', name: '复习中单词', desc: '还在记忆阶梯上、尚未掌握的词', icon: RefreshOutline },
]

const store = useAppStore()
const router = useRouter()
const message = useMessage()

const mode = ref<ReinforceMode>('flip')
const scope = ref<ReinforceScope>('studiedToday')
const counts = ref<Partial<Record<ReinforceScope, number>>>({})
const countsLoading = ref(true)
const preparing = ref(false)

const cards = ref<TrainCard[]>([])
const index = ref(0)
const phase = ref<Phase>('setup')
const flipped = ref(false)
const selected = ref<string | null>(null)
const typed = ref<string[]>([])
const typeWrong = ref<{ pos: number; ch: string } | null>(null)
const locked = ref(false)
const wordHadError = ref(false)
const mistakes = ref(0)
const answered = ref(0)
const elapsedMs = ref(0)
const finalElapsedMs = ref(0)
const startedAt: { value: number | null } = { value: null }

let ticker: number | undefined
let wrongTimer: number | undefined
let advanceTimer: number | undefined

const modeMeta = computed(() => MODES.find((m) => m.id === mode.value) ?? MODES[0])
const scopeMeta = computed(() => SCOPES.find((s) => s.id === scope.value) ?? SCOPES[0])
const current = computed<TrainCard | null>(() => cards.value[index.value] ?? null)
const canStart = computed(() => !countsLoading.value && (counts.value[scope.value] ?? 0) > 0)

const scopeCountText = computed(() => {
  if (countsLoading.value) return '读取中…'
  const n = counts.value[scope.value] ?? 0
  return n > 0 ? `${n.toLocaleString()} 个词可选` : '这个范围暂时没有单词'
})

const progress = computed(() => {
  if (!cards.value.length) return 0
  const done = (index.value + (locked.value ? 1 : 0)) / cards.value.length
  return Math.min(100, Math.round(done * 100))
})

const elapsedText = computed(() => {
  const ms = phase.value === 'done' ? finalElapsedMs.value : elapsedMs.value
  const seconds = Math.floor(ms / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
})

const accuracy = computed(() => {
  if (!answered.value) return 0
  return Math.round(((answered.value - mistakes.value) / answered.value) * 100)
})

const spellSlots = computed<Slot[]>(() => {
  let pos = 0
  return [...(current.value?.word.term ?? '')].map((ch) => {
    const letter = /[a-zA-Z]/.test(ch)
    return { ch, letter, pos: letter ? pos++ : -1 }
  })
})
const letterCount = computed(() => spellSlots.value.filter((s) => s.letter).length)

function shuffle<T>(items: T[]): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function clearTimers(): void {
  if (wrongTimer) {
    clearTimeout(wrongTimer)
    wrongTimer = undefined
  }
  if (advanceTimer) {
    clearTimeout(advanceTimer)
    advanceTimer = undefined
  }
}

function speak(term: string, force = false): void {
  if (!term || !('speechSynthesis' in window)) return
  if (!force && !store.settings.ttsEnabled) return
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

async function loadCounts(): Promise<void> {
  countsLoading.value = true
  try {
    const listId = store.settings.activeListId ?? null
    const results = await Promise.all(
      SCOPES.map((s) =>
        window.ganci.wordsList({
          listId: s.id === 'wrongReview' ? null : listId,
          scope: s.id,
          limit: 1,
        })
      )
    )
    const next: Partial<Record<ReinforceScope, number>> = {}
    SCOPES.forEach((s, i) => {
      next[s.id] = results[i].total
    })
    counts.value = next
  } catch {
    counts.value = {}
  } finally {
    countsLoading.value = false
  }
}

function buildOptions(usable: WordRow[], word: WordRow): { options: string[]; answer: string } | null {
  const byTerm = mode.value === 'zh2en'
  const answer = (byTerm ? word.term : word.meaning).trim()
  if (!answer) return null
  const seen = new Set<string>([answer.toLowerCase()])
  const distractors: string[] = []
  for (const other of shuffle(usable)) {
    if (other.id === word.id) continue
    const text = (byTerm ? other.term : other.meaning).trim()
    const key = text.toLowerCase()
    if (!text || seen.has(key)) continue
    seen.add(key)
    distractors.push(text)
    if (distractors.length >= OPTION_COUNT - 1) break
  }
  if (!distractors.length) return null
  return { options: shuffle([answer, ...distractors]), answer }
}

async function start(): Promise<void> {
  if (preparing.value) return
  if (phase.value === 'setup' && !canStart.value) return
  preparing.value = true
  clearTimers()
  try {
    const listId = scope.value === 'wrongReview' ? null : store.settings.activeListId ?? null
    const res = await window.ganci.wordsList({ listId, scope: scope.value, limit: POOL_LIMIT })
    const usable = res.rows.filter((w) => w.term.trim() && w.meaning.trim())
    const picked = shuffle(usable).slice(0, SESSION_SIZE)
    if (!picked.length) {
      message.warning('这个范围暂时没有可练习的单词，换个范围试试')
      return
    }
    if (mode.value === 'flip' || mode.value === 'spell') {
      cards.value = picked.map((word) => ({ word, options: [], answer: '' }))
    } else {
      const built: TrainCard[] = []
      for (const word of picked) {
        const opts = buildOptions(usable, word)
        if (opts) built.push({ word, options: opts.options, answer: opts.answer })
      }
      if (!built.length) {
        message.warning('这个范围的单词太少，凑不出选项；可以改用「快速记」或换更宽的词表')
        return
      }
      cards.value = built
    }
    index.value = 0
    mistakes.value = 0
    answered.value = 0
    elapsedMs.value = 0
    finalElapsedMs.value = 0
    startedAt.value = Date.now()
    phase.value = 'running'
    enterCard()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '加载练习单词失败')
  } finally {
    preparing.value = false
  }
}

function stopSession(): void {
  clearTimers()
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  phase.value = 'setup'
  cards.value = []
  index.value = 0
  startedAt.value = null
  void loadCounts()
}

function finish(): void {
  clearTimers()
  finalElapsedMs.value = startedAt.value ? Date.now() - startedAt.value : elapsedMs.value
  startedAt.value = null
  phase.value = 'done'
}

function enterCard(): void {
  clearTimers()
  flipped.value = false
  selected.value = null
  typed.value = []
  typeWrong.value = null
  locked.value = false
  wordHadError.value = false
  const card = current.value
  if (!card) return
  if (mode.value === 'listen2zh') speak(card.word.term, true)
  else if (mode.value === 'en2zh') speak(card.word.term)
}

function advance(): void {
  if (phase.value !== 'running') return
  clearTimers()
  if (wordHadError.value) mistakes.value += 1
  answered.value += 1
  if (index.value + 1 >= cards.value.length) {
    finish()
    return
  }
  index.value += 1
  enterCard()
}

function flipCard(): void {
  if (phase.value !== 'running' || flipped.value) return
  flipped.value = true
  if (current.value) speak(current.value.word.term)
}

function pickOption(option: string): void {
  const card = current.value
  if (!card || locked.value || !card.options.length) return
  selected.value = option
  locked.value = true
  if (option === card.answer) {
    if (mode.value !== 'listen2zh') speak(card.word.term)
    advanceTimer = window.setTimeout(advance, 850)
    return
  }
  wordHadError.value = true
  if (mode.value !== 'listen2zh') speak(card.word.term, true)
  advanceTimer = window.setTimeout(advance, 1900)
}

function optionClass(option: string): string[] {
  const cls: string[] = []
  if (!selected.value || !current.value) return cls
  if (option === current.value.answer) cls.push('option-card--correct')
  else if (option === selected.value) cls.push('option-card--wrong')
  return cls
}

function charText(slot: Slot): string {
  if (!slot.letter) return slot.ch === ' ' ? '\u00a0' : slot.ch
  if (typeWrong.value && typeWrong.value.pos === slot.pos) return typeWrong.value.ch
  if (slot.pos < typed.value.length) return typed.value[slot.pos]
  return '_'
}

function charClass(slot: Slot): string[] {
  if (!slot.letter) return ['text-muted/60']
  const cls = ['inline-block']
  if (typeWrong.value && typeWrong.value.pos === slot.pos) {
    cls.push('text-danger reinforce-wrong')
    return cls
  }
  if (slot.pos < typed.value.length) {
    cls.push('text-brand')
    return cls
  }
  if (slot.pos === typed.value.length) {
    cls.push('text-ink underline decoration-brand/50 decoration-2 underline-offset-[14px]')
    return cls
  }
  cls.push('text-ink/30')
  return cls
}

function typeLetter(key: string): void {
  if (phase.value !== 'running' || locked.value || !current.value) return
  const expected = spellSlots.value.filter((s) => s.letter)[typed.value.length]?.ch
  if (!expected) return
  if (key.toLowerCase() !== expected.toLowerCase()) {
    wordHadError.value = true
    playError()
    typeWrong.value = { pos: typed.value.length, ch: key.toUpperCase() }
    if (wrongTimer) clearTimeout(wrongTimer)
    wrongTimer = window.setTimeout(() => {
      typeWrong.value = null
    }, 520)
    return
  }
  playKey()
  typed.value.push(expected)
  if (typed.value.length < letterCount.value) return
  locked.value = true
  speak(current.value.word.term)
  advanceTimer = window.setTimeout(advance, 420)
}

function onKey(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (phase.value === 'setup') {
    if (event.key === 'Escape') {
      event.preventDefault()
      router.push('/')
      return
    }
    if (event.key === 'Enter' && canStart.value) {
      event.preventDefault()
      void start()
    }
    return
  }
  if (phase.value === 'done') {
    if (event.key === 'Enter') {
      event.preventDefault()
      void start()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      stopSession()
    }
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    stopSession()
    return
  }
  if (mode.value === 'spell') {
    if (locked.value) {
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault()
        advance()
      }
      return
    }
    if (event.key.length === 1 && /[a-zA-Z]/.test(event.key)) {
      event.preventDefault()
      typeLetter(event.key)
    }
    return
  }
  if (mode.value === 'flip') {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      if (!flipped.value) flipCard()
      else advance()
    }
    return
  }
  if (locked.value) {
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault()
      advance()
    }
    return
  }
  if (/^[1-4]$/.test(event.key)) {
    const option = current.value?.options[Number(event.key) - 1]
    if (option) {
      event.preventDefault()
      pickOption(option)
    }
  }
}

watch(
  () => store.settings.activeListId,
  () => {
    if (phase.value === 'setup') void loadCounts()
  }
)

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  ticker = window.setInterval(() => {
    if (startedAt.value !== null && phase.value === 'running') elapsedMs.value = Date.now() - startedAt.value
  }, 200)
  if (!store.settings) await store.bootstrap()
  await loadCounts()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (ticker) clearInterval(ticker)
  clearTimers()
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
})
</script>

<template>
  <div class="mx-auto flex h-full max-w-[980px] flex-col px-8 py-6">
    <header class="flex shrink-0 items-center gap-4">
      <button
        class="cursor-pointer border-0 bg-transparent text-[13px] text-muted hover:text-ink"
        @click="router.push('/')"
      >
        ← 主页
      </button>
      <h1 class="text-[20px] font-semibold">练习巩固</h1>
      <span v-if="phase === 'setup'" class="text-[12px] text-muted">五种练法 · 不计入复习进度</span>
      <span v-else-if="phase === 'running'" class="text-[12px] text-muted">
        {{ modeMeta.name }} · {{ scopeMeta.name }} · {{ index + 1 }}/{{ cards.length }}
      </span>
      <span v-else class="text-[12px] text-muted">{{ modeMeta.name }} · {{ scopeMeta.name }}</span>

      <div class="ml-auto flex items-center gap-3">
        <span v-if="phase === 'running'" class="num-display text-[12px] text-muted">{{ elapsedText }}</span>
        <n-button v-if="phase === 'running'" size="small" @click="stopSession">结束练习</n-button>
      </div>
    </header>

    <section class="card-surface relative mt-5 flex min-h-0 flex-1 flex-col px-8 py-6">
      <div v-if="countsLoading && phase === 'setup'" class="flex flex-1 items-center justify-center text-[13px] text-muted">
        读取可选单词…
      </div>

      <div v-else-if="phase === 'setup'" class="flex min-h-0 flex-1 flex-col">
        <div class="min-h-0 flex-1 overflow-y-auto pr-1">
          <div>
            <div class="flex items-baseline gap-2">
              <span class="text-[13px] font-semibold">练习方式</span>
              <span class="text-[11px] text-muted">先选练法，再选词范围</span>
            </div>
            <div class="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
              <button
                v-for="item in MODES"
                :key="item.id"
                type="button"
                role="radio"
                class="pick-card"
                :class="{ 'is-active': mode === item.id }"
                :aria-checked="mode === item.id"
                @click="mode = item.id"
              >
                <span class="pick-top">
                  <span class="pick-ico"><n-icon :component="item.icon" :size="15" /></span>
                  <span class="pick-name">{{ item.name }}</span>
                </span>
                <span class="pick-desc">{{ item.desc }}</span>
              </button>
            </div>
          </div>

          <div class="mt-6">
            <div class="flex items-baseline gap-2">
              <span class="text-[13px] font-semibold">练习单词</span>
              <span class="text-[11px] text-muted">按当前词表取词</span>
            </div>
            <div class="mt-3 grid grid-cols-3 gap-3">
              <button
                v-for="item in SCOPES"
                :key="item.id"
                type="button"
                role="radio"
                class="pick-card"
                :class="{ 'is-active': scope === item.id }"
                :aria-checked="scope === item.id"
                @click="scope = item.id"
              >
                <span class="pick-top">
                  <span class="pick-ico"><n-icon :component="item.icon" :size="15" /></span>
                  <span class="pick-name">{{ item.name }}</span>
                  <span class="pick-count">{{ countsLoading ? '—' : `${counts[item.id] ?? 0} 词` }}</span>
                </span>
                <span class="pick-desc">{{ item.desc }}</span>
              </button>
            </div>
          </div>
        </div>

        <div class="mt-5 flex shrink-0 items-center justify-between gap-4 border-t border-line pt-4">
          <span class="text-[12px] text-muted">
            {{ scopeCountText }} · 每轮最多 {{ SESSION_SIZE }} 词
          </span>
          <n-button type="primary" size="large" :loading="preparing" :disabled="!canStart" @click="start">
            开始练习
          </n-button>
        </div>
      </div>

      <div v-else-if="phase === 'done'" class="flex flex-1 flex-col items-center justify-center">
        <div class="text-[12px] text-muted">练习完成</div>
        <div class="mt-2 text-[26px] font-semibold">{{ modeMeta.name }} · 本轮 {{ cards.length }} 词</div>
        <div class="num-display mt-8 flex gap-12 text-center">
          <div>
            <div class="text-[24px] font-semibold">{{ elapsedText }}</div>
            <div class="mt-1 text-[11px] text-muted">用时</div>
          </div>
          <div v-if="mode !== 'flip'">
            <div class="text-[24px] font-semibold">{{ accuracy }}%</div>
            <div class="mt-1 text-[11px] text-muted">正确率</div>
          </div>
          <div>
            <div class="text-[24px] font-semibold">{{ mode === 'flip' ? cards.length : mistakes }}</div>
            <div class="mt-1 text-[11px] text-muted">{{ mode === 'flip' ? '翻过的词' : '出错的词' }}</div>
          </div>
        </div>
        <div class="mt-3 text-[11px] text-muted">练习结果不计入复习进度</div>
        <div class="mt-8 flex gap-3">
          <n-button type="primary" size="large" :loading="preparing" @click="start">再练一组</n-button>
          <n-button size="large" @click="stopSession">换一种练法</n-button>
        </div>
        <div class="mt-4 text-[11px] text-muted">按 Enter 再练一组，Esc 回到选择</div>
      </div>

      <template v-else>
        <div class="flex min-h-0 flex-1 flex-col items-center justify-center">
          <div v-if="mode === 'flip' && current" class="flip-scene" @click="flipCard">
            <div class="flip-card" :class="{ 'is-flipped': flipped }">
              <div class="flip-face flip-front">
                <div class="flex items-end justify-center gap-3">
                  <span class="font-term text-[54px] leading-none">{{ current.word.term }}</span>
                  <button
                    class="speaker-btn"
                    title="朗读单词"
                    @click.stop="speak(current.word.term, true)"
                  >
                    <n-icon :component="VolumeHighOutline" :size="20" />
                  </button>
                </div>
                <div v-if="current.word.phonetic" class="mt-3 text-[14px] text-muted">
                  {{ current.word.phonetic }}
                </div>
                <div class="mt-10 text-[12px] text-muted">点击卡片或按空格，翻面看释义</div>
              </div>
              <div class="flip-face flip-back">
                <div class="text-[13px] text-muted">
                  {{ current.word.term }}
                  <template v-if="current.word.phonetic"> · {{ current.word.phonetic }}</template>
                </div>
                <div class="flip-meaning">{{ current.word.meaning }}</div>
                <div v-if="current.word.example" class="flip-example">{{ current.word.example }}</div>
              </div>
            </div>
          </div>

          <div v-else-if="mode === 'spell' && current" class="w-full max-w-[760px]">
            <div class="text-center">
              <div class="mx-auto max-w-[640px] text-[20px] font-medium leading-relaxed">
                {{ current.word.meaning }}
              </div>
              <div class="mt-2 text-[11px] text-muted">根据释义默写出单词，按字母逐个键入</div>
            </div>
            <div class="mt-9 flex items-end justify-center gap-3">
              <div class="whitespace-pre font-term text-[52px] leading-none">
                <span v-for="(slot, i) in spellSlots" :key="i" :class="charClass(slot)">{{ charText(slot) }}</span>
              </div>
              <button
                class="speaker-btn mb-1"
                title="朗读单词"
                @click="current && speak(current.word.term, true)"
              >
                <n-icon :component="VolumeHighOutline" :size="20" />
              </button>
            </div>
            <div class="mt-6 text-center text-[12px] text-muted">打错的字母会标红，停一下想清楚再敲</div>
          </div>

          <div v-else-if="current" class="w-full max-w-[760px]">
            <div class="text-center">
              <template v-if="mode === 'en2zh'">
                <div class="flex items-end justify-center gap-3">
                  <span class="font-term text-[52px] leading-none">{{ current.word.term }}</span>
                  <button
                    class="speaker-btn mb-1"
                    title="朗读单词"
                    @click="speak(current.word.term, true)"
                  >
                    <n-icon :component="VolumeHighOutline" :size="20" />
                  </button>
                </div>
                <div v-if="current.word.phonetic" class="mt-2 text-[14px] text-muted">
                  {{ current.word.phonetic }}
                </div>
                <div class="mt-3 text-[12px] text-muted">选出正确的中文释义</div>
              </template>

              <template v-else-if="mode === 'zh2en'">
                <div class="mx-auto max-w-[640px] whitespace-pre-line text-[23px] font-medium leading-relaxed">
                  {{ current.word.meaning }}
                </div>
                <div class="mt-3 text-[12px] text-muted">选出正确的英文单词</div>
                <div v-if="selected" class="mt-3 text-[14px]">
                  答案：
                  <span class="font-term text-[19px] text-brand">{{ current.word.term }}</span>
                  <span v-if="current.word.phonetic" class="ml-2 text-[12px] text-muted">
                    {{ current.word.phonetic }}
                  </span>
                </div>
              </template>

              <template v-else>
                <button class="listen-btn" title="点击重播发音" @click="speak(current.word.term, true)">
                  <n-icon :component="VolumeHighOutline" :size="34" />
                </button>
                <div class="mt-4 text-[12px] text-muted">听发音，选出正确的中文释义 · 再点一次重播</div>
                <div v-if="selected" class="mt-3 text-[15px]">
                  <span class="font-term">{{ current.word.term }}</span>
                  <span v-if="current.word.phonetic" class="ml-2 text-[12px] text-muted">
                    {{ current.word.phonetic }}
                  </span>
                </div>
              </template>
            </div>

            <div class="mt-7 grid grid-cols-2 gap-3" role="group" aria-label="选项">
              <button
                v-for="(option, i) in current.options"
                :key="`${i}-${option}`"
                type="button"
                class="option-card"
                :class="optionClass(option)"
                :disabled="locked"
                @click="pickOption(option)"
              >
                <span class="option-key">{{ i + 1 }}</span>
                <span class="option-text" :class="{ 'font-term text-[16px]': mode === 'zh2en' }">{{ option }}</span>
              </button>
            </div>

            <div class="mt-4 h-5 text-center text-[12px]">
              <span v-if="selected && selected === current.answer" class="text-brand">答对了，继续下一词</span>
              <span v-else-if="selected" class="text-danger">选错了，正确答案已标绿</span>
              <span v-else class="text-muted">按 1–4 选择，也可以直接点选项</span>
            </div>
          </div>
        </div>

        <div class="mt-4 shrink-0">
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              class="h-full rounded-full bg-brand transition-[width] duration-200"
              :style="{ width: `${progress}%` }"
            />
          </div>
          <div class="num-display mt-2 flex justify-between text-[11px] text-muted">
            <span>{{ index + 1 }} / {{ cards.length }}</span>
            <span>
              <template v-if="mode === 'flip'">{{ flipped ? '按空格进入下一词' : '按空格翻面' }}</template>
              <template v-else-if="mode === 'spell'">{{ locked ? '按空格进入下一词' : `${typed.length} / ${letterCount} 个字母` }}</template>
              <template v-else>{{ modeMeta.name }}</template>
            </span>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.pick-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 7px;
  border: 1px solid var(--color-line);
  border-radius: 12px;
  background: linear-gradient(165deg, var(--color-surface), var(--color-surface-2));
  padding: 12px 14px;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
}

.pick-card:hover {
  border-color: color-mix(in srgb, var(--color-brand) 34%, var(--color-line));
  transform: translateY(-1px);
}

.pick-card.is-active {
  border-color: var(--color-brand);
  background: color-mix(in srgb, var(--color-brand) 7%, var(--color-surface));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-brand) 24%, transparent);
}

.pick-top {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 8px;
}

.pick-ico {
  display: grid;
  height: 26px;
  width: 26px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-brand) 10%, transparent);
  color: var(--color-brand);
}

.pick-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-ink);
}

.pick-card.is-active .pick-name {
  color: var(--color-brand);
}

.pick-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}

.pick-desc {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--color-muted);
}

.speaker-btn {
  display: grid;
  height: 30px;
  width: 30px;
  flex: none;
  place-items: center;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  transition: color 140ms ease, background-color 140ms ease;
}

.speaker-btn:hover {
  background: color-mix(in srgb, var(--color-brand) 8%, transparent);
  color: var(--color-brand);
}

.listen-btn {
  display: grid;
  height: 78px;
  width: 78px;
  margin: 0 auto;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-brand) 32%, var(--color-line));
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-brand) 8%, var(--color-surface));
  color: var(--color-brand);
  cursor: pointer;
  transition: transform 140ms ease, background-color 140ms ease;
}

.listen-btn:hover {
  transform: scale(1.03);
  background: color-mix(in srgb, var(--color-brand) 13%, var(--color-surface));
}

.listen-btn:active {
  transform: scale(0.98);
}

.option-card {
  display: flex;
  align-items: center;
  gap: 12px;
  border: 1px solid var(--color-line);
  border-radius: 12px;
  background: linear-gradient(165deg, var(--color-surface), var(--color-surface-2));
  padding: 13px 15px;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, transform 140ms ease;
}

.option-card:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-brand) 38%, var(--color-line));
  transform: translateY(-1px);
}

.option-card:disabled {
  cursor: default;
}

.option-key {
  display: grid;
  height: 24px;
  width: 24px;
  flex: none;
  place-items: center;
  border: 1px solid var(--color-line);
  border-radius: 7px;
  background: var(--color-raised);
  font-size: 11px;
  color: var(--color-muted);
}

.option-text {
  display: -webkit-box;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  font-size: 13.5px;
  line-height: 1.55;
}

.option-card.option-card--correct {
  border-color: #3e9c74;
  background: color-mix(in srgb, #3e9c74 9%, var(--color-surface));
}

.option-card.option-card--correct .option-key {
  border-color: #3e9c74;
  color: #3e9c74;
}

.option-card.option-card--wrong {
  border-color: #c93b3b;
  background: color-mix(in srgb, #c93b3b 8%, var(--color-surface));
  animation: reinforce-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

.option-card.option-card--wrong .option-key {
  border-color: #c93b3b;
  color: #c93b3b;
}

.flip-scene {
  width: 100%;
  max-width: 620px;
  height: 300px;
  perspective: 1200px;
  cursor: pointer;
}

.flip-card {
  position: relative;
  height: 100%;
  width: 100%;
  transform-style: preserve-3d;
  transition: transform 420ms cubic-bezier(0.4, 0.1, 0.2, 1);
}

.flip-card.is-flipped {
  transform: rotateY(180deg);
}

.flip-face {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: 18px;
  background:
    radial-gradient(120% 90% at 100% 0%, rgb(194 121 44 / 0.06), transparent 60%),
    linear-gradient(165deg, var(--color-surface), var(--color-surface-2));
  padding: 24px 32px;
  backface-visibility: hidden;
}

.flip-back {
  transform: rotateY(180deg);
}

.flip-meaning {
  margin-top: 10px;
  max-height: 168px;
  overflow-y: auto;
  text-align: center;
  font-size: 20px;
  font-weight: 500;
  line-height: 1.6;
}

.flip-example {
  margin-top: 14px;
  max-height: 84px;
  overflow-y: auto;
  text-align: center;
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-muted);
}

.reinforce-wrong {
  color: #c93b3b;
  animation: reinforce-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

@keyframes reinforce-shake {
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
</style>