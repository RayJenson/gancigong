<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { NButton } from 'naive-ui'
import type { CardData, Rating, RoundPlan } from '@shared/types'

const route = useRoute()
const roundId = Number(route.query.round ?? 0)
const mode = String(route.query.mode ?? 'gentle') as 'gentle' | 'fullscreen'
const lock = String(route.query.lock ?? 'app') as 'app' | 'kiosk'

const plan = ref<RoundPlan | null>(null)
const index = ref(0)
const revealed = ref(false)
const summary = ref<{ known: number; forgotten: number; seconds: number } | null>(null)
/** summary 只是累计数字，finished 才代表本轮真的走完了，否则标完第一个词就跳结算页 */
const finished = ref(false)
const denied = ref('')
const countdown = ref(5)

/** 当前题的作答状态：拼写题看 typed/wrong/mistake，选择题看 chosen，判定结果统一放 verdict */
const typed = ref<string[]>([])
const wrong = ref<{ pos: number; ch: string } | null>(null)
const mistake = ref(false)
const answered = ref(false)
const chosen = ref<number | null>(null)
const verdict = ref<Rating | null>(null)

const startedAt = Date.now()
let unsub: (() => void) | null = null
let countdownTimer: number | undefined
let advanceTimer: number | undefined
let wrongTimer: number | undefined

const card = computed<CardData | null>(() => plan.value?.cards[index.value] ?? null)
const total = computed(() => plan.value?.cards.length ?? 0)
const progress = computed(() => (total.value ? (index.value / total.value) * 100 : 0))
const quotaLeft = computed(() => plan.value?.delayQuotaLeft ?? 0)
const fullscreen = computed(() => mode === 'fullscreen')

/** 单词拆成槽位：字母一格，连字符/空格这类字符直接显示、不占输入位 */
const parts = computed(() => {
  let pos = 0
  return [...(card.value?.term ?? '')].map((ch) => {
    const isLetter = /[a-zA-Z]/.test(ch)
    return { ch, isLetter, pos: isLetter ? pos++ : -1 }
  })
})
const letterChars = computed(() => parts.value.filter((p) => p.isLetter).map((p) => p.ch))
const letterCount = computed(() => letterChars.value.length)

const verdictLine = computed(() => {
  const current = card.value
  if (!current || verdict.value === null || current.mode === 'reveal') return ''
  if (current.mode === 'spell') return verdict.value === 1 ? '✓ 拼写正确' : '✗ 拼写有误，已记为不认识'
  return verdict.value === 1 ? '✓ 选对了' : '✗ 选错了，正确答案已标出'
})

function speak(text: string): void {
  if (!plan.value?.ttsEnabled || !text || !('speechSynthesis' in window)) return
  try {
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'en-US'
    utterance.rate = 0.92
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  } catch {
    /* 系统没装英文语音包时静默跳过 */
  }
}

/** 拼写题开题就念单词等于直接给答案，只有选择题/翻牌才念 */
function speakPrompt(): void {
  const current = card.value
  if (!current || current.mode === 'spell') return
  speak(current.term)
}

function clearAdvance(): void {
  if (advanceTimer) {
    clearTimeout(advanceTimer)
    advanceTimer = undefined
  }
}

function resetQuiz(): void {
  clearAdvance()
  if (wrongTimer) {
    clearTimeout(wrongTimer)
    wrongTimer = undefined
  }
  typed.value = []
  wrong.value = null
  mistake.value = false
  answered.value = false
  chosen.value = null
  verdict.value = null
}

async function load(): Promise<void> {
  try {
    const result = await window.ganci.reviewPlan(roundId)
    if (!result) {
      denied.value = '这一轮已经结束了'
      void window.ganci.reviewFinish(roundId).catch(() => undefined)
      return
    }
    plan.value = result
    resetQuiz()
    speakPrompt()
  } catch (err) {
    denied.value = err instanceof Error ? err.message : '本轮加载失败'
  }
}

function reveal(): void {
  if (!card.value || revealed.value) return
  revealed.value = true
  const current = card.value
  speak(current.term)
  if (current.example) window.setTimeout(() => speak(current.example), 900)
}

