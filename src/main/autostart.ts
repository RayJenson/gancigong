import { app } from 'electron'
import { logEvent } from './db'

/** 开机自启只对打包后的应用有意义；开发模式下静默跳过，避免把 electron.exe 注册进启动项 */
export function applyAutostart(enabled: boolean): void {
  if (!app.isPackaged) {
    logEvent('autostart_skipped_dev', { enabled })
    return
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [] })
  } catch (err) {
    logEvent('autostart_failed', { message: err instanceof Error ? err.message : String(err) })
  }
}

export function readAutostart(): boolean {
  if (!app.isPackaged) return false
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    return false
  }
}
