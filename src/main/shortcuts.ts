import { globalShortcut } from 'electron'
import { ESCAPE_SHORTCUT } from '@shared/ipc'

let available = false

/**
 * 逃生快捷键是强制模式的前置条件：注册不成功就不允许锁桌面，
 * 否则用户可能被困在没有出口的界面里。
 */
export function registerEscapeShortcut(onEscape: () => void): boolean {
  try {
    globalShortcut.unregister(ESCAPE_SHORTCUT)
    available = globalShortcut.register(ESCAPE_SHORTCUT, onEscape)
  } catch {
    available = false
  }
  return available
}

export function escapeShortcutAvailable(): boolean {
  return available
}

export function escapeShortcutCombo(): string {
  return ESCAPE_SHORTCUT
}