/** 结算页留在渲染层展示，关闭由主进程在 reviewFinish 之后统一执行 */
async function finish(): Promise<void> {
  if (countdownTimer) clearInterval(countdownTimer)
  await window.ganci.reviewFinish(roundId).catch(() => undefined)
}

function settle(): void {
  finished.value = true
  if (!summary.value) return
  summary.value.seconds = Math.round((Date.now() - startedAt) / 1000)
  // 温和弹窗也留几秒看结算页，否则标记完最后一个词窗口立刻消失
  countdown.value = fullscreen.value ? 5 : 3
  countdownTimer = window.setInterval(() => {
    countdown.value -= 1
    if (countdown.value <= 0) void finish()
  }, 1000)
}

async function rate(rating: Rating): Promise<void> {
  if (!card.value || finished.value) return
  clearAdvance()
  revealed.value = true
  try {
    await window.ganci.reviewRate(roundId, card.value.wordId, rating)
  } catch {
    /* 单条标记失败不打断本轮 */
  }
  const known = rating === 1 ? 1 : 0
  const base = summary.value ?? { known: 0, forgotten: 0, seconds: 0 }
  summary.value = { ...base, known: base.known + known, forgotten: base.forgotten + (1 - known) }
  if (index.value + 1 >= total.value) {
    settle()
    return
  }
  index.value += 1
  revealed.value = false
  resetQuiz()
  speakPrompt()
}

async function delay(reason: string): Promise<void> {
  try {
    const result = await window.ganci.reviewDelay(roundId, reason)
    if (!result.ok) denied.value = `今日延后次数已用完，完成本轮即可恢复使用（每次推迟 ${result.minutes} 分钟）`
  } catch (err) {
    denied.value = err instanceof Error ? err.message : '延后失败'
  }
}

function shownChar(p: { pos: number }): string {
  if (wrong.value && wrong.value.pos === p.pos) return wrong.value.ch
  return typed.value[p.pos] ?? ''
}

function handleLetter(key: string): void {
  if (!card.value || answered.value) return
  const expected = letterChars.value[typed.value.length]
  if (!expected) return
  if (key.toLowerCase() !== expected.toLowerCase()) {
    mistake.value = true
    wrong.value = { pos: typed.value.length, ch: key.toUpperCase() }
    if (wrongTimer) clearTimeout(wrongTimer)
    wrongTimer = window.setTimeout(() => {
      wrong.value = null
    }, 520)
    return
  }
  typed.value.push(expected)
  if (typed.value.length === letterCount.value) completeSpelling()
}

function advanceAfter(ms: number): void {
  clearAdvance()
  advanceTimer = window.setTimeout(() => {
    advanceTimer = undefined
    if (verdict.value === null) return
    void rate(verdict.value)
  }, ms)
}

function completeSpelling(): void {
  answered.value = true
  revealed.value = true
  verdict.value = mistake.value ? 0 : 1
  speak(card.value?.term ?? '')
  // 拼错的留久一点，让用户看清正确拼写
  advanceAfter(mistake.value ? 3600 : 2800)
}

function giveUp(): void {
  if (!card.value || answered.value) return
  answered.value = true
  revealed.value = true
  mistake.value = true
  verdict.value = 0
  speak(card.value.term)
  advanceAfter(3600)
}

function choose(i: number): void {
  const current = card.value
  if (!current || answered.value) return
  answered.value = true
  chosen.value = i
  revealed.value = true
  const ok = current.options[i] === current.meaning.trim()
  verdict.value = ok ? 1 : 0
  if (ok) speak(current.term)
  advanceAfter(ok ? 2800 : 4000)
}

function advanceNow(): void {
  if (verdict.value === null || !answered.value) return
  clearAdvance()
  void rate(verdict.value)
}

function optionClass(i: number): string[] {
  const current = card.value
  const base = ['option-btn', fullscreen.value ? '' : 'option-btn--compact']
  if (!current) return base
  if (!answered.value) {
    base.push(
      fullscreen.value
        ? 'border-white/15 text-white/85 hover:border-white/45 hover:bg-white/5'
        : 'border-line text-ink hover:border-brand/60 hover:bg-brand/5'
    )
    return base
  }
  if (current.options[i] === current.meaning.trim()) {
    base.push(fullscreen.value ? 'border-[#5fa87f] bg-[#5fa87f]/15 text-[#b7e3c9]' : 'border-brand bg-brand/5 text-brand')
    return base
  }
  if (i === chosen.value) {
    base.push(fullscreen.value ? 'border-[#e2564f] bg-[#e2564f]/15 text-[#f4b3ae]' : 'border-danger bg-danger/5 text-danger')
    return base
  }
  base.push(fullscreen.value ? 'border-white/10 text-white/30' : 'border-line text-muted opacity-70')
  return base
}

