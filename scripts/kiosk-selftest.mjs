/**
 * 探针十：脱离 Electron 单测 Kiosk 钩子自身的两条保命路径。
 * A) Ctrl+Alt+Esc → 钩子内部判定逃生，退出码 7（证明逃生不依赖主进程还活着）
 * B) 心跳断供 → 超时自动卸载钩子，退出码 8（证明主进程崩了也不会锁死桌面）
 * 每次都带 20 秒看门狗，无论如何都会把钩子进程杀掉。
 * 用法：node scripts/kiosk-selftest.mjs
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SCRIPT = join(process.cwd(), 'resources', 'kiosk-lock.ps1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function sendKeys(s) {
  execFileSync('powershell', ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(s)})`], { stdio: 'ignore' })
}

function runHook(heartbeatFile, timeoutSec) {
  const proc = spawn(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', SCRIPT, '-HeartbeatFile', heartbeatFile, '-HeartbeatTimeoutSec', String(timeoutSec)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let out = ''
  proc.stdout?.on('data', (c) => (out += String(c)))
  proc.stderr?.on('data', (c) => (out += String(c)))
  const ready = new Promise((resolve) => {
    const t = setInterval(() => {
      if (out.includes('READY')) {
        clearInterval(t)
        resolve(true)
      }
    }, 200)
    setTimeout(() => clearInterval(t), 12_000)
  })
  const done = new Promise((resolve) => proc.on('exit', (code) => resolve({ code, out })))
  const watchdog = setTimeout(() => {
    try {
      proc.kill('SIGKILL')
    } catch {
      /* 已退出 */
    }
  }, 20_000)
  done.then(() => clearTimeout(watchdog))
  return { proc, ready, done, heartbeatFile }
}

function beat(file) {
  try {
    writeFileSync(file, new Date().toISOString())
  } catch {
    /* 忽略 */
  }
}

// A：逃生键（钩子自己判定，Electron 完全没参与）
{
  const file = join(tmpdir(), 'ganci-kiosk-selftest-A.txt')
  rmSync(file, { force: true })
  beat(file)
  const h = runHook(file, 60)
  const ok = await h.ready
  if (!ok) {
    console.log('A) 钩子没就绪：', h.out.slice(0, 200))
  } else {
    sendKeys('%^{ESC}')
    const r = await h.done
    console.log(`A) Ctrl+Alt+Esc 逃生 → 退出码 ${r.code}（期望 7）${r.code === 7 ? ' 通过' : ' 不通过'}  ${/BLOCKED=(\d+)/.exec(r.out)?.[0] ?? ''}`)
  }
  rmSync(file, { force: true })
}

await sleep(1500)

// B：心跳断供（模拟主进程被强杀，再没人写心跳）
{
  const file = join(tmpdir(), 'ganci-kiosk-selftest-B.txt')
  rmSync(file, { force: true })
  beat(file)
  const h = runHook(file, 2)
  const ok = await h.ready
  if (!ok) {
    console.log('B) 钩子没就绪：', h.out.slice(0, 200))
  } else {
    const t0 = Date.now()
    const r = await h.done
    console.log(`B) 停止心跳 → ${((Date.now() - t0) / 1000).toFixed(1)} 秒后自动解锁，退出码 ${r.code}（期望 8）${r.code === 8 ? ' 通过' : ' 不通过'}`)
  }
  rmSync(file, { force: true })
}

console.log('\n钩子进程残留：', existsSync(SCRIPT) ? '脚本在位' : '脚本丢失')
process.exit(0)
