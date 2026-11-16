const port = process.argv[2] ?? '9222'
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && /index\.html|localhost/.test(t.url))
if (!page) {
  console.log(JSON.stringify({ error: 'no page target', urls: targets.map((t) => t.url) }))
  process.exit(1)
}
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
function call(method, params = {}) {
  return new Promise((resolve) => {
    const mid = ++id
    const onMsg = (ev) => {
      const m = JSON.parse(String(ev.data))
      if (m.id === mid) {
        ws.removeEventListener('message', onMsg)
        resolve(m.result)
      }
    }
    ws.addEventListener('message', onMsg)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
}
async function evalJs(expression) {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  return r?.result?.value
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
await wait(1500)

const dash = await evalJs(`(async () => {
  const d = await window.ganci.dashboardState();
  return { due: d.dueToday, total: d.totalWords, reason: d.nextFireReason, next: d.nextFireAt, rounds: d.recentRounds.length, roundsField: d.recentRounds };
})()`)
console.log('空库面板:', JSON.stringify(dash))

const started = await evalJs(`(async () => JSON.stringify(await window.ganci.reviewStartNow()))()`)
console.log('手动开轮:', started)
await wait(600)
const after = await evalJs(`(async () => {
  const d = await window.ganci.dashboardState();
  return { reason: d.nextFireReason, rounds: d.recentRounds.length };
})()`)
console.log('开轮后面板:', JSON.stringify(after))
ws.close()
process.exit(0)
