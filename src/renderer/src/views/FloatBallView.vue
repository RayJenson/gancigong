<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { useNextRound } from '@renderer/lib/next-round'

const isTauri = '__TAURI_INTERNALS__' in window
const due = ref(0)
const { hasSchedule, fraction, title } = useNextRound()

let timer: number | undefined
let offData: (() => void) | null = null
let start: { x: number; y: number } | null = null
let dragged = false

async function refreshDue(): Promise<void> {
  try {
    const d = await window.ganci.dashboardState()
    due.value = Math.max(0, d.reviewDue)
  } catch {
    /* 角标只是提示，读不到不影响点按 */
  }
}

function stopDragListeners(): void {
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
}

function onDown(e: PointerEvent): void {
  if (e.button !== 0) return
  start = { x: e.screenX, y: e.screenY }
  dragged = false
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}

function onMove(e: PointerEvent): void {
  if (!start || dragged) return
  if (Math.hypot(e.screenX - start.x, e.screenY - start.y) < 5) return
  dragged = true
  stopDragListeners()
  if (isTauri) void getCurrentWindow().startDragging()
}

function onUp(): void {
  stopDragListeners()
  if (!dragged) void window.ganci.floatMenuToggle()
  start = null
}

function onContext(e: MouseEvent): void {
  e.preventDefault()
  void window.ganci.floatMenuToggle()
}

onMounted(() => {
  document.documentElement.dataset.window = 'float'
  void refreshDue()
  timer = window.setInterval(() => void refreshDue(), 60_000)
  offData = window.ganci.onDataChanged(() => void refreshDue())
  window.addEventListener('contextmenu', onContext)
})

onBeforeUnmount(() => {
  delete document.documentElement.dataset.window
  if (timer) clearInterval(timer)
  offData?.()
  window.removeEventListener('contextmenu', onContext)
  stopDragListeners()
})
</script>

<template>
  <div class="float-root">
    <svg class="ring" :class="{ 'is-idle': !hasSchedule }" viewBox="0 0 72 72" aria-hidden="true">
      <circle class="ring-track" cx="36" cy="36" r="31" pathLength="100" />
      <circle
        class="ring-arc"
        cx="36"
        cy="36"
        r="31"
        pathLength="100"
        stroke-dasharray="100"
        :stroke-dashoffset="100 - fraction * 100"
      />
    </svg>
    <button
      class="ball"
      type="button"
      :title="title"
      aria-label="赶词工快捷菜单"
      @pointerdown="onDown"
    >
      <span class="ball-mark">赶</span>
      <span v-if="due > 0" class="ball-badge">{{ due > 99 ? '99+' : due }}</span>
    </button>
  </div>
</template>

<style scoped>
.float-root {
  position: relative;
  display: grid;
  height: 100%;
  width: 100%;
  place-items: center;
  background: transparent;
}

.ring {
  position: absolute;
  inset: 0;
  height: 100%;
  width: 100%;
  transform: rotate(-90deg);
  pointer-events: none;
}

.ring-track,
.ring-arc {
  fill: none;
  stroke-width: 3;
}

.ring-track {
  stroke: rgb(243 233 210 / 0.16);
}

.ring-arc {
  stroke: var(--accent);
  stroke-linecap: round;
  /* 每秒走一小格，和倒计时同步 */
  transition: stroke-dashoffset 1s linear, opacity 240ms ease;
}

.ring.is-idle .ring-arc {
  opacity: 0;
}

.ring.is-idle .ring-track {
  stroke: rgb(243 233 210 / 0.1);
}

.ball {
  position: relative;
  display: grid;
  height: 56px;
  width: 56px;
  place-items: center;
  border: 1px solid rgb(255 255 255 / 0.2);
  border-radius: 50%;
  background: radial-gradient(
    circle at 32% 26%,
    color-mix(in srgb, var(--brand-fill) 68%, #ffffff 32%),
    var(--brand-press) 78%
  );
  color: #f3e9d2;
  cursor: grab;
  /* 窗口只有 72px，外阴影会被矩形边界裁成方块，这里只用内阴影做体积感 */
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.28), inset 0 -2px 4px rgb(0 0 0 / 0.22);
  transition: transform 140ms ease, filter 140ms ease;
}

.ball:hover {
  transform: scale(1.06);
  filter: brightness(1.06);
}

.ball:active {
  cursor: grabbing;
  transform: scale(0.98);
}

.ball-mark {
  font-family: var(--font-term);
  font-size: 20px;
  font-weight: 700;
  line-height: 1;
  transform: translateY(-1px);
}

.ball-badge {
  position: absolute;
  top: -4px;
  right: -6px;
  display: grid;
  min-width: 18px;
  height: 18px;
  place-items: center;
  padding: 0 4px;
  border: 2px solid var(--surface);
  border-radius: 999px;
  background: var(--danger);
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}
</style>