<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { NButton, NIcon, NPopconfirm, useMessage } from 'naive-ui'
import { ArrowForwardOutline, CheckmarkDoneOutline, TrashOutline } from '@vicons/ionicons5'
import type { WrongBookCounts, WrongBookEntry } from '@shared/types'

const router = useRouter()
const message = useMessage()
const scope = ref<'today' | 'all'>('today')
const entries = ref<WrongBookEntry[]>([])
const counts = ref<WrongBookCounts>({ today: 0, total: 0 })
const loading = ref(true)
const removing = ref<number | null>(null)
let unsubscribe: (() => void) | null = null

const scopeHint = computed(() =>
  scope.value === 'today' ? '今天答错过的词' : '所有答错过的词'
)

async function reload(): Promise<void> {
  try {
    const [list, c] = await Promise.all([window.ganci.wrongsList(scope.value), window.ganci.wrongsCounts()])
    entries.value = list
    counts.value = c
  } catch (err) {
    message.error(err instanceof Error ? err.message : '读取错词本失败')
  } finally {
    loading.value = false
  }
}

async function removeWord(id: number): Promise<void> {
  removing.value = id
  try {
    await window.ganci.wrongsRemove([id])
    message.success('已移出错词本')
  } catch (err) {
    message.error(err instanceof Error ? err.message : '移出失败')
  } finally {
    removing.value = null
  }
}

function formatWhen(ts: number): string {
  const d = new Date(ts)
  const nowD = new Date()
  const start = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate()).getTime()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (ts >= start) return `今天 ${hm}`
  if (ts >= start - 86_400_000) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

watch(scope, () => {
  loading.value = true
  void reload()
})

onMounted(async () => {
  await reload()
  unsubscribe = window.ganci.onDataChanged(() => void reload())
})

onBeforeUnmount(() => {
  unsubscribe?.()
})
</script>

<template>
  <div class="mx-auto max-w-[980px] px-8 py-7">
    <header class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-[20px] font-semibold">错词本</h1>
        <div class="mt-1 text-[12px] text-muted">
          答错一次就会永久收进这里，只有你手动移出才会消失
        </div>
      </div>
      <div class="flex shrink-0 gap-2">
        <n-button size="large" @click="router.push('/learn')">
          <template #icon>
            <n-icon :component="ArrowForwardOutline" />
          </template>
          去背新词
        </n-button>
        <n-button
          type="primary"
          size="large"
          :disabled="counts.total === 0"
          @click="router.push({ path: '/learn', query: { scope: 'wrong' } })"
        >
          开始复习错词
        </n-button>
      </div>
    </header>

    <section class="mt-5 grid grid-cols-3 gap-3">
      <div class="card-surface px-5 py-4">
        <div class="text-[11px] text-muted">错词总数</div>
        <div class="num-display mt-1 text-[26px] font-semibold leading-none text-danger">
          {{ counts.total }}
        </div>
        <div class="mt-1 text-[11px] text-muted">永久记录，不会自动清除</div>
      </div>
      <div class="card-surface px-5 py-4">
        <div class="text-[11px] text-muted">今日答错</div>
        <div class="num-display mt-1 text-[26px] font-semibold leading-none">{{ counts.today }}</div>
        <div class="mt-1 text-[11px] text-muted">今天答错过的词数</div>
      </div>
      <div class="card-surface px-5 py-4">
        <div class="text-[11px] text-muted">复习规则</div>
        <div class="mt-1.5 text-[13px] font-semibold">每轮最多 10 个</div>
        <div class="mt-0.5 text-[11px] text-muted">答对不再自动移出</div>
      </div>
    </section>

    <div class="mt-5 flex items-center justify-between gap-3">
      <div class="seg-tabs">
        <button
          type="button"
          :class="['seg-tab', scope === 'today' ? 'is-active' : '']"
          @click="scope = 'today'"
        >
          今日
          <span class="seg-count">{{ counts.today }}</span>
        </button>
        <button
          type="button"
          :class="['seg-tab', scope === 'all' ? 'is-active' : '']"
          @click="scope = 'all'"
        >
          全部
          <span class="seg-count">{{ counts.total }}</span>
        </button>
      </div>
      <div class="text-[11px] text-muted">{{ scopeHint }}</div>
    </div>

    <section v-if="loading" class="mt-3 rounded-card border border-line px-6 py-12 text-center text-[13px] text-muted">
      正在读取错词本…
    </section>

    <section
      v-else-if="entries.length === 0"
      class="mt-3 flex flex-col items-center rounded-card border border-line px-6 py-14"
    >
      <n-icon :component="CheckmarkDoneOutline" :size="30" class="text-muted" />
      <div class="mt-3 text-[15px] font-semibold">
        {{ scope === 'today' ? '今天还没有答错的词' : '错词本还是空的' }}
      </div>
      <div class="mt-1.5 text-[12px] text-muted">
        {{ scope === 'today' ? '今天答错的词会自动出现在这里' : '去背一轮新词，答错的会自动收进错词本' }}
      </div>
      <n-button class="mt-4" type="primary" @click="router.push('/learn')">开始背单词</n-button>
    </section>

    <section v-else class="card-surface mt-3 overflow-hidden">
      <div
        v-for="(w, i) in entries"
        :key="w.wordId"
        class="flex items-center gap-4 border-b border-line px-5 py-3 last:border-0"
      >
        <span class="num-display w-6 shrink-0 text-[11px] text-muted">{{ i + 1 }}</span>
        <div class="min-w-0 flex-1">
          <div class="flex items-baseline gap-2">
            <span class="font-term text-[16px]">{{ w.term }}</span>
            <span v-if="w.phonetic" class="text-[11px] text-muted">{{ w.phonetic }}</span>
          </div>
          <div class="mt-0.5 truncate text-[12px] text-muted">{{ w.meaning || '暂无释义' }}</div>
        </div>
        <div class="shrink-0 text-right text-[11px] text-muted">{{ formatWhen(w.lastWrongAt) }}</div>
        <n-popconfirm
          positive-text="移出"
          negative-text="再想想"
          @positive-click="removeWord(w.wordId)"
        >
          <template #trigger>
            <n-button
              quaternary
              size="small"
              :loading="removing === w.wordId"
              :title="`把 ${w.term} 移出错词本`"
            >
              <template #icon>
                <n-icon :component="TrashOutline" />
              </template>
              移出
            </n-button>
          </template>
          移出后只有再次答错才会重新记录，确定移出「{{ w.term }}」？
        </n-popconfirm>
      </div>
    </section>

    <div v-if="!loading && entries.length" class="mt-4 flex justify-end">
      <n-button
        type="primary"
        size="large"
        @click="router.push({ path: '/learn', query: { scope: 'wrong' } })"
      >
        复习错词（每轮取 {{ Math.min(counts.total, 10) }} 个）
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.seg-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 3px;
  border-radius: 10px;
  background: var(--color-surface-2);
}
.seg-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-muted);
  font-size: 12px;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.seg-tab:hover {
  color: var(--color-fg);
}
.seg-tab.is-active {
  background: var(--color-surface);
  color: var(--color-fg);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}
.seg-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--color-surface-2);
  font-size: 11px;
  text-align: center;
}
.seg-tab.is-active .seg-count {
  background: var(--color-brand-soft, var(--color-surface-2));
  color: var(--color-brand);
}
</style>
