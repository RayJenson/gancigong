import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { logEvent } from './db'
import { resourcePath } from './dictionary'

export type KioskReason = 'escape' | 'heartbeat' | 'cap' | 'error' | 'released'
export interface KioskExit {
  code: number | null
  reason: KioskReason
}

let child: ChildProcess | null = null
let heartbeatTimer: NodeJS.Timeout | null = null
let releasedByUs = false

function heartbeatFile(): string {
  return join(app.getPath('temp'), 'gancigong-kiosk-heartbeat.txt')
}

function beat(): void {
  try {
    writeFileSync(heartbeatFile(), new Date().toISOString())
  } catch {
    /* 心跳写不进去时由子进程的超时兜底解锁 */
  }
}

function powershellExe(): string {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  const candidate = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return existsSync(candidate) ? candidate : 'powershell.exe'
}

export function isKioskEngaged(): boolean {
  return child !== null
}

export function kioskPid(): number | null {
  return child?.pid ?? null
}

/**
 * 装钩子。resolve 只代表「钩子是否真的装上」，失败时调用方应退回应用级锁定，
 * 绝不能让界面停在「已锁定」的假象上。
 */
export function engageKiosk(onExit: (exit: KioskExit) => void): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (child) {
      resolve({ ok: true })
      return
    }
    const script = resourcePath(join('resources', 'kiosk-lock.ps1'))
    if (!existsSync(script)) {
      resolve({ ok: false, error: 'Kiosk 锁定脚本缺失' })
      return
    }
    releasedByUs = false
    beat()
    heartbeatTimer = setInterval(beat, 1000)

    let settled = false
    let stderr = ''
    let blocked = 0
    const failTimer = setTimeout(() => {
      if (settled) return
      settled = true
      releaseKiosk()
      resolve({ ok: false, error: '键盘钩子 10 秒内没有就绪' })
    }, 10_000)

    const proc = spawn(
      powershellExe(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-HeartbeatFile', heartbeatFile()],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    child = proc

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = String(chunk)
      if (!settled && text.includes('READY')) {
        settled = true
        clearTimeout(failTimer)
        logEvent('kiosk_locked', { pid: proc.pid })
        resolve({ ok: true })
      }
      const m = /BLOCKED=(\d+)/.exec(text)
      if (m) blocked = Number(m[1])
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += String(chunk)
    })
    proc.on('error', (err) => {
      if (!settled) {
        settled = true
        clearTimeout(failTimer)
        stopHeartbeat()
        child = null
        resolve({ ok: false, error: err.message })
      }
    })
    proc.on('exit', (code) => {
      const wasOurs = releasedByUs
      stopHeartbeat()
      if (child === proc) child = null
      if (wasOurs) {
        onExit({ code, reason: 'released' })
      } else {
        const reason: KioskReason = code === 7 ? 'escape' : code === 8 ? 'heartbeat' : code === 9 ? 'cap' : 'error'
        logEvent('kiosk_released', { code, reason, pid: proc.pid, blocked })
        onExit({ code, reason })
      }
      if (!settled) {
        settled = true
        clearTimeout(failTimer)
        resolve({ ok: false, error: stderr.trim().slice(0, 300) || `钩子进程提前退出（code ${code}）` })
      }
    })
  })
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

export function releaseKiosk(): void {
  releasedByUs = true
  stopHeartbeat()
  if (child) {
    const proc = child
    child = null
    try {
      proc.kill('SIGKILL')
    } catch {
      /* 进程已经没了 */
    }
    logEvent('kiosk_unlocked', {})
  }
}
