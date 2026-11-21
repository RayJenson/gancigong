<script setup lang="ts">
import { computed, h, ref, watch } from 'vue'
import {
  NButton,
  NIcon,
  NInput,
  NInputNumber,
  NModal,
  NPopconfirm,
  NSelect,
  NSlider,
  NSwitch,
  useDialog,
  useMessage,
} from 'naive-ui'
import {
  AddOutline,
  BookOutline,
  CalendarOutline,
  CloudOfflineOutline,
  ColorPaletteOutline,
  DesktopOutline,
  FolderOpenOutline,
  HardwareChipOutline,
  HourglassOutline,
  ImageOutline,
  InformationCircleOutline,
  LayersOutline,
  LockClosedOutline,
  MoonOutline,
  NotificationsOutline,
  ShieldCheckmarkOutline,
  SpeedometerOutline,
  SunnyOutline,
  TimeOutline,
  TrashOutline,
  WarningOutline,
} from '@vicons/ionicons5'
import { ACCENTS } from '@renderer/lib/accents'
import { useAppStore } from '@renderer/stores/app'
import { parseHHMM } from '@shared/time'
import type { LockLevel, PracticeMode, ReviewMode, Settings, ThemeMode, TimeWindow } from '@shared/types'

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
  void saveWindows()
}

function removeWindow(index: number): void {
  windows.value.splice(index, 1)
  void saveWindows()
}

