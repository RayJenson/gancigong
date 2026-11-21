/** 通用 CDP 求值：node scripts/cdp-eval.mjs "<expression>" [截图路径] */
import { writeFileSync } from 'node:fs'

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

const expression = process.argv[2]
const match = process.env.CDP_MATCH ?? ''
const pages = (await (await fetch(`${BASE}/json/list`)).json()).filter((t) => t.type === 'page')
const target =
  pages.find((t) => match && t.url.includes(match)) ??
  pages.find((t) => t.url !== 'about:blank') ??
  pages[0]
if (!target) {
  console.error('no CDP target')
  process.exit(1)
}
setTimeout(() => {
  console.error('cdp-eval timeout')
  process.exit(2)
}, 15_000)
const ws = await connect(target.webSocketDebuggerUrl)
const r = await send(ws, 'Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
})
if (r.exceptionDetails) {
  console.error(JSON.stringify(r.exceptionDetails, null, 2))
} else {
  console.log(JSON.stringify(r.result.value, null, 2))
}
const shotPath = process.argv[3]
if (shotPath) {
  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
  console.log(`screenshot: ${shotPath}`)
}
process.exit(0)
