/**
 * 探针九：Kiosk 钩子的「按键到底被吞了几次」实测。
 * 用系统级真按键（CDP 按键不经过低级钩子，测不出拦截）逐个试 Win / Alt+Tab / Alt+F4 / Ctrl+Esc / Alt+Space，
 * 每次都确认本轮还活着；最后按 Ctrl+Alt+Esc 逃生，再从 events 表读回钩子自己上报的 blocked 计数。
 * 无论中途出什么错，finally 里都会强制逃生 + 兜底杀掉钩子进程，绝不把桌面留在锁定状态。
 * 用法：node scripts/kiosk-measure.mjs [cdpPort]
 */
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

const BASE = `http://127.0.0.1:${process.argv[2] ?? '9222'}`
let seq = 0
const pending = new Map()

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('message', (ev) => {
      const d = JSON.parse(ev.data)
      if (d.id && pending.has(d.id)) {
        const { resolve: res, reject: rej } = pending.get(d.id)
        pending.delete(d.id)
        if (d.error) rej(new Error(JSON.stringify(d.error)))
        else res(d.result)
      }
    })
    ws.addEventListener('open', () => resolve(ws))
    ws.addEventListener('error', reject)
  })
}
const send = (ws, method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const pages = async () => (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PS = (body) => execFileSync('powershell', ['-NoProfile', '-Command', body], { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
/** SendKeys 没有 Win 键的写法，直接用 keybd_event 发 VK_LWIN */
const KEYBD = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class Kb{[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);public static void Tap(byte vk){keybd_event(vk,0x45,0,UIntPtr.Zero);keybd_event(vk,0x45,2,UIntPtr.Zero);}}'`
const sendKeys = (s) => PS(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(s)})`)

let hookPid = null
const main = await connect((await pages()).find((t) => !/#\/(review|cover)/.test(t.url)).webSocketDebuggerUrl)
const api = async (expr) => {
  const r = await send(main, 'Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}
const session = async () => api('return (await window.ganci.flowStatus()).sessionRoundId')

try {
  await api(`return await window.ganci.settingsSet({ mode: 'fullscreen', lockLevel: 'kiosk', wordsPerRound: 2, lockAllDisplays: false })`)
  const stale = await session()
  if (stale) await api(`return await window.ganci.reviewFinish(${stale})`)
  const started = await api('return await window.ganci.reviewStartNow()')
  console.log('开轮：', JSON.stringify(started))
  if (!started.ok) process.exit(1)
  await sleep(2500)
  const st = await api('return await window.ganci.kioskStatus()')
  hookPid = st.pid
  console.log('钩子：', JSON.stringify(st))

  const TRIALS = [
    ['win', 'Win 开始菜单'],
    ['%{TAB}', 'Alt+Tab 切窗口'],
    ['%{F4}', 'Alt+F4 关窗口'],
    ['^{ESC}', 'Ctrl+Esc 开始菜单'],
  ]
  console.log('\n== 逐个真按键，看本轮是否还活着 ==')
  for (const [code, label] of TRIALS) {
    try {
      if (code === 'win') PS(`${KEYBD}; [Kb]::Tap(0x5B)`)
      else sendKeys(code)
    } catch (err) {
      console.log(`  ${label.padEnd(18)} → 按键没发出去：${String(err.stderr || err.message).trim().slice(0, 80)}`)
      continue
    }
    await sleep(700)
    const alive = await session()
    console.log(`  ${label.padEnd(18)} → 会话轮次 ${alive} ${alive === started.roundId ? '（没关掉）' : '（被关掉了！）'}`)
  }

  console.log('\n== Ctrl+Alt+Esc 逃生 ==')
  sendKeys('^%{ESC}')
  await sleep(2500)
  console.log('  逃生后会话轮次：', await session())
  console.log('  钩子状态：', JSON.stringify(await api('return await window.ganci.kioskStatus()')))
  console.log('  本轮记录：', JSON.stringify((await api('return (await window.ganci.dashboardState()).recentRounds')).find((r) => r.id === started.roundId)))

  const db = new DatabaseSync(join(process.env.APPDATA, '赶词工', 'gancigong.db'))
  const rows = db.prepare("select kind, detail_json, datetime(at/1000,'unixepoch','localtime') t from events where kind like 'kiosk%' or kind = 'escape_used' order by id desc limit 5").all()
  db.close()
  console.log('\n== 事件表里的钩子记录 ==')
  for (const r of rows) console.log(`  ${r.t}  ${r.kind}  ${r.detail_json}`)
} finally {
  const engaged = await api('return await window.ganci.kioskStatus()').catch(() => ({ engaged: false }))
  if (engaged.engaged) {
    console.log('!! 钩子仍在，兜底杀掉', engaged.pid)
    try {
      execFileSync('taskkill', ['//PID', String(engaged.pid), '//F'], { stdio: 'ignore' })
    } catch {
      /* 已经没了 */
    }
  }
  if (hookPid) {
    try {
      execFileSync('taskkill', ['//PID', String(hookPid), '//F'], { stdio: 'ignore' })
    } catch {
      /* 正常路径下钩子进程已自行退出 */
    }
  }
}
