import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import type { FlowStatus } from '@shared/types'
import { formatCountdown, toHHMM } from '@shared/time'

export const REASON_LABEL: Record<string, string> = {
  scheduled: '按计划',
  delayed: '延后中',
  out_of_words: '暂无到期词',
  no_due: '暂无待复习',
  paused: '不在复习时段',
  learning: '学习中 · 提醒暂停',
  idle: '调度未启动',
}

/**
 * 悬浮球与快捷菜单共用的「下一轮复习」倒计时。
 * fraction 是剩余比例：1 = 刚落定下一轮，0 = 已到点。
 */
export function useNextRound() {
  const now = ref(Date.now())
  const nextAt = ref<number | null>(null)
  const setAt = ref<number | null>(null)
  const reason = ref<FlowStatus['reason']>('idle')

  let timer: number | undefined
  let offStatus: (() => void) | null = null
  let offData: (() => void) | null = null

  function apply(status: FlowStatus): void {
    nextAt.value = status.nextFireAt
    setAt.value = status.scheduleSetAt
    reason.value = status.reason
  }

  async function refresh(): Promise<void> {
    try {
      apply(await window.ganci.flowStatus())
    } catch {
      /* 倒计时只是提示，读不到不影响球和菜单的操作 */
    }
  }

  onMounted(() => {
    timer = window.setInterval(() => {
      now.value = Date.now()
    }, 1000)
    offStatus = window.ganci.onScheduleChanged((status) => apply(status))
    offData = window.ganci.onDataChanged(() => void refresh())
    void refresh()
  })

  onBeforeUnmount(() => {
    if (timer) clearInterval(timer)
    offStatus?.()
    offData?.()
  })

  const hasSchedule = computed(() => nextAt.value !== null)

  const fraction = computed(() => {
    const next = nextAt.value
    const from = setAt.value
    if (next === null || from === null) return 0
    const total = next - from
    if (total <= 0) return 0
    return Math.min(1, Math.max(0, (next - now.value) / total))
  })

  const timeLabel = computed(() => {
    const next = nextAt.value
    if (next === null) return '暂无排程'
    return `${toHHMM(next)} · ${formatCountdown(next, now.value)}`
  })

  const reasonLabel = computed(() => REASON_LABEL[reason.value] ?? '')

  const title = computed(() =>
    nextAt.value === null ? '赶词工 · 点一下打开快捷菜单' : `赶词工 · 下一轮 ${timeLabel.value}`
  )

  return { nextAt, hasSchedule, fraction, timeLabel, reasonLabel, title }
}