function windowDuration(w: TimeWindow): string {
  const s = parseHHMM(w.start)
  const e = parseHHMM(w.end)
  if (s === null || e === null || e <= s) return '待修正'
  const minutes = e - s
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} 分钟`
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
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
        h('p', { class: 'mt-2' }, `本轮逃生键：${escapeComboLabel.value}。主进程异常时键盘钩子会在十几秒内自动解除，不会把你的桌面锁死。`),
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

type NumberKey =
  | 'intervalMinutes'
  | 'wordsPerRound'
  | 'dailyNewWords'
  | 'delayQuotaPerDay'
  | 'delayMinutes'

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

const scheduleSummary = computed(() => {
  const first = windows.value[0]
  return first ? `${first.start} – ${first.end}` : '未设置'
})
const modeSummary = computed(() => {
  if (settings.value.mode === 'gentle') return '温和弹窗'
  return settings.value.lockLevel === 'kiosk' ? '全屏 · Kiosk' : '全屏 · 应用级'
})
const delayQuota = computed(() => store.dashboard?.delayQuota ?? settings.value.delayQuotaPerDay)
const delayUsed = computed(() => store.dashboard?.delayUsed ?? 0)
const delayPips = computed(() => Array.from({ length: Math.min(delayQuota.value, 20) }, (_, i) => i < delayUsed.value))
const delayRemaining = computed(() => Math.max(delayQuota.value - delayUsed.value, 0))

const dictKb = computed(() => {
  const bytes = store.dictionary?.bytes ?? 0
  return bytes ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : '—'
})
const escapeKeys = computed(() => {
  const raw = store.flow?.escapeShortcutCombo ?? 'CommandOrControl+Alt+Escape'
  return raw.split('+').map((key) => (key === 'CommandOrControl' ? 'Ctrl' : key === 'Escape' ? 'Esc' : key))
})
const escapeComboLabel = computed(() => escapeKeys.value.join(' + '))
const lockAllHint = computed(() =>
  store.settings.lockAllDisplays ? '所有显示器都会进入全屏，副屏显示遮罩' : '只在主显示器全屏，副屏照常可用'
)

const themeOptions: { value: ThemeMode; label: string; icon: typeof SunnyOutline }[] = [
  { value: 'light', label: '亮色', icon: SunnyOutline },
  { value: 'dark', label: '暗色', icon: MoonOutline },
  { value: 'system', label: '跟随系统', icon: DesktopOutline },
]

const themeBusy = ref(false)

async function changeBackground(): Promise<void> {
  themeBusy.value = true
  try {
    await store.pickThemeBackground()
  } catch (err) {
    message.error(err instanceof Error ? err.message : '导入背景失败')
  } finally {
    themeBusy.value = false
  }
}

async function removeBackground(): Promise<void> {
  try {
    await store.clearThemeBackground()
  } catch {
    message.error('移除背景失败')
  }
}
</script>

<template>
  <div class="settings">
    <header class="page-head">
      <div>
        <div class="eyebrow">偏好设置</div>
        <h1 class="page-title">设置</h1>
        <p class="page-sub">把节奏调成你舒服的样子，剩下的交给赶词工按时敲门</p>
      </div>
      <div class="autosave">
        <span class="dot" />
        改动即时生效 · 只存本机
      </div>
    </header>

    <section class="summary" aria-label="当前配置概览">
      <div class="summary-item">
        <span class="summary-ico"><n-icon :component="TimeOutline" :size="14" /></span>
        <div class="summary-body">
          <span class="summary-label">复习时段</span>
          <span class="summary-value">
            {{ scheduleSummary }}
            <em v-if="windows.length > 1" class="summary-extra">+{{ windows.length - 1 }} 段</em>
          </span>
        </div>
      </div>
      <div class="summary-item">
        <span class="summary-ico"><n-icon :component="SpeedometerOutline" :size="14" /></span>
        <div class="summary-body">
          <span class="summary-label">弹窗间隔</span>
          <span class="summary-value">{{ settings.intervalMinutes }} 分钟</span>
        </div>
      </div>
      <div class="summary-item">
        <span class="summary-ico"><n-icon :component="BookOutline" :size="14" /></span>
        <div class="summary-body">
          <span class="summary-label">每日新词</span>
          <span class="summary-value">{{ settings.dailyNewWords }} 词</span>
        </div>
      </div>
      <div class="summary-item">
        <span class="summary-ico"><n-icon :component="LayersOutline" :size="14" /></span>
        <div class="summary-body">
          <span class="summary-label">复习形态</span>
          <span class="summary-value">{{ modeSummary }}</span>
        </div>
      </div>
    </section>

    <div class="columns">
      <div class="col-main">
        <section class="panel">
          <header class="panel-head">
            <span class="panel-ico"><n-icon :component="CalendarOutline" :size="16" /></span>
            <div>
              <h2 class="panel-title">复习时段</h2>
              <p class="panel-desc">只在这些时间区间内打扰你，区间外不会弹窗。</p>
            </div>
            <span class="panel-index">01</span>
          </header>

          <div class="window-list">
            <div v-for="(w, i) in windows" :key="w.id" class="window-row">
              <span class="window-index">{{ String(i + 1).padStart(2, '0') }}</span>
              <div class="window-times">
                <n-input
                  v-model:value="w.start"
                  class="time-input"
                  size="small"
                  placeholder="09:00"
                  @blur="saveWindows"
                />
                <span class="window-dash">–</span>
                <n-input
                  v-model:value="w.end"
                  class="time-input"
                  size="small"
                  placeholder="21:30"
                  @blur="saveWindows"
                />
              </div>
              <span class="window-duration">{{ windowDuration(w) }}</span>
              <n-popconfirm @positive-click="removeWindow(i)">
                <template #trigger>
                  <n-button class="window-del" size="tiny" quaternary type="error" aria-label="删除这个时段">
                    <template #icon>
                      <n-icon :component="TrashOutline" :size="14" />
                    </template>
                  </n-button>
                </template>
                删除这个时段？
              </n-popconfirm>
            </div>
          </div>

          <button type="button" class="add-window" @click="addWindow">
            <n-icon :component="AddOutline" :size="14" />
            添加时段
          </button>
          <div v-if="windowError" class="window-error">
            <n-icon :component="WarningOutline" :size="13" />
            {{ windowError }}
          </div>

          <div class="field-grid">
            <label class="field">
              <span class="field-head">
                <span class="field-label">弹窗间隔</span>
                <span class="field-range">1–240</span>
              </span>
              <n-input-number
                :value="settings.intervalMinutes"
                class="num-input"
                size="small"
                :min="1"
                :max="240"
                @update:value="(v: number | null) => saveNumber('intervalMinutes', v)"
              >
                <template #suffix><span class="unit">分钟</span></template>
              </n-input-number>
            </label>
            <label class="field">
              <span class="field-head">
                <span class="field-label">单次单词数</span>
                <span class="field-range">1–60</span>
              </span>
              <n-input-number
                :value="settings.wordsPerRound"
                class="num-input"
                size="small"
                :min="1"
                :max="60"
                @update:value="(v: number | null) => saveNumber('wordsPerRound', v)"
              >
                <template #suffix><span class="unit">词</span></template>
              </n-input-number>
            </label>
            <label class="field">
              <span class="field-head">
                <span class="field-label">每日新词目标</span>
                <span class="field-range">1–100</span>
              </span>
              <n-input-number
                :value="settings.dailyNewWords"
                class="num-input"
                size="small"
                :min="1"
                :max="100"
                @update:value="(v: number | null) => saveNumber('dailyNewWords', v)"
              >
                <template #suffix><span class="unit">词</span></template>
              </n-input-number>
            </label>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head">
            <span class="panel-ico"><n-icon :component="SpeedometerOutline" :size="16" /></span>
            <div>
              <h2 class="panel-title">复习形态</h2>
              <p class="panel-desc">决定到点时它以多强势的方式出现。</p>
            </div>
            <span class="panel-index">02</span>
          </header>

          <div class="choice-grid" role="group" aria-label="复习形态">
            <button
              type="button"
              class="choice-card"
              :class="{ 'is-active': settings.mode === 'gentle' }"
              :aria-pressed="settings.mode === 'gentle'"
              @click="setMode('gentle')"
            >
              <span class="choice-top">
                <span class="choice-ico"><n-icon :component="MoonOutline" :size="15" /></span>
                <span class="choice-name">温和弹窗</span>
                <span class="choice-mark" aria-hidden="true" />
              </span>
              <span class="choice-desc">右上角常驻小窗，可以关掉（算一次延后），不影响你继续用电脑。</span>
            </button>
            <button
              type="button"
              class="choice-card"
              :class="{ 'is-active': settings.mode === 'fullscreen' }"
              :aria-pressed="settings.mode === 'fullscreen'"
              @click="setMode('fullscreen')"
            >
              <span class="choice-top">
                <span class="choice-ico"><n-icon :component="DesktopOutline" :size="15" /></span>
                <span class="choice-name">强制全屏</span>
                <span class="choice-mark" aria-hidden="true" />
              </span>
              <span class="choice-desc">全屏遮住桌面，标记完本轮最后一个词才能回到桌面。</span>
            </button>
          </div>

          <div class="sub-block">
            <div class="sub-title">出题方式</div>
            <n-select
              class="practice-select"
              size="small"
              :value="settings.practiceMode"
              :options="practiceOptions"
              @update:value="(v: PracticeMode) => store.save({ practiceMode: v })"
            />
            <div class="hint">
              <n-icon :component="InformationCircleOutline" :size="14" class="hint-ico" />
              <span>{{ practiceHint }}</span>
            </div>
          </div>

          <div v-if="settings.mode === 'fullscreen'" class="sub-block reveal">
            <div class="sub-title">锁定强度</div>
            <div class="lock-list" role="group" aria-label="锁定强度">
              <button
                type="button"
                class="lock-row"
                :class="{ 'is-active': settings.lockLevel === 'app' }"
                :aria-pressed="settings.lockLevel === 'app'"
                @click="setLockLevel('app')"
              >
                <span class="lock-dot" aria-hidden="true" />
                <span class="lock-body">
                  <span class="lock-name"><n-icon :component="LockClosedOutline" :size="13" /> 应用级</span>
                  <span class="lock-desc">只锁本程序窗口：置顶、抢焦点、隐藏关闭入口。零风险。</span>
                </span>
              </button>
              <button
                type="button"
                class="lock-row"
                :class="{ 'is-active': settings.lockLevel === 'kiosk' }"
                :aria-pressed="settings.lockLevel === 'kiosk'"
                @click="setLockLevel('kiosk')"
              >
                <span class="lock-dot" aria-hidden="true" />
                <span class="lock-body">
                  <span class="lock-name">
                    <n-icon :component="ShieldCheckmarkOutline" :size="13" /> Kiosk 级
                    <span class="lock-tag">强锁定</span>
                  </span>
                  <span class="lock-desc">
                    额外屏蔽 Win / Alt+Tab / Alt+F4 / Ctrl+Esc；逃生键 {{ escapeComboLabel }} 常驻，Ctrl+Alt+Del 始终可用。
                  </span>
                </span>
              </button>
            </div>

            <div class="switch-row">
              <div class="switch-text">
                <div class="switch-title">所有显示器一起锁</div>
                <div class="switch-desc">{{ lockAllHint }}</div>
              </div>
              <n-switch
                :value="settings.lockAllDisplays"
                size="small"
                @update:value="(v: boolean) => store.save({ lockAllDisplays: v })"
              />
            </div>

            <div v-if="!store.flow?.escapeShortcutReady" class="warn">
              <n-icon :component="WarningOutline" :size="14" class="warn-ico" />
              <span>
                逃生快捷键 {{ escapeComboLabel }} 当前注册失败（可能被其他程序占用）。此时选强制全屏会自动降级为温和弹窗，不会锁死桌面。
              </span>
            </div>
          </div>
        </section>

        <section class="panel">
          <header class="panel-head">
            <span class="panel-ico"><n-icon :component="HourglassOutline" :size="16" /></span>
            <div>
              <h2 class="panel-title">延后策略</h2>
              <p class="panel-desc">给自己留口气，也防止无限摆烂。</p>
            </div>
            <span class="panel-index">03</span>
          </header>

          <div class="delay-meter">
            <div>
              <div class="delay-num">{{ delayUsed }}<em>/ {{ delayQuota }} 次</em></div>
              <div class="delay-caption">今日已用 · 还能推迟 {{ delayRemaining }} 次</div>
            </div>
          </div>
          <div v-if="delayPips.length" class="delay-pips" aria-hidden="true">
            <i v-for="(on, i) in delayPips" :key="i" :class="{ on }" />
          </div>

          <div class="field-grid two">
            <label class="field">
              <span class="field-head">
                <span class="field-label">每日延后次数</span>
                <span class="field-range">0–20</span>
              </span>
              <n-input-number
                :value="settings.delayQuotaPerDay"
                class="num-input"
                size="small"
                :min="0"
                :max="20"
                @update:value="(v: number | null) => saveNumber('delayQuotaPerDay', v)"
              >
                <template #suffix><span class="unit">次</span></template>
              </n-input-number>
            </label>
            <label class="field">
              <span class="field-head">
                <span class="field-label">每次推迟</span>
                <span class="field-range">1–120</span>
              </span>
              <n-input-number
                :value="settings.delayMinutes"
                class="num-input"
                size="small"
                :min="1"
                :max="120"
                @update:value="(v: number | null) => saveNumber('delayMinutes', v)"
              >
                <template #suffix><span class="unit">分钟</span></template>
              </n-input-number>
            </label>
          </div>
          <p class="panel-foot">推迟后的时间点会自动钳进复习时段。</p>
        </section>
      </div>

      <div class="col-side">
        <section class="panel">
          <header class="panel-head">
            <span class="panel-ico"><n-icon :component="ColorPaletteOutline" :size="16" /></span>
            <div>
              <h2 class="panel-title">主题皮肤</h2>
              <p class="panel-desc">亮色、暗色或跟随系统，挑一个主题色，也可以铺一张自己的背景。</p>
            </div>
            <span class="panel-index">04</span>
          </header>

          <div class="theme-grid" role="group" aria-label="主题模式">
            <button
              v-for="opt in themeOptions"
              :key="opt.value"
              type="button"
              class="theme-card"
              :class="{ 'is-active': settings.themeMode === opt.value }"
              :aria-pressed="settings.themeMode === opt.value"
              @click="store.setThemeMode(opt.value)"
            >
              <span class="theme-preview" :class="`is-${opt.value}`" aria-hidden="true">
                <span class="tp-rail" />
                <span class="tp-body">
                  <span class="tp-bar" />
                  <span class="tp-card" />
                  <span class="tp-card short" />
                </span>
                <span v-if="opt.value === 'system'" class="tp-split" />
              </span>
              <span class="theme-name">
                <n-icon :component="opt.icon" :size="13" />
                {{ opt.label }}
                <span class="theme-mark" aria-hidden="true" />
              </span>
            </button>
          </div>

          <div class="sub-block">
            <div class="sub-title">主题色</div>
            <div class="accent-grid" role="group" aria-label="主题色">
              <button
                v-for="accent in ACCENTS"
                :key="accent.id"
                type="button"
                class="accent-card"
                :class="{ 'is-active': settings.themeAccent === accent.id }"
                :aria-pressed="settings.themeAccent === accent.id"
                @click="store.setThemeAccent(accent.id)"
              >
                <span class="accent-dot" :style="{ background: accent.swatch }" aria-hidden="true" />
                <span class="accent-name">{{ accent.name }}</span>
                <span class="theme-mark" aria-hidden="true" />
              </button>
            </div>
          </div>

          <div class="sub-block">
            <div class="sub-title">自定义背景</div>
            <div v-if="store.themeBackgroundUrl" class="skin-current">
              <span
                class="skin-thumb"
                :style="{ backgroundImage: `url(${store.themeBackgroundUrl})` }"
                aria-hidden="true"
              />
              <div class="skin-meta">
                <span class="skin-title">已启用自定义背景</span>
                <span class="skin-sub">图片只保存在本机数据目录</span>
              </div>
              <n-button size="tiny" quaternary :disabled="themeBusy" @click="changeBackground">更换</n-button>
              <n-popconfirm @positive-click="removeBackground">
                <template #trigger>
                  <n-button size="tiny" quaternary type="error" :disabled="themeBusy">移除</n-button>
                </template>
                移除自定义背景？
              </n-popconfirm>
            </div>
            <button v-else type="button" class="skin-upload" :disabled="themeBusy" @click="changeBackground">
              <n-icon :component="ImageOutline" :size="17" />
              <span class="skin-upload-title">{{ themeBusy ? '正在导入…' : '上传背景图片' }}</span>
              <span class="skin-upload-sub">PNG / JPG / WebP · 最大 20 MB</span>
            </button>

            <div v-if="store.themeBackgroundUrl" class="scrim-row">
              <span class="scrim-label">背景显示强度</span>
              <n-slider
                class="scrim-slider"
                :value="settings.themeScrim"
                :min="0"
                :max="100"
                :step="5"
                :tooltip="false"
                @update:value="(v: number) => store.setThemeScrim(v)"
              />
              <span class="scrim-value">{{ settings.themeScrim }}%</span>
            </div>
          </div>
          <p class="panel-foot">壁纸会透在卡片后面，强度越高文字越清晰。</p>
        </section>

        <section class="panel">
          <header class="panel-head">
            <span class="panel-ico"><n-icon :component="NotificationsOutline" :size="16" /></span>
            <div>
              <h2 class="panel-title">提醒与快捷键</h2>
              <p class="panel-desc">常驻桌面、开机与发音习惯。</p>
            </div>
            <span class="panel-index">05</span>
          </header>

          <div class="switch-row">
            <div class="switch-text">
              <div class="switch-title">开机自动启动</div>
              <div class="switch-desc">打包安装后生效，开发版仅记录开关</div>
            </div>
            <n-switch
              :value="settings.autostart"
              size="small"
              @update:value="(v: boolean) => store.save({ autostart: v })"
            />
          </div>
          <div class="switch-row">
            <div class="switch-text">
              <div class="switch-title">自动播报发音</div>
              <div class="switch-desc">学习 / 复习时自动读词，作答后再播一遍</div>
            </div>
            <n-switch
              :value="settings.ttsEnabled"
              size="small"
              @update:value="(v: boolean) => store.save({ ttsEnabled: v })"
            />
          </div>
          <div class="switch-row">
            <div class="switch-text">
              <div class="switch-title">桌面悬浮球</div>
              <div class="switch-desc">常驻桌面，点一下快速复习、背单词或打开页面</div>
            </div>
            <n-switch
              :value="settings.floatBall"
              size="small"
              @update:value="(v: boolean) => store.save({ floatBall: v })"
            />
          </div>

          <div class="shortcut-row">
            <div>
              <div class="shortcut-label">紧急逃生快捷键</div>
              <div class="keys">
                <template v-for="(key, i) in escapeKeys" :key="key">
                  <span v-if="i > 0" class="kbd-sep">+</span>
                  <kbd class="kbd">{{ key }}</kbd>
                </template>
              </div>
            </div>
            <span v-if="store.flow?.escapeShortcutReady" class="pill ok">
              <span class="dot" />已注册
            </span>
            <span v-else class="pill bad">注册失败 · 自动降级</span>
          </div>
        </section>

      </div>
    </div>

    <section class="panel panel-wide">
      <header class="panel-head">
        <span class="panel-ico"><n-icon :component="HardwareChipOutline" :size="16" /></span>
        <div>
          <h2 class="panel-title">数据与隐私</h2>
          <p class="panel-desc">单词、复习记录、设置全部留在本机。</p>
        </div>
        <span class="panel-index">06</span>
      </header>

      <div class="privacy-note">
        <n-icon :component="CloudOfflineOutline" :size="14" />
        本机 SQLite 存储，不联网、不上传
      </div>
      <div class="path-box" :title="store.dataDir">{{ store.dataDir }}</div>
      <div class="data-actions">
        <n-button size="small" @click="openDataDir">
          <template #icon>
            <n-icon :component="FolderOpenOutline" :size="14" />
          </template>
          打开数据目录
        </n-button>
        <n-button size="small" @click="showDictDetail = true">
          <template #icon>
            <n-icon :component="BookOutline" :size="14" />
          </template>
          离线词典
        </n-button>
      </div>
    </section>

    <n-modal
      v-model:show="showDictDetail"
      preset="card"
      title="离线词典"
      style="width: 480px; max-width: calc(100vw - 40px)"
    >
      <div class="dict-body">
        <div class="dict-stats">
          <div class="dict-stat">
            <span>词条</span>
            <b>{{ (store.dictionary?.count ?? 0).toLocaleString() }}</b>
          </div>
          <div class="dict-stat">
            <span>体积</span>
            <b>{{ dictKb }}</b>
          </div>
        </div>
        <div class="dict-meta">
          来源：{{ store.dictionary?.source || 'ECDICT（MIT）精简考试词库' }} · 生成于
          {{ store.dictionary?.generatedAt || '—' }}
        </div>
        <div class="dict-search">
          <n-input v-model:value="testTerm" size="small" placeholder="查一个词" @keyup.enter="testDictionary" />
          <n-button size="small" type="primary" @click="testDictionary">查询</n-button>
        </div>
        <div v-if="testSearched" class="dict-result">
          <template v-if="testHit">
            <div class="dict-word">{{ testTerm }}</div>
            <div v-if="testHit.phonetic" class="dict-phonetic">/{{ testHit.phonetic }}/</div>
            <div class="dict-meaning">{{ testHit.meaning }}</div>
            <div v-if="testHit.matchedVia" class="dict-via">按词形「{{ testHit.matchedVia }}」还原到原形</div>
          </template>
          <div v-else class="dict-miss">词典里没有这个词——导入时它会标成「待补充释义」。</div>
        </div>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.settings {
  margin: 0 auto;
  max-width: 1120px;
  padding: 26px 30px 34px;
}

.eyebrow {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--color-muted);
}

.page-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 16px;
}

.page-title {
  margin: 5px 0 0;
  font-size: 24px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
  color: var(--color-ink);
}

.page-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--color-muted);
}

.autosave {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--color-line);
  border-radius: 999px;
  background: var(--color-surface);
  padding: 6px 12px;
  font-size: 10.5px;
  color: var(--color-muted);
  white-space: nowrap;
}

.autosave .dot {
  height: 6px;
  width: 6px;
  border-radius: 50%;
  background: #3e9c74;
  box-shadow: 0 0 0 3px rgb(62 156 116 / 0.14);
}

.summary {
  display: flex;
  align-items: stretch;
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background:
    radial-gradient(120% 160% at 100% 0%, rgb(194 121 44 / 0.06), transparent 55%),
    linear-gradient(165deg, var(--color-surface), var(--color-surface-2));
  box-shadow: 0 1px 2px rgb(28 36 31 / 0.03);
}

.summary-item {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 11px 16px;
}

.summary-item + .summary-item {
  border-left: 1px solid var(--color-line);
}

.summary-ico {
  display: grid;
  height: 28px;
  width: 28px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-brand) 7%, var(--color-raised));
  color: var(--color-brand);
}

.summary-body {
  min-width: 0;
}

.summary-label {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--color-muted);
}

.summary-value {
  display: block;
  margin-top: 1px;
  overflow: hidden;
  font-family: var(--font-term);
  font-size: 15px;
  font-weight: 600;
  color: var(--color-ink);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.summary-extra {
  margin-left: 6px;
  font-family: var(--font-sans);
  font-size: 10px;
  font-style: normal;
  font-weight: 500;
  color: #8a5a1c;
}

.columns {
  display: grid;
  grid-template-columns: minmax(0, 1.38fr) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
  margin-top: 14px;
}

.col-main,
.col-side {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 14px;
}

.panel {
  border: 1px solid var(--color-line);
  border-radius: var(--radius-card);
  background: var(--color-surface);
  padding: 18px 20px 20px;
  box-shadow: 0 1px 2px rgb(28 36 31 / 0.03);
}

.panel-head {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  margin-bottom: 14px;
}

.panel-ico {
  display: grid;
  height: 32px;
  width: 32px;
  flex: none;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-brand) 12%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-brand) 8%, var(--color-raised));
  color: var(--color-brand);
}

.panel-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--color-ink);
}

.panel-desc {
  margin: 2px 0 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--color-muted);
}

.panel-index {
  margin-left: auto;
  padding-top: 2px;
  font-family: var(--font-term);
  font-size: 12px;
  letter-spacing: 0.08em;
  color: color-mix(in srgb, var(--color-muted) 42%, transparent);
}

.panel-foot {
  margin: 10px 0 0;
  font-size: 10.5px;
  color: var(--color-muted);
}

/* 数据与隐私：横跨底部的收尾卡片，让两栏高度收在一条线上 */
.panel-wide {
  display: grid;
  grid-template-columns: minmax(230px, 0.8fr) minmax(0, 1.6fr) auto;
  grid-template-areas:
    'head note actions'
    'head path actions';
  align-items: center;
  column-gap: 26px;
  margin-top: 14px;
}

.panel-wide .panel-head {
  grid-area: head;
  margin-bottom: 0;
}

.panel-wide .privacy-note {
  grid-area: note;
  align-self: end;
  padding-bottom: 3px;
}

.panel-wide .path-box {
  grid-area: path;
  align-self: start;
  margin-top: 4px;
}

.panel-wide .data-actions {
  grid-area: actions;
  flex-wrap: nowrap;
  margin-top: 0;
}

/* 复习时段 */
.window-list {
  display: flex;
  flex-direction: column;
}

.window-row {
  display: flex;
  align-items: center;
  gap: 10px;
  border-bottom: 1px dashed var(--color-line);
  padding: 8px 0;
}

.window-index {
  display: grid;
  height: 24px;
  width: 24px;
  flex: none;
  place-items: center;
  border: 1px solid var(--color-line);
  border-radius: 7px;
  background: color-mix(in srgb, var(--color-canvas) 55%, var(--color-raised));
  font-family: var(--font-term);
  font-size: 10.5px;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}

.window-times {
  display: flex;
  align-items: center;
  gap: 7px;
}

.time-input {
  width: 84px;
}

.time-input :deep(.n-input__input-el) {
  text-align: center;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
}

.window-dash {
  font-size: 12px;
  color: var(--color-muted);
}

.window-duration {
  margin-left: auto;
  font-size: 10.5px;
  color: var(--color-muted);
  white-space: nowrap;
}

.window-del {
  flex: none;
  --n-text-color: var(--color-muted);
}

.window-del:hover {
  --n-text-color: var(--color-danger);
}

.add-window {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 10px;
  border: 1px dashed color-mix(in srgb, var(--color-brand) 26%, var(--color-line));
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-brand) 3%, transparent);
  padding: 8px;
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--color-brand);
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
}

.add-window:hover {
  border-color: color-mix(in srgb, var(--color-brand) 45%, var(--color-line));
  background: color-mix(in srgb, var(--color-brand) 7%, transparent);
}

.window-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--color-danger);
}

.field-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--color-line);
}

.field-grid.two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin-top: 12px;
  padding-top: 0;
  border-top: 0;
}

.field {
  min-width: 0;
}

.field-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 6px;
  margin-bottom: 6px;
}

.field-label {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-ink);
}

.field-range {
  font-size: 10px;
  color: color-mix(in srgb, var(--color-muted) 80%, transparent);
  font-variant-numeric: tabular-nums;
}

.num-input {
  width: 100%;
}

.unit {
  padding-right: 4px;
  font-size: 11px;
  color: var(--color-muted);
}

/* 复习形态 */
.choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.choice-card {
  display: flex;
  flex-direction: column;
  gap: 7px;
  border: 1px solid var(--color-line);
  border-radius: 11px;
  background: color-mix(in srgb, var(--color-canvas) 30%, var(--color-raised));
  padding: 12px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease;
}

.choice-card:hover {
  border-color: color-mix(in srgb, var(--color-brand) 30%, var(--color-line));
}

.choice-card.is-active {
  border-color: color-mix(in srgb, var(--color-brand) 55%, var(--color-raised));
  background: color-mix(in srgb, var(--color-brand) 5%, var(--color-raised));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-brand) 7%, transparent);
}

.choice-top {
  display: flex;
  align-items: center;
  gap: 8px;
}

.choice-ico {
  display: grid;
  height: 26px;
  width: 26px;
  flex: none;
  place-items: center;
  border: 1px solid var(--color-line);
  border-radius: 8px;
  background: var(--color-surface);
  color: var(--color-ink);
}

.choice-card.is-active .choice-ico {
  border-color: color-mix(in srgb, var(--color-brand) 18%, var(--color-line));
  color: var(--color-brand);
}

.choice-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-ink);
}

.choice-mark {
  display: grid;
  height: 14px;
  width: 14px;
  margin-left: auto;
  place-items: center;
  border: 1.5px solid color-mix(in srgb, var(--color-muted) 45%, transparent);
  border-radius: 50%;
}

.choice-card.is-active .choice-mark {
  border-color: var(--color-brand);
}

.choice-card.is-active .choice-mark::after {
  content: '';
  height: 6px;
  width: 6px;
  border-radius: 50%;
  background: var(--color-brand);
}

.choice-desc {
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--color-muted);
}

.sub-block {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--color-line);
}

.sub-title {
  margin-bottom: 7px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-ink);
}

.practice-select {
  max-width: 340px;
}

.hint {
  display: flex;
  gap: 7px;
  margin-top: 9px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-canvas) 55%, var(--color-raised));
  padding: 8px 10px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--color-muted);
}

.hint-ico {
  flex: none;
  margin-top: 2px;
  color: color-mix(in srgb, var(--color-brand) 65%, var(--color-muted));
}

.lock-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.lock-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: transparent;
  padding: 10px 12px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, background-color 140ms ease;
}

.lock-row:hover {
  background: color-mix(in srgb, var(--color-canvas) 40%, var(--color-raised));
}

.lock-row.is-active {
  border-color: color-mix(in srgb, var(--color-brand) 45%, var(--color-raised));
  background: color-mix(in srgb, var(--color-brand) 4%, var(--color-raised));
}

.lock-dot {
  display: grid;
  height: 14px;
  width: 14px;
  flex: none;
  margin-top: 2px;
  place-items: center;
  border: 1.5px solid color-mix(in srgb, var(--color-muted) 45%, transparent);
  border-radius: 50%;
}

.lock-row.is-active .lock-dot {
  border-color: var(--color-brand);
}

.lock-row.is-active .lock-dot::after {
  content: '';
  height: 6px;
  width: 6px;
  border-radius: 50%;
  background: var(--color-brand);
}

.lock-body {
  min-width: 0;
}

.lock-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--color-ink);
}

.lock-tag {
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-accent) 12%, var(--color-raised));
  padding: 1px 5px;
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: #8a5a1c;
}

.lock-desc {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--color-muted);
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 10px 0;
  border-bottom: 1px dashed var(--color-line);
}

.switch-row:last-of-type {
  border-bottom: 0;
}

.switch-title {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--color-ink);
}

.switch-desc {
  margin-top: 2px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-muted);
}

.warn {
  display: flex;
  gap: 7px;
  margin-top: 12px;
  border: 1px solid color-mix(in srgb, var(--color-danger) 30%, var(--color-raised));
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-danger) 5%, var(--color-raised));
  padding: 9px 11px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-danger);
}

.warn-ico {
  flex: none;
  margin-top: 2px;
}

.reveal {
  animation: rise 180ms ease;
}

@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 延后策略 */
.delay-meter {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
}

.delay-num {
  font-family: var(--font-term);
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
}

.delay-num em {
  margin-left: 3px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-style: normal;
  font-weight: 400;
  color: var(--color-muted);
}

.delay-caption {
  margin-top: 5px;
  font-size: 10.5px;
  color: var(--color-muted);
}

.delay-pips {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  margin-top: 9px;
}

.delay-pips i {
  height: 4px;
  width: 11px;
  border-radius: 2px;
  background: var(--color-line);
}

.delay-pips i.on {
  background: var(--color-brand);
}

/* 快捷键 */
.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--color-line);
}

.shortcut-label {
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--color-muted);
}

.keys {
  display: flex;
  align-items: center;
  gap: 4px;
}

.kbd {
  display: inline-grid;
  min-width: 22px;
  height: 22px;
  place-items: center;
  border: 1px solid var(--color-line);
  border-bottom-width: 2px;
  border-radius: 5px;
  background: linear-gradient(180deg, var(--color-surface), var(--color-surface-2));
  padding: 0 6px;
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 600;
  color: var(--color-ink);
}

.kbd-sep {
  font-size: 10px;
  color: var(--color-muted);
}

.pill {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 5px;
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 10px;
  font-weight: 600;
  white-space: nowrap;
}

.pill.ok {
  background: color-mix(in srgb, var(--color-brand) 9%, var(--color-raised));
  color: var(--color-brand);
}

.pill.bad {
  background: color-mix(in srgb, var(--color-danger) 9%, var(--color-raised));
  color: var(--color-danger);
}

.pill .dot {
  height: 5px;
  width: 5px;
  border-radius: 50%;
  background: currentColor;
}

/* 数据与隐私 */
.privacy-note {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11px;
  color: var(--color-muted);
}

.path-box {
  margin-top: 10px;
  overflow: hidden;
  border: 1px solid var(--color-line);
  border-radius: 9px;
  background: color-mix(in srgb, var(--color-canvas) 55%, var(--color-raised));
  padding: 9px 11px;
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--color-ink) 80%, transparent);
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.data-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 11px;
}

/* 主题皮肤 */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.theme-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-canvas) 26%, var(--color-raised));
  padding: 7px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, box-shadow 140ms ease;
}

.theme-card:hover {
  border-color: color-mix(in srgb, var(--color-brand) 32%, var(--color-line));
}

.theme-card.is-active {
  border-color: color-mix(in srgb, var(--color-brand) 55%, var(--color-raised));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-brand) 8%, transparent);
}

.theme-preview {
  display: flex;
  height: 52px;
  overflow: hidden;
  border: 1px solid rgb(0 0 0 / 0.08);
  border-radius: 6px;
  background: #f4f1e9;
}

.tp-rail {
  width: 22%;
  background: #fffdf8;
  border-right: 1px solid #e4dfd3;
}

.tp-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
}

.tp-bar {
  height: 5px;
  width: 52%;
  border-radius: 3px;
  background: #d8d0c0;
}

.tp-card {
  flex: 1;
  border: 1px solid #e4dfd3;
  border-radius: 4px;
  background: #fffdf8;
}

.tp-card.short {
  flex: 0 0 9px;
  width: 64%;
}

.theme-preview.is-dark {
  border-color: color-mix(in srgb, var(--color-brand-fill) 22%, #262b28);
  background: color-mix(in srgb, var(--color-brand-fill) 6%, #0b0e0d);
}

.theme-preview.is-dark .tp-rail {
  border-color: color-mix(in srgb, var(--color-brand-fill) 22%, #262b28);
  background: color-mix(in srgb, var(--color-brand-fill) 13%, #121716);
}

.theme-preview.is-dark .tp-bar {
  background: color-mix(in srgb, var(--color-brand-fill) 16%, #3c4440);
}

.theme-preview.is-dark .tp-card {
  border-color: color-mix(in srgb, var(--color-brand-fill) 22%, #262b28);
  background: color-mix(in srgb, var(--color-brand-fill) 13%, #121716);
}

.theme-preview.is-system {
  background: linear-gradient(
    90deg,
    #f4f1e9 50%,
    color-mix(in srgb, var(--color-brand-fill) 6%, #0b0e0d) 50%
  );
}

.theme-preview.is-system .tp-rail {
  border-color: #e4dfd3;
  background: linear-gradient(
    90deg,
    #fffdf8 50%,
    color-mix(in srgb, var(--color-brand-fill) 13%, #121716) 50%
  );
}

.theme-preview.is-system .tp-bar {
  background: linear-gradient(
    90deg,
    #d8d0c0 50%,
    color-mix(in srgb, var(--color-brand-fill) 16%, #3c4440) 50%
  );
}

.theme-preview.is-system .tp-card {
  border-color: #e4dfd3;
  background: linear-gradient(
    90deg,
    #fffdf8 50%,
    color-mix(in srgb, var(--color-brand-fill) 13%, #121716) 50%
  );
}

.theme-name {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 2px 1px;
  font-size: 11px;
  font-weight: 500;
  color: var(--color-ink);
}

.theme-mark {
  display: grid;
  height: 12px;
  width: 12px;
  margin-left: auto;
  place-items: center;
  border: 1.5px solid color-mix(in srgb, var(--color-muted) 45%, transparent);
  border-radius: 50%;
}

.theme-card.is-active .theme-mark {
  border-color: var(--color-brand);
  background: var(--color-brand);
}

.theme-card.is-active .theme-mark::after {
  content: '';
  height: 4px;
  width: 4px;
  border-radius: 50%;
  background: var(--color-on-brand);
}

/* 主题色色板 */
.accent-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.accent-card {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-canvas) 26%, var(--color-raised));
  padding: 8px 10px;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 140ms ease, box-shadow 140ms ease, background-color 140ms ease;
}

.accent-card:hover {
  border-color: color-mix(in srgb, var(--color-brand) 32%, var(--color-line));
}

.accent-card.is-active {
  border-color: color-mix(in srgb, var(--color-brand) 55%, var(--color-raised));
  background: color-mix(in srgb, var(--color-brand) 5%, var(--color-raised));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-brand) 8%, transparent);
}

.accent-dot {
  height: 16px;
  width: 16px;
  flex: none;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.1);
}

.accent-name {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--color-ink);
}

.accent-card.is-active .theme-mark {
  border-color: var(--color-brand);
  background: var(--color-brand);
}

.accent-card.is-active .theme-mark::after {
  content: '';
  height: 4px;
  width: 4px;
  border-radius: 50%;
  background: var(--color-on-brand);
}

.skin-upload {
  display: flex;
  width: 100%;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  border: 1px dashed color-mix(in srgb, var(--color-brand) 30%, var(--color-line));
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-brand) 3%, transparent);
  padding: 14px 12px;
  font: inherit;
  color: var(--color-brand);
  cursor: pointer;
  transition: background-color 140ms ease, border-color 140ms ease;
}

.skin-upload:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-brand) 45%, var(--color-line));
  background: color-mix(in srgb, var(--color-brand) 7%, transparent);
}

.skin-upload:disabled {
  cursor: progress;
  opacity: 0.7;
}

.skin-upload-title {
  font-size: 12.5px;
  font-weight: 600;
}

.skin-upload-sub {
  font-size: 10.5px;
  color: var(--color-muted);
}

.skin-current {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-canvas) 30%, var(--color-raised));
  padding: 8px 10px;
}

.skin-thumb {
  height: 42px;
  width: 58px;
  flex: none;
  border: 1px solid var(--color-line);
  border-radius: 7px;
  background-position: center;
  background-size: cover;
}

.skin-meta {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
  gap: 1px;
}

.skin-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--color-ink);
}

.skin-sub {
  font-size: 10.5px;
  color: var(--color-muted);
}

.scrim-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.scrim-label {
  flex: none;
  font-size: 11px;
  color: var(--color-ink);
}

.scrim-slider {
  flex: 1;
  min-width: 0;
}

.scrim-value {
  width: 36px;
  flex: none;
  text-align: right;
  font-size: 11px;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}

/* 离线词典弹窗 */
.dict-body {
  font-size: 13px;
  line-height: 1.7;
}

.dict-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.dict-stat {
  border: 1px solid var(--color-line);
  border-radius: 10px;
  background: color-mix(in srgb, var(--color-canvas) 45%, var(--color-raised));
  padding: 9px 12px;
}

.dict-stat span {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--color-muted);
}

.dict-stat b {
  display: block;
  margin-top: 2px;
  font-family: var(--font-term);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-ink);
  font-variant-numeric: tabular-nums;
}

.dict-meta {
  margin-top: 8px;
  font-size: 11px;
  color: var(--color-muted);
}

.dict-search {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.dict-search :deep(.n-input) {
  flex: 1;
}

.dict-result {
  margin-top: 10px;
  border-top: 1px dashed var(--color-line);
  padding-top: 9px;
  font-size: 12px;
}

.dict-word {
  font-family: var(--font-term);
  font-size: 15px;
  font-weight: 600;
  color: var(--color-ink);
}

.dict-phonetic {
  font-size: 11.5px;
  color: var(--color-muted);
  font-variant-numeric: tabular-nums;
}

.dict-meaning {
  color: color-mix(in srgb, var(--color-ink) 85%, transparent);
}

.dict-via {
  font-size: 11px;
  color: var(--color-muted);
}

.dict-miss {
  color: var(--color-accent);
}

@media (max-width: 1080px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .settings {
    padding: 22px 18px 28px;
  }

  .page-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .summary {
    flex-wrap: wrap;
  }

  .summary-item {
    flex: 1 1 45%;
  }

  .panel-wide {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      'head'
      'note'
      'path'
      'actions';
    row-gap: 10px;
  }

  .panel-wide .privacy-note {
    align-self: start;
    padding-bottom: 0;
  }

  .panel-wide .path-box {
    margin-top: 0;
  }

  .panel-wide .data-actions {
    flex-wrap: wrap;
  }

  .summary-item + .summary-item {
    border-left: 0;
  }

  .field-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 520px) {
  .choice-grid,
  .field-grid,
  .field-grid.two {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