function onKey(event: KeyboardEvent): void {
  if (finished.value) {
    if (event.code === 'Enter' || event.code === 'Escape') void finish()
    return
  }
  const current = card.value
  if (!current) return

  if (current.mode === 'spell') {
    if (answered.value) {
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault()
        advanceNow()
      }
      return
    }
    if (event.code === 'Backspace') {
      event.preventDefault()
      typed.value.pop()
      return
    }
    if (event.key.length === 1 && /[a-zA-Z]/.test(event.key)) {
      event.preventDefault()
      handleLetter(event.key)
    }
    return
  }

  if (current.mode === 'choice') {
    if (answered.value) {
      if (event.code === 'Space' || event.code === 'Enter') {
        event.preventDefault()
        advanceNow()
      }
      return
    }
    const n = Number.parseInt(event.key, 10)
    if (n >= 1 && n <= current.options.length) {
      event.preventDefault()
      choose(n - 1)
    }
    return
  }

  if (event.code === 'Space') {
    event.preventDefault()
    reveal()
    return
  }
  if (event.code === 'Digit1' || event.code === 'Numpad1') {
    event.preventDefault()
    void rate(0)
    return
  }
  if (event.code === 'Digit2' || event.code === 'Numpad2' || (event.code === 'Enter' && revealed.value)) {
    event.preventDefault()
    void rate(1)
  }
}

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKey)
  unsub = window.ganci.onDelayDenied(() => {
    denied.value = '今日延后额度已用尽，把这一轮复习完就能回到正常状态'
  })
  if (fullscreen.value) window.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  unsub?.()
  clearAdvance()
  if (wrongTimer) clearTimeout(wrongTimer)
  if (countdownTimer) clearInterval(countdownTimer)
  try {
    window.speechSynthesis?.cancel()
  } catch {
    /* 无语音接口 */
  }
})
</script>

