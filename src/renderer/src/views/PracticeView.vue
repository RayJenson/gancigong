<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NSelect, NSwitch, useMessage } from 'naive-ui'
import { VolumeHighOutline } from '@vicons/ionicons5'
import { useAppStore } from '@renderer/stores/app'
import type { ListInfo, WordRow } from '@shared/types'

const SESSION_SIZE = 20
const MAX_POOL = 500

type Phase = 'ready' | 'typing' | 'done'

const store = useAppStore()
const router = useRouter()
const message = useMessage()

const lists = ref<ListInfo[]>([])
const listChoice = ref(0)
const hideWord = ref(false)
const words = ref<WordRow[]>([])
const index = ref(0)
const typed = ref<string[]>([])
const wrong = ref<{ pos: number; ch: string } | null>(null)
const phase = ref<Phase>('ready')
const locked = ref(false)
const loading = ref(false)
const totalKeys = ref(0)
const correctKeys = ref(0)
const elapsedMs = ref(0)
const finalElapsedMs = ref(0)
let startedAt: number | null = null

let ticker: number | undefined
let wrongTimer: number | undefined
let advanceTimer: number | undefined

const listOptions = computed(() => [
  { label: '全部词表', value: 0 },
  ...lists.value.map((l) => ({ label: `${l.name}（${l.wordCount}）`, value: l.id })),
])

const currentWord = computed<WordRow | null>(() => words.value[index.value] ?? null)

interface Slot {
  ch: string
  letter: boolean
  pos: number
}

const slots = computed<Slot[]>(() => {
  let pos = 0
  return [...(currentWord.value?.term ?? '')].map((ch) => {
    const letter = /[a-zA-Z]/.test(ch)
    return { ch, letter, pos: letter ? pos++ : -1 }
  })
})
const letterCount = computed(() => slots.value.filter((s) => s.letter).length)

const progress = computed(() => {
  if (!words.value.length) return 0
  if (phase.value === 'done') return 100
  const per = letterCount.value || 1
  return Math.min(100, ((index.value + Math.min(typed.value.length / per, 1)) / words.value.length) * 100)
})

const elapsedText = computed(() => {
  const ms = phase.value === 'done' ? finalElapsedMs.value : elapsedMs.value
  const seconds = Math.floor(ms / 1000)
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
})

const speed = computed(() => {
  const ms = phase.value === 'done' ? finalElapsedMs.value : elapsedMs.value
  if (ms <= 0) return 0
  return correctKeys.value / 5 / (ms / 60_000)
})

const accuracy = computed(() => (totalKeys.value ? Math.round((correctKeys.value / totalKeys.value) * 100) : null))

const doneStats = computed(() => ({
  wpm: finalElapsedMs.value > 0 ? correctKeys.value / 5 / (finalElapsedMs.value / 60_000) : 0,
  accuracy: totalKeys.value ? Math.round((correctKeys.value / totalKeys.value) * 100) : 100,
}))

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

function resetTyping(): void {
  clearTimers()
  typed.value = []
  wrong.value = null
  locked.value = false
}

function resetStats(): void {
  startedAt = null
  elapsedMs.value = 0
  finalElapsedMs.value = 0
  totalKeys.value = 0
  correctKeys.value = 0
}

async function loadLists(): Promise<void> {
  try {
    lists.value = await window.ganci.listsList()
    const preferred = store.settings.activeListId
    if (preferred && lists.value.some((l) => l.id === preferred)) listChoice.value = preferred
  } catch {
    /* 词表加载失败时退回全部词表 */
  }
}

async function loadWords(): Promise<void> {
  loading.value = true
  try {
    const listId = listChoice.value || null
    const result = await window.ganci.wordsList({ listId, limit: MAX_POOL })
    words.value = shuffle(result.rows.filter((w) => w.term.trim() && w.meaning.trim())).slice(0, SESSION_SIZE)
    index.value = 0
    phase.value = 'ready'
    resetTyping()
    resetStats()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '加载练习单词失败')
  } finally {
    loading.value = false
  }
}

function changeList(value: number): void {
  listChoice.value = value
  ;(document.activeElement as HTMLElement | null)?.blur()
  void loadWords()
}

function start(): void {
  if (!words.value.length || phase.value === 'done') return
  ;(document.activeElement as HTMLElement | null)?.blur()
  phase.value = 'typing'
}

