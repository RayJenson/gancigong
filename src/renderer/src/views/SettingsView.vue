<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import { NButton, NCheckbox, NInput, NInputNumber, NModal, NPopconfirm, NSelect, NSwitch, useDialog, useMessage } from 'naive-ui'
import { useAppStore } from '@renderer/stores/app'
import { parseHHMM } from '@shared/time'
import type { LockLevel, PracticeMode, ReviewMode, Settings, TimeWindow } from '@shared/types'

const store = useAppStore()
const message = useMessage()
const dialog = useDialog()

const settings = computed(() => store.settings)

/** 时段在本地编辑，失焦/增删时才落库，避免每敲一个字就重排程 */
const windows = ref<TimeWindow[]>([])
const windowError = ref('')
let windowSeq = 0

function syncWindows(): void {
  windows.value = settings.value.windows.map((w) => ({ ...w }))
}
watch(() => settings.value.windows, syncWindows, { immediate: true, deep: true })

function validate(list: TimeWindow[]): string {
  if (!list.length) return '至少保留一个复习时段'
  for (const w of list) {
    const s = parseHHMM(w.start)
    const e = parseHHMM(w.end)
    if (s === null || e === null) return `「${w.start || '?'}–${w.end || '?'}」不是合法时间`
    if (e <= s) return '时段的结束时间要晚于开始时间（暂不支持跨零点）'
  }
  return ''
}

async function saveWindows(): Promise<void> {
  windowError.value = validate(windows.value)
  if (windowError.value) {
    message.warning(windowError.value)
    syncWindows()
    return
  }
  // ref 里的时段数组同样是 Proxy，跨 contextBridge 无法序列化，先拷成普通对象
  if (await store.save({ windows: windows.value.map((w) => ({ ...w })) })) windowError.value = ''
  else message.error('时段保存失败')
}

function addWindow(): void {
  windowSeq += 1
  windows.value.push({ id: `w${Date.now()}_${windowSeq}`, start: '09:00', end: '21:30' })
}

function removeWindow(index: number): void {
  windows.value.splice(index, 1)
  void saveWindows()
}

async function setMode(mode: ReviewMode): Promise<void> {
  await store.save({ mode })
}

const practiceOptions: { label: string; value: PracticeMode }[] = [
  { label: '自动：新词默写，复习后选义', value: 'auto' },
  { label: '默写：看中文拼英文', value: 'spell' },
  { label: '看词选义：看英文选释义', value: 'choice' },
]

const practiceHint = computed(() => {
  switch (settings.value.practiceMode) {
    case 'spell':
      return '每张卡都只给中文，让你把英文拼出来；拼错任何字母都记为不认识。缺释义的词仍走翻牌。'
    case 'choice':
      return '每张卡都显示英文，给 4 个中文释义让你选；选错记为不认识。缺释义或干扰项不足时走翻牌。'
    default:
      return '新词第一次先默写，复习过的词改为四选一。两种题型都会自动判定认识/不认识。'
  }
})

function setLockLevel(level: LockLevel): void {
  if (level === settings.value.lockLevel) return
  if (level === 'app') {
    void store.save({ lockLevel: 'app' })
    return
  }
  dialog.warning({
    title: '开启 Kiosk 级锁定？',
    content: () =>
      h('div', { class: 'text-[13px] leading-6' }, [
        h('p', {}, '全屏复习期间会屏蔽这些系统操作：'),
        h('ul', { class: 'my-2 list-disc pl-5' }, [
          h('li', {}, 'Win 键（含开始菜单、Win+D、Win+L）'),
          h('li', {}, 'Alt + Tab 切换窗口'),
          h('li', {}, 'Alt + F4 关闭窗口、Alt + Space 菜单'),
          h('li', {}, 'Ctrl + Esc 打开开始菜单'),
        ]),
        h('p', { class: 'font-semibold text-danger' }, 'Ctrl + Alt + Del 属于系统安全序列，任何软件都无法屏蔽——这是刻意保留的最后退路。'),
        h('p', { class: 'mt-2' }, `本轮逃生键：${store.flow?.escapeShortcutCombo ?? 'Ctrl + Alt + Esc'}。主进程异常时键盘钩子会在十几秒内自动解除，不会把你的桌面锁死。`),
      ]),
    positiveText: '我了解，开启 Kiosk',
    negativeText: '先用应用级',
    onPositiveClick: () => {
      void store.save({ lockLevel: 'kiosk' })
      if (!store.flow?.escapeShortcutReady) {
        message.warning('逃生快捷键注册失败，强制全屏会自动降级为温和弹窗')
      }
    },
  })
}