<template>
  <div v-if="!plan && !denied" class="flex h-full items-center justify-center bg-surface text-muted">准备中…</div>

  <div
    v-else-if="finished && summary"
    class="flex h-full flex-col items-center justify-center text-center"
    :class="fullscreen ? 'bg-canvas-dark' : 'rounded-pop bg-surface shadow-review'"
  >
    <div class="text-[12px]" :class="fullscreen ? 'text-white/45' : 'text-muted'">本轮结束</div>
    <div class="num-display mt-2 text-[44px] font-semibold leading-none" :class="fullscreen ? 'text-white' : 'text-ink'">
      {{ summary.known }}<span class="text-[20px] opacity-50"> / {{ total }}</span>
    </div>
    <div class="mt-2 text-[13px]" :class="fullscreen ? 'text-white/60' : 'text-muted'">
      认识 {{ summary.known }} · 不认识 {{ summary.forgotten }} · 用时 {{ summary.seconds }} 秒
    </div>
    <n-button class="mt-7" type="primary" size="large" @click="finish">
      {{ fullscreen ? `返回桌面（${Math.max(countdown, 0)}）` : `关闭（${Math.max(countdown, 0)}）` }}
    </n-button>
    <div class="mt-3 text-[11px]" :class="fullscreen ? 'text-white/35' : 'text-muted'">未标完的词下次仍会出现，不会丢</div>
  </div>

  <div
    v-else-if="card"
    class="flex h-full flex-col overflow-hidden"
    :class="fullscreen ? 'bg-canvas-dark' : 'rounded-pop bg-surface shadow-review'"
  >
    <div class="flex items-center justify-between px-5 py-3 text-[12px]" :class="fullscreen ? 'text-white/55' : 'text-muted'">
      <span>
        {{ fullscreen ? `强制复习中 · 第 ${index + 1} / ${total} 词` : `第 ${index + 1} / ${total} 词` }}
        <span v-if="lock === 'kiosk'" class="ml-3 opacity-70">Ctrl+Alt+Esc 可紧急退出</span>
      </span>
      <button
        v-if="!fullscreen"
        class="cursor-pointer border-0 bg-transparent text-[16px] leading-none opacity-45 hover:opacity-100"
        title="关闭（记一次延后）"
        @click="delay('close_button')"
      >
        ×
      </button>
      <span v-else>{{ lock === 'kiosk' ? 'Kiosk 级锁定' : '应用级锁定' }}</span>
    </div>

    <div class="h-[3px] w-full" :class="fullscreen ? 'bg-white/10' : 'bg-line'">
      <div
        class="h-full transition-[width] duration-200"
        :class="fullscreen ? 'bg-accent' : 'bg-brand'"
        :style="{ width: `${progress}%` }"
      />
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto" :class="fullscreen ? 'px-16' : 'px-5'">
      <div class="flex min-h-full flex-col items-center justify-center py-3 text-center">
        <!-- 拼写题：只给中文，让用户默写英文 -->
        <div v-if="card.mode === 'spell' && !answered" class="flex w-full flex-col items-center">
          <div class="text-[12px]" :class="fullscreen ? 'text-white/45' : 'text-muted'">看中文，拼出英文</div>
          <div
            class="mt-3 max-w-[680px] whitespace-pre-line font-medium leading-relaxed"
            :class="fullscreen ? 'text-[24px] text-white' : 'text-[16px] text-ink'"
          >
            {{ card.meaning }}
          </div>

          <div class="mt-7 flex flex-wrap items-end justify-center" :class="fullscreen ? 'gap-x-2.5 gap-y-5' : 'gap-x-1.5 gap-y-3'">
            <span v-for="(p, i) in parts" :key="i" class="flex flex-col items-center justify-end">
              <template v-if="p.isLetter">
                <span
                  class="spell-char font-term text-center"
                  :class="[
                    fullscreen ? 'w-[40px] text-[52px] leading-[1.1] text-white' : 'w-[18px] text-[26px] leading-[1.1] text-ink',
                    wrong && wrong.pos === p.pos ? 'is-wrong' : '',
                  ]"
                >
                  {{ shownChar(p) }}
                </span>
                <span
                  class="mt-1.5 w-full rounded"
                  :class="[
                    fullscreen ? 'h-[3px]' : 'h-[2px]',
                    wrong && wrong.pos === p.pos ? 'bg-danger' : fullscreen ? 'bg-white/35' : 'bg-ink/25',
                  ]"
                />
              </template>
              <span v-else class="pb-2" :class="fullscreen ? 'text-[40px] text-white/70' : 'text-[20px] text-muted'">{{ p.ch }}</span>
            </span>
          </div>

          <div class="mt-6 text-[12px]" :class="fullscreen ? 'text-white/30' : 'text-muted'">打错的字母会标红 · 拼完自动判定</div>
        </div>

        <template v-else>
          <div class="font-term break-words font-semibold leading-tight" :class="fullscreen ? 'text-[72px] text-white' : 'text-[34px] text-ink'">
            {{ card.term }}
          </div>
          <div v-if="card.phonetic" class="num-display mt-1 text-[16px]" :class="fullscreen ? 'text-white/50' : 'text-muted'">
            /{{ card.phonetic }}/
          </div>

          <div
            v-if="verdictLine"
            class="mt-2 text-[13px]"
            :class="verdict === 1 ? (fullscreen ? 'text-[#8fd0ac]' : 'text-brand') : 'text-danger'"
          >
            {{ verdictLine }}
          </div>

          <transition name="flip">
            <div v-if="revealed" class="mt-4 w-full max-w-[660px]">
              <div
                class="whitespace-pre-line leading-relaxed"
                :class="fullscreen ? 'text-[19px] text-white' : 'text-[15px] text-ink'"
              >
                {{ card.meaning || '这条还没有释义，去词库补上' }}
              </div>
              <div v-if="card.forms.length" class="mt-2 flex flex-wrap justify-center gap-2 text-[12px]">
                <span
                  v-for="f in card.forms"
                  :key="f.form"
                  class="rounded px-2 py-0.5"
                  :class="fullscreen ? 'bg-white/10 text-white/60' : 'bg-canvas text-muted'"
                >
                  {{ f.label }} {{ f.form }}
                </span>
              </div>
              <div v-if="card.example" class="mt-2 text-[13px] italic" :class="fullscreen ? 'text-white/40' : 'text-muted'">
                {{ card.example }}
              </div>
            </div>
          </transition>

          <!-- 选择题：看英文选释义 -->
          <div v-if="card.mode === 'choice'" class="mt-3 grid w-full max-w-[720px] grid-cols-2 gap-2">
            <button
              v-for="(opt, i) in card.options"
              :key="i"
              :class="optionClass(i)"
              :disabled="answered"
              @click="choose(i)"
            >
              <span class="num-display mt-[2px] text-[11px] opacity-45">{{ i + 1 }}</span>
              <span class="line-clamp-2">{{ opt }}</span>
            </button>
          </div>

          <div v-if="card.mode === 'reveal' && !revealed" class="mt-8">
            <n-button type="primary" size="large" class="!px-10" @click="reveal">显示释义（空格）</n-button>
          </div>
        </template>

        <p v-if="denied" class="mt-3 max-w-[420px] text-[12px] leading-relaxed text-danger">{{ denied }}</p>
      </div>
    </div>

    <div class="flex shrink-0 flex-wrap items-center justify-center gap-3 px-5 pb-5" :class="fullscreen ? 'min-h-[96px]' : 'min-h-[72px]'">
      <template v-if="answered">
        <span class="text-[12px]" :class="fullscreen ? 'text-white/40' : 'text-muted'">已判定，即将进入下一词</span>
        <button
          class="cursor-pointer border-0 bg-transparent text-[12px] underline opacity-60 hover:opacity-100"
          @click="advanceNow"
        >
          现在继续
        </button>
      </template>
      <template v-else-if="card.mode === 'reveal' && revealed">
        <n-button size="large" class="!min-h-[44px] !px-9" style="color: #c93b3b; border-color: #c93b3b" @click="rate(0)">
          不认识（1）
        </n-button>
        <n-button type="primary" size="large" class="!min-h-[44px] !px-9" @click="rate(1)">认识（2）</n-button>
      </template>
      <template v-else>
        <button
          v-if="card.mode === 'spell'"
          class="cursor-pointer whitespace-nowrap border-0 bg-transparent text-[12px] underline opacity-60 hover:opacity-100"
          @click="giveUp"
        >
          想不起来，看答案
        </button>
        <n-button v-if="quotaLeft > 0" text @click="delay('delay_button')">
          {{ fullscreen ? `稍后再说（今日还剩 ${quotaLeft} 次，推迟一次扣 1 次）` : `稍后再说（剩 ${quotaLeft} 次）` }}
        </n-button>
        <span v-else class="text-[12px]" :class="fullscreen ? 'text-white/40' : 'text-muted'">今日延后次数已用完</span>
      </template>
    </div>
  </div>
