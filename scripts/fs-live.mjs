/**
 * 探针八：强制全屏实测（应用级 / Kiosk 级）。
 * 会真的盖住桌面，跑完自动收尾；Alt+F4 用系统级按键发送，验证关不掉。
 * 用法：node scripts/fs-live.mjs [cdpPort] [app|kiosk]
 */
import { execFileSync } from 'node:child_process'

const BASE = `http://127.0.0.1:${process.argv[2] ?? '9333'}`
const level = process.argv[3] === 'kiosk' ? 'kiosk' : 'app'
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

const main = await connect((await pages()).find((t) => !/#\/(review|cover)/.test(t.url)).webSocketDebuggerUrl)
const api = async (expr) => {
  const r = await send(main, 'Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}
const ev = async (ws, expr) => {
  const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result.value
}

/** 系统级按键（CDP 的按键进不了 shell 热键，也不经过低级钩子，必须走真按键） */
function systemKeys(seqStr) {
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(seqStr)})`],
    { stdio: 'ignore' }
  )
}

async function findReview(seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    const hit = (await pages()).find((t) => /#\/review/.test(t.url))
    if (hit) return hit
    await sleep(250)
  }
  return null
}

console.log(`\n== 准备：mode=fullscreen lock=${level} 每轮 2 词 ==`)
await api(`return await window.ganci.settingsSet({ mode: 'fullscreen', lockLevel: '${level}', wordsPerRound: 2, lockAllDisplays: false })`)
await api(`return await window.ganci.reviewFinish(${await api('return (await window.ganci.flowStatus()).sessionRoundId ?? 0')})`)
const started = await api('return await window.ganci.reviewStartNow()')
console.log('开轮：', JSON.stringify(started))
if (!started.ok) process.exit(1)

const hit = await findReview(10)
if (!hit) {
  console.log('!! 全屏窗口没出现 —— 这是缺陷，立刻中止本轮')
  await api(`return await window.ganci.reviewAbort(${started.roundId})`)
  process.exit(1)
}
const win = await connect(hit.webSocketDebuggerUrl)
console.log('窗口：', await ev(win, 'JSON.stringify({ inner: [innerWidth, innerHeight], screen: [screen.width, screen.height], fullscreenEl: !!document.fullscreenElement })'))
console.log('文案：', await ev(win, 'document.body.innerText.replace(/\\s+/g," ").slice(0,140)'))
console.log('页面上的按钮：', await ev(win, '[...document.querySelectorAll("button")].map(b=>b.title||b.innerText.trim()).filter(Boolean).join(" | ") || "（无）"'))
console.log('kiosk 状态：', JSON.stringify(await api('return await window.ganci.kioskStatus()')))

console.log('\n== 尝试关闭窗口（Alt+F4 / Alt+Space 再 C）==')
systemKeys('%{F4}')
await sleep(1200)
console.log('Alt+F4 后会话轮次：', await api('return (await window.ganci.flowStatus()).sessionRoundId'))
if (level === 'kiosk') {
  systemKeys('%^{ESC}')
  await sleep(1200)
  console.log('Ctrl+Esc 后会话轮次：', await api('return (await window.ganci.flowStatus()).sessionRoundId'))
}

console.log('\n== 键盘走完本轮（空格翻面 + 2 认识）==')
const plan = await api(`return await window.ganci.reviewPlan(${started.roundId})`)
for (let i = 0; i < plan.cards.length; i++) {
  for (const [code, key] of [['Space', ' '], ['Digit2', '2']]) {
    for (const type of ['keyDown', 'keyUp']) {
      await send(win, 'Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: code === 'Space' ? 32 : 50, nativeVirtualKeyCode: code === 'Space' ? 32 : 50 })
    }
    await sleep(200)
  }
  console.log(`  第 ${i + 1} 词后：`, await ev(win, 'document.body.innerText.replace(/\\s+/g," ").slice(0,60)').catch(() => '窗口已关'))
}

await sleep(7000)
console.log('\n== 收尾检查 ==')
console.log('剩余页面：', (await pages()).map((p) => p.url.slice(0, 55)).join(' | '))
console.log('会话轮次：', await api('return (await window.ganci.flowStatus()).sessionRoundId'))
console.log('kiosk 状态：', JSON.stringify(await api('return await window.ganci.kioskStatus()')))
console.log('本轮记录：', JSON.stringify((await api('return (await window.ganci.dashboardState()).recentRounds')).find((r) => r.id === started.roundId)))
process.exit(0)
