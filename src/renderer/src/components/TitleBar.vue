<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { NIcon } from 'naive-ui'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { CloseOutline, CopyOutline, RemoveOutline, SquareOutline } from '@vicons/ionicons5'

const isTauri = '__TAURI_INTERNALS__' in window
const maximized = ref(false)
let unlisten: UnlistenFn | null = null

async function syncMaximized(): Promise<void> {
  if (!isTauri) return
  try {
    maximized.value = await getCurrentWindow().isMaximized()
  } catch {
    /* 读取失败保持原状 */
  }
}

function minimize(): void {
  if (isTauri) void getCurrentWindow().minimize()
}

async function toggleMaximize(): Promise<void> {
  if (!isTauri) return
  await getCurrentWindow().toggleMaximize()
  void syncMaximized()
}

function close(): void {
  if (isTauri) void getCurrentWindow().close()
}

onMounted(async () => {
  if (!isTauri) return
  await syncMaximized()
  unlisten = await getCurrentWindow().onResized(() => void syncMaximized())
})

onBeforeUnmount(() => {
  unlisten?.()
})
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <div class="tb-brand">
      <span class="tb-logo">赶</span>
      <span class="tb-name">赶词工</span>
      <span class="tb-tag">别让单词等你</span>
    </div>
    <div class="tb-controls">
      <button class="tb-btn" type="button" title="最小化" @click="minimize">
        <n-icon :component="RemoveOutline" :size="16" />
      </button>
      <button
        class="tb-btn"
        type="button"
        :title="maximized ? '还原' : '最大化'"
        @click="toggleMaximize"
      >
        <n-icon :component="maximized ? CopyOutline : SquareOutline" :size="14" />
      </button>
      <button class="tb-btn tb-close" type="button" title="关闭" @click="close">
        <n-icon :component="CloseOutline" :size="17" />
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  display: flex;
  height: 38px;
  flex: none;
  align-items: center;
  justify-content: space-between;
  padding-left: 14px;
  border-bottom: 1px solid var(--color-line);
  background: color-mix(in srgb, var(--color-surface) 88%, transparent);
  user-select: none;
}
.tb-brand {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  pointer-events: none;
}
.tb-logo {
  display: grid;
  height: 20px;
  width: 20px;
  flex: none;
  place-items: center;
  border-radius: 6px;
  background: var(--color-brand-fill);
  color: var(--color-on-brand);
  font-size: 11px;
  font-weight: 700;
  line-height: 1;
}
.tb-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-ink);
}
.tb-tag {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--color-muted);
}
.tb-controls {
  display: flex;
  height: 100%;
  flex: none;
}
.tb-btn {
  display: grid;
  height: 100%;
  width: 46px;
  place-items: center;
  border: 0;
  background: transparent;
  color: var(--color-muted);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.tb-btn:hover {
  background: var(--color-surface-2);
  color: var(--color-ink);
}
.tb-btn:focus-visible {
  outline: 2px solid var(--color-brand);
  outline-offset: -2px;
}
.tb-close:hover {
  background: #c42b1c;
  color: #fff;
}
</style>