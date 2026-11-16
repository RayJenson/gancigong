/**
 * 探针三：在复习窗口里派发真实按键（Space / 1 / 2），验证键盘优先与逐词翻面。
 * 每一步都读一次窗口内的可见文案，便于定位「结算页提前出现」这类问题。
 */
const BASE = 'http://127.0.0.1:9222'
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

async function targets() {
  return (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page')
}

async function find(regex, tries = 30) {
  for (let i = 0; i < tries; i++) {
    const hit = (await targets()).find((t) => regex.test(t.url))
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

async function text(ws) {
  const r = await send(ws, 'Runtime.evaluate', {
    expression: 'document.body.innerText.replace(/\\s+/g," ").slice(0, 220)',
    returnByValue: true,
  })
  return r.result.value
}

async function key(ws, code, keyName) {
  for (const type of ['keyDown', 'keyUp']) {
    await send(ws, 'Input.dispatchKeyEvent', {
      type,
      code,
      key: keyName,
      windowsVirtualKeyCode: code === 'Space' ? 32 : Number(keyName),
      nativeVirtualKeyCode: code === 'Space' ? 32 : Number(keyName),
    })
  }
  await new Promise((r) => setTimeout(r, 220))
}

const log = (label, v) => console.log(`\n### ${label}\n${v}`)

const mainTarget = (await targets()).find((t) => !/#\/(review|cover)/.test(t.url))
const main = await connect(mainTarget.webSocketDebuggerUrl)
const api = async (expr) => {
  const r = await send(main, 'Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}

const stale = await api('return (await window.ganci.flowStatus()).sessionRoundId')
if (stale) {
  await api(`return await window.ganci.reviewFinish(${stale})`)
  await new Promise((r) => setTimeout(r, 500))
}
log('清理残留轮次', String(stale ?? '无'))

const started = await api('return await window.ganci.reviewStartNow()')
log('开轮', JSON.stringify(started))
if (!started.ok) process.exit(1)

const plan = await api(`return await window.ganci.reviewPlan(${started.roundId})`)
const cardCount = plan.cards.length
log('本轮词数', `${cardCount}：${plan.cards.map((c) => c.term).join(' ')}`)

const hit = await find(new RegExp(`round=${started.roundId}`))
if (!hit) {
  log('结果', '没找到复习窗口 target —— 窗口可能没开起来')
  process.exit(1)
}
const win = await connect(hit.webSocketDebuggerUrl)
await new Promise((r) => setTimeout(r, 800))
log('窗口初始文案', await text(win))

await key(win, 'Space', ' ')
log('按 Space 翻面后', await text(win))

const fit = await send(win, 'Runtime.evaluate', {
  expression: `(() => {
    const btns = [...document.querySelectorAll('button')].map((b) => ({ t: b.innerText.trim().slice(0, 6), r: b.getBoundingClientRect() }))
    const rate = btns.filter((b) => /认识/.test(b.t))
    const clipped = rate.filter((b) => b.r.bottom > innerHeight + 0.5 || b.r.top < -0.5).map((b) => b.t)
    return JSON.stringify({ viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, buttons: rate.map((b) => [b.t, Math.round(b.r.top), Math.round(b.r.bottom)]), clipped })
  })()`,
  returnByValue: true,
})
log('按钮是否被裁切', fit.result.value)

const { writeFileSync } = await import('node:fs')
const shot1 = await send(win, 'Page.captureScreenshot', { format: 'png' })
writeFileSync(`${process.env.TEMP}\\ganci-card.png`, Buffer.from(shot1.data, 'base64'))
log('翻面后截图', `${process.env.TEMP}\\ganci-card.png`)

for (let i = 0; i < cardCount; i++) {
  await key(win, 'Digit2', '2')
  const t = await text(win)
  console.log(`  第 ${i + 1} 次「认识」后：${t.slice(0, 120)}`)
  if (/本轮结束/.test(t)) {
    log(`!! 结算页在第 ${i + 1} 次按键出现（应共 ${cardCount} 次）`, t)
    break
  }
  await key(win, 'Space', ' ')
}

const after = await api(`
  const p = (await window.ganci.wordsList({ limit: 60 })).rows;
  return p.filter(w => w.reps).map(w => w.term + ':' + w.reps + '/' + w.intervalDays).join(' ');
`)
log('已标记的词（term:reps/interval）', after)

const shot = await send(win, 'Page.captureScreenshot', { format: 'png' })
writeFileSync(`${process.env.TEMP}\\ganci-summary.png`, Buffer.from(shot.data, 'base64'))
log('结算页截图', `${process.env.TEMP}\\ganci-summary.png`)

process.exit(0)