type NumberKey = 'intervalMinutes' | 'wordsPerRound' | 'delayQuotaPerDay' | 'delayMinutes'

async function saveNumber(key: NumberKey, raw: number | null): Promise<void> {
  if (raw === null) return
  const patch: Partial<Settings> = {}
  patch[key] = raw
  await store.save(patch)
}

const showDictDetail = ref(false)
const testTerm = ref('abandon')
const testHit = ref<{ phonetic: string; meaning: string; matchedVia?: string } | null>(null)
const testSearched = ref(false)

async function testDictionary(): Promise<void> {
  const term = testTerm.value.trim()
  if (!term) return
  const hit = await window.ganci.dictLookup(term).catch(() => null)
  testHit.value = hit ? { phonetic: hit.phonetic, meaning: hit.meaning, matchedVia: hit.matchedVia } : null
  testSearched.value = true
}

async function openDataDir(): Promise<void> {
  try {
    await window.ganci.openDataDir()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '打开目录失败')
  }
}

const dictKb = computed(() => {
  const bytes = store.dictionary?.bytes ?? 0
  return bytes ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : '—'
})
const escapeComboLabel = computed(() => {
  const raw = store.flow?.escapeShortcutCombo ?? 'CommandOrControl+Alt+Escape'
  return raw.replace('CommandOrControl', 'Ctrl / ⌘').replace('Escape', 'Esc')
})
const lockAllHint = computed(() =>
  store.settings.lockAllDisplays ? '所有显示器都会进入全屏，副屏显示遮罩' : '只在主显示器全屏，副屏照常可用'
)
</script>