function startAnother(): void {
  void loadWords()
}

function speak(term: string): void {
  if (!term || !('speechSynthesis' in window)) return
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

function charText(slot: Slot): string {
  if (!slot.letter) return slot.ch === ' ' ? '\u00a0' : slot.ch
  if (wrong.value && wrong.value.pos === slot.pos) return wrong.value.ch
  if (slot.pos < typed.value.length) return typed.value[slot.pos]
  if (hideWord.value) return '_'
  return slot.ch
}

function charClass(slot: Slot): string[] {
  if (!slot.letter) return ['text-muted/60']
  const base = ['inline-block']
  if (wrong.value && wrong.value.pos === slot.pos) {
    base.push('text-danger practice-wrong')
    return base
  }
  if (slot.pos < typed.value.length) {
    base.push('text-brand')
    return base
  }
  if (slot.pos === typed.value.length) {
    base.push('text-ink underline decoration-brand/50 decoration-2 underline-offset-[14px]')
    return base
  }
  base.push('text-ink/35')
  return base
}

function advanceWord(): boolean {
  if (advanceTimer) {
    clearTimeout(advanceTimer)
    advanceTimer = undefined
  }
  locked.value = false
  typed.value = []
  wrong.value = null
  if (index.value + 1 >= words.value.length) {
    finalElapsedMs.value = startedAt ? Date.now() - startedAt : elapsedMs.value
    startedAt = null
    phase.value = 'done'
    return true
  }
  index.value += 1
  return false
}

function finishWord(): void {
  locked.value = true
  if (store.settings.ttsEnabled && currentWord.value) speak(currentWord.value.term)
  advanceTimer = window.setTimeout(advanceWord, 220)
}

function onKey(event: KeyboardEvent): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (phase.value === 'done') {
    if (event.key === 'Enter') {
      event.preventDefault()
      startAnother()
    }
    return
  }
  if (!words.value.length || loading.value) return
  if (event.key === 'Backspace') {
    event.preventDefault()
    return
  }
  if (event.key.length !== 1 || !/[a-zA-Z]/.test(event.key)) return
  event.preventDefault()
  // 刚打完上一词就接着敲下一词时，立即切词而不是把这次按键吞掉
  if (locked.value && advanceWord()) return
  if (phase.value === 'ready') phase.value = 'typing'
  if (startedAt === null) startedAt = Date.now()

  const expected = slots.value.filter((s) => s.letter)[typed.value.length]?.ch
  if (!expected) return
  totalKeys.value += 1
  if (event.key.toLowerCase() !== expected.toLowerCase()) {
    wrong.value = { pos: typed.value.length, ch: event.key.toUpperCase() }
    if (wrongTimer) clearTimeout(wrongTimer)
    wrongTimer = window.setTimeout(() => {
      wrong.value = null
    }, 520)
    return
  }
  correctKeys.value += 1
  typed.value.push(expected)
  if (typed.value.length === letterCount.value) finishWord()
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  ticker = window.setInterval(() => {
    if (startedAt !== null && phase.value === 'typing') elapsedMs.value = Date.now() - startedAt
  }, 200)
  await loadLists()
  await loadWords()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (ticker) clearInterval(ticker)
  clearTimers()
})
</script>