</template>

<style scoped>
.flip-enter-active {
  transition:
    opacity 180ms cubic-bezier(0.2, 0.7, 0.3, 1),
    transform 180ms cubic-bezier(0.2, 0.7, 0.3, 1);
}
.flip-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.option-btn {
  display: flex;
  align-items: flex-start;
  gap: 0.45rem;
  border-width: 1px;
  border-style: solid;
  border-radius: 10px;
  padding: 0.55rem 0.7rem;
  text-align: left;
  font-size: 13px;
  line-height: 1.45;
  transition:
    border-color 150ms,
    background-color 150ms,
    color 150ms;
}
.option-btn:disabled {
  cursor: default;
}

.option-btn--compact {
  padding: 0.42rem 0.55rem;
  font-size: 12px;
  line-height: 1.4;
}

.spell-char {
  display: block;
  height: 1.25em;
}

.is-wrong {
  color: #e2564f;
  animation: slot-shake 360ms cubic-bezier(0.36, 0.07, 0.19, 0.97) both;
}

@keyframes slot-shake {
  10%,
  90% {
    transform: translateX(-2px);
  }
  20%,
  80% {
    transform: translateX(3px);
  }
  30%,
  50%,
  70% {
    transform: translateX(-5px);
  }
  40%,
  60% {
    transform: translateX(5px);
  }
}
</style>