<template>
  <div class="mx-auto max-w-[820px] px-8 py-7">
    <header class="flex items-center justify-between">
      <h1 class="text-[20px] font-semibold">设置</h1>
      <div class="text-[12px] text-muted">改动即时生效，无需保存</div>
    </header>

    <section class="card-surface mt-5 px-5 py-4">
      <h2 class="text-[14px] font-semibold">复习时段</h2>
      <p class="mt-1 text-[12px] text-muted">只在这些时间区间内打扰你；区间外不会弹窗。</p>

      <div class="mt-3 space-y-2">
        <div v-for="(w, i) in windows" :key="w.id" class="flex items-center gap-2">
          <n-input v-model:value="w.start" size="small" class="w-[96px]" placeholder="09:00" @blur="saveWindows" />
          <span class="text-muted">–</span>
          <n-input v-model:value="w.end" size="small" class="w-[96px]" placeholder="21:30" @blur="saveWindows" />
          <n-popconfirm @positive-click="removeWindow(i)">
            <template #trigger>
              <n-button size="tiny" text type="error">删除</n-button>
            </template>
            删除这个时段？
          </n-popconfirm>
        </div>
      </div>
      <div v-if="windowError" class="mt-2 text-[12px] text-danger">{{ windowError }}</div>
      <n-button size="small" class="mt-3" @click="addWindow">添加时段</n-button>

      <div class="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4">
        <label class="block">
          <span class="text-[12px] text-muted">弹窗间隔（1–240 分钟）</span>
          <n-input-number
            :value="settings.intervalMinutes"
            size="small"
            class="mt-1 w-full"
            :min="1"
            :max="240"
            @update:value="(v: number | null) => saveNumber('intervalMinutes', v)"
          />
        </label>
        <label class="block">
          <span class="text-[12px] text-muted">单次单词数（1–60）</span>
          <n-input-number
            :value="settings.wordsPerRound"
            size="small"
            class="mt-1 w-full"
            :min="1"
            :max="60"
            @update:value="(v: number | null) => saveNumber('wordsPerRound', v)"
          />
        </label>
      </div>
    </section>

    <section class="card-surface mt-4 px-5 py-4">
      <h2 class="text-[14px] font-semibold">复习形态</h2>
      <div class="mt-3 space-y-2 text-[13px]">
        <label class="flex cursor-pointer items-start gap-2">
          <n-checkbox :checked="settings.mode === 'gentle'" @update:checked="setMode('gentle')" />
          <span>
            <b>温和弹窗</b>
            <span class="block text-[12px] text-muted">右上角常驻小窗，可以关掉（算一次延后），不影响你继续用电脑。</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-2">
          <n-checkbox :checked="settings.mode === 'fullscreen'" @update:checked="setMode('fullscreen')" />
          <span>
            <b>强制全屏</b>
            <span class="block text-[12px] text-muted">全屏遮住桌面，标记完本轮最后一个词才能回到桌面。</span>
          </span>
        </label>
      </div>

      <div class="mt-4 border-t border-line pt-4">
        <div class="text-[12px] text-muted">出题方式</div>
        <n-select
          class="mt-2 max-w-[360px]"
          size="small"
          :value="settings.practiceMode"
          :options="practiceOptions"
          @update:value="(v: PracticeMode) => store.save({ practiceMode: v })"
        />
        <div class="mt-2 text-[12px] text-muted">{{ practiceHint }}</div>
      </div>

      <div v-if="settings.mode === 'fullscreen'" class="mt-4 border-t border-line pt-4">
        <div class="text-[12px] text-muted">锁定强度</div>
        <div class="mt-2 space-y-2 text-[13px]">
          <label class="flex cursor-pointer items-start gap-2">
            <n-checkbox :checked="settings.lockLevel === 'app'" @update:checked="setLockLevel('app')" />
            <span>
              <b>应用级</b>
              <span class="block text-[12px] text-muted">只锁本程序窗口：置顶、抢焦点、隐藏关闭入口。零风险。</span>
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-2">
            <n-checkbox :checked="settings.lockLevel === 'kiosk'" @update:checked="setLockLevel('kiosk')" />
            <span>
              <b>Kiosk 级</b>
              <span class="block text-[12px] text-muted">
                额外屏蔽 Win / Alt+Tab / Alt+F4 / Ctrl+Esc；逃生键 {{ escapeComboLabel }} 常驻，Ctrl+Alt+Del 始终可用。
              </span>
            </span>
          </label>
        </div>

        <div class="mt-3 flex items-start gap-2">
          <n-switch :value="settings.lockAllDisplays" size="small" @update:value="(v: boolean) => store.save({ lockAllDisplays: v })" />
          <div>
            <div class="text-[13px]">所有显示器一起锁</div>
            <div class="text-[12px] text-muted">{{ lockAllHint }}</div>
          </div>
        </div>

        <div v-if="!store.flow?.escapeShortcutReady" class="mt-3 rounded-pop border border-danger/40 bg-danger/5 px-3 py-2 text-[12px] text-danger">
          逃生快捷键 {{ escapeComboLabel }} 当前注册失败（可能被其他程序占用）。此时选强制全屏会自动降级为温和弹窗，不会锁死桌面。
        </div>
      </div>
    </section>

    <section class="card-surface mt-4 px-5 py-4">
      <h2 class="text-[14px] font-semibold">延后策略</h2>
      <p class="mt-1 text-[12px] text-muted">给自己留口气，也防止无限摆烂：额度用完，弹窗里就只剩「开始复习」。</p>
      <div class="mt-3 grid grid-cols-2 gap-4">
        <label class="block">
          <span class="text-[12px] text-muted">每日延后次数（0–20）</span>
          <n-input-number
            :value="settings.delayQuotaPerDay"
            size="small"
            class="mt-1 w-full"
            :min="0"
            :max="20"
            @update:value="(v: number | null) => saveNumber('delayQuotaPerDay', v)"
          />
        </label>
        <label class="block">
          <span class="text-[12px] text-muted">每次推迟（1–120 分钟）</span>
          <n-input-number
            :value="settings.delayMinutes"
            size="small"
            class="mt-1 w-full"
            :min="1"
            :max="120"
            @update:value="(v: number | null) => saveNumber('delayMinutes', v)"
          />
        </label>
      </div>
      <div class="mt-3 text-[12px] text-muted">
        今日已用 <b class="num-display">{{ store.dashboard?.delayUsed ?? 0 }}</b> /
        {{ store.dashboard?.delayQuota ?? settings.delayQuotaPerDay }} 次；推迟后的时间点会自动钳进复习时段。
      </div>
    </section>

    <section class="card-surface mt-4 px-5 py-4">
      <h2 class="text-[14px] font-semibold">提醒与快捷键</h2>
      <div class="mt-3 space-y-3 text-[13px]">
        <div class="flex items-center gap-2">
          <n-switch :value="settings.autostart" size="small" @update:value="(v: boolean) => store.save({ autostart: v })" />
          <span>开机自动启动</span>
          <span class="text-[12px] text-muted">打包安装后生效，开发版仅记录开关</span>
        </div>
        <div class="flex items-center gap-2">
          <n-switch :value="settings.ttsEnabled" size="small" @update:value="(v: boolean) => store.save({ ttsEnabled: v })" />
          <span>复习时用系统发音朗读单词</span>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-muted">紧急逃生快捷键</span>
          <b class="num-display">{{ escapeComboLabel }}</b>
          <span v-if="store.flow?.escapeShortcutReady" class="text-[12px] text-brand">已注册</span>
          <span v-else class="text-[12px] text-danger">注册失败，强制全屏将自动降级</span>
        </div>
      </div>
    </section>

    <section class="card-surface mt-4 px-5 py-4">
      <h2 class="text-[14px] font-semibold">数据与隐私</h2>
      <p class="mt-1 text-[12px] text-muted">单词、复习记录、设置全部在本机 SQLite；不联网、不上传。</p>
      <div class="mt-3 text-[12px]">
        <div class="text-muted">数据目录</div>
        <div class="mt-1 select-text break-all font-mono text-ink/80">{{ store.dataDir }}</div>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <n-button size="small" @click="openDataDir">打开数据目录</n-button>
        <n-button size="small" @click="showDictDetail = true">离线词典</n-button>
      </div>
    </section>

    <n-modal v-model:show="showDictDetail" preset="card" title="离线词典" class="w-[460px]">
      <div class="text-[13px] leading-7">
        <div class="grid grid-cols-2 gap-2">
          <div class="card-surface px-3 py-2">词条 <b class="num-display">{{ (store.dictionary?.count ?? 0).toLocaleString() }}</b></div>
          <div class="card-surface px-3 py-2">体积 <b class="num-display">{{ dictKb }}</b></div>
        </div>
        <div class="mt-2 text-[12px] text-muted">
          来源：{{ store.dictionary?.source || 'ECDICT（MIT）精简考试词库' }} · 生成于 {{ store.dictionary?.generatedAt || '—' }}
        </div>
        <div class="mt-3 flex items-center gap-2">
          <n-input v-model:value="testTerm" size="small" class="w-[150px]" placeholder="查一个词" @keyup.enter="testDictionary" />
          <n-button size="small" type="primary" @click="testDictionary">查询</n-button>
        </div>
        <div v-if="testSearched" class="mt-2 text-[12px]">
          <template v-if="testHit">
            <div class="font-term text-[14px] font-semibold">{{ testTerm }}</div>
            <div v-if="testHit.phonetic" class="num-display text-muted">/{{ testHit.phonetic }}/</div>
            <div class="text-ink/85">{{ testHit.meaning }}</div>
            <div v-if="testHit.matchedVia" class="text-muted">按词形「{{ testHit.matchedVia }}」还原到原形</div>
          </template>
          <div v-else class="text-accent">词典里没有这个词——导入时它会标成「待补充释义」。</div>
        </div>
      </div>
    </n-modal>
  </div>
</template>