<template>
  <div class="mx-auto flex h-full max-w-[980px] flex-col px-8 py-6">
    <header class="flex shrink-0 items-center gap-4">
      <button
        class="cursor-pointer border-0 bg-transparent text-[13px] text-muted hover:text-ink"
        @click="router.push('/')"
      >
        ← 复习台
      </button>
      <h1 class="text-[20px] font-semibold">练习</h1>
      <span class="text-[12px] text-muted">打字练习，不计入复习进度</span>

      <div class="ml-auto flex items-center gap-4">
        <n-select
          size="small"
          class="w-[190px]"
          :value="listChoice"
          :options="listOptions"
          :consistent-menu-width="false"
          @update:value="changeList"
        />
        <div class="flex shrink-0 items-center gap-2">
          <n-switch v-model:value="hideWord" size="small" />
          <span class="whitespace-nowrap text-[12px] text-muted">隐藏单词</span>
        </div>
        <n-button
          v-if="phase === 'ready'"
          type="primary"
          size="small"
          :disabled="!words.length"
          @click="start"
        >
          开始
        </n-button>
        <n-button v-else size="small" @click="startAnother">换一组</n-button>
      </div>
    </header>

    <section class="card-surface relative mt-5 flex min-h-0 flex-1 flex-col px-10 py-6">
      <div v-if="loading" class="flex flex-1 items-center justify-center text-[13px] text-muted">加载中…</div>

      <div v-else-if="!words.length" class="flex flex-1 flex-col items-center justify-center gap-3">
        <div class="text-[14px]">词库里还没有带释义的单词</div>
        <n-button type="primary" @click="router.push('/words')">去词库导入</n-button>
      </div>

      <div v-else-if="phase === 'done'" class="flex flex-1 flex-col items-center justify-center">
        <div class="text-[12px] text-muted">练习完成</div>
        <div class="mt-2 text-[28px] font-semibold">本轮 {{ words.length }} 词</div>
        <div class="num-display mt-7 flex gap-12 text-center">
          <div>
            <div class="text-[24px] font-semibold">{{ elapsedText }}</div>
            <div class="mt-1 text-[11px] text-muted">用时</div>
          </div>
          <div>
            <div class="text-[24px] font-semibold">{{ doneStats.wpm.toFixed(2) }}</div>
            <div class="mt-1 text-[11px] text-muted">速度 WPM</div>
          </div>
          <div>
            <div class="text-[24px] font-semibold">{{ doneStats.accuracy }}%</div>
            <div class="mt-1 text-[11px] text-muted">正确率</div>
          </div>
        </div>
        <div class="mt-8 flex gap-3">
          <n-button type="primary" size="large" @click="startAnother">再练一轮</n-button>
          <n-button size="large" @click="router.push('/')">返回复习台</n-button>
        </div>
      </div>

      <template v-else>
        <div class="flex flex-1 flex-col items-center justify-center">
          <div class="flex items-end gap-3">
            <div class="whitespace-pre font-term text-[64px] leading-none">
              <span v-for="(slot, i) in slots" :key="i" :class="charClass(slot)">{{ charText(slot) }}</span>
            </div>
            <button
              class="mb-1 cursor-pointer border-0 bg-transparent text-muted hover:text-brand"
              title="朗读单词"
              @click="currentWord && speak(currentWord.term)"
            >
              <n-icon :component="VolumeHighOutline" :size="22" />
            </button>
          </div>

          <div class="mt-6 max-w-[640px] text-center text-[16px] leading-relaxed text-ink/80">
            {{ currentWord?.meaning }}
          </div>

          <div class="mt-8 text-[12px] text-muted">
            {{ phase === 'ready' ? '直接敲字母开始，打错的字母会标红' : '按顺序键入英文，打错会计入正确率' }}
          </div>
        </div>

        <div class="mt-4">
          <div class="h-1.5 w-full overflow-hidden rounded-full bg-line">
            <div
              class="h-full rounded-full bg-brand transition-[width] duration-200"
              :style="{ width: `${progress}%` }"
            />
          </div>
          <div class="num-display mt-2 flex justify-between text-[11px] text-muted">
            <span>{{ index + 1 }} / {{ words.length }}</span>
            <span>{{ letterCount }} 个字母</span>
          </div>
        </div>
      </template>
    </section>

    <section class="card-surface mt-4 grid shrink-0 grid-cols-5 divide-x divide-line py-4">
      <div class="text-center">
        <div class="num-display text-[24px] font-semibold">{{ elapsedText }}</div>
        <div class="mt-1 text-[11px] text-muted">时间</div>
      </div>
      <div class="text-center">
        <div class="num-display text-[24px] font-semibold">{{ totalKeys }}</div>
        <div class="mt-1 text-[11px] text-muted">输入数</div>
      </div>
      <div class="text-center">
        <div class="num-display text-[24px] font-semibold">{{ speed.toFixed(2) }}</div>
        <div class="mt-1 text-[11px] text-muted">速度 WPM</div>
      </div>
      <div class="text-center">
        <div class="num-display text-[24px] font-semibold">{{ correctKeys }}</div>
        <div class="mt-1 text-[11px] text-muted">正确数</div>
      </div>
      <div class="text-center">
        <div class="num-display text-[24px] font-semibold">{{ accuracy === null ? '—' : `${accuracy}%` }}</div>
        <div class="mt-1 text-[11px] text-muted">正确率</div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.practice-wrong {
  color: #c93b3b;
  animation: practice-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

@keyframes practice-shake {
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
