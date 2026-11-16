/**
 * 探针五：把主窗口切到指定路由并截图，用于逐页视觉核对。
 * 用法：node scripts/shot.mjs [route] [文件名]   例：node scripts/shot.mjs "#/settings" settings.png
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:9222'
const route = process.argv[2] ?? '#/'
const out = join(tmpdir(), process.argv[3] ?? 'ganci-shot.png')
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

const pages = (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page' && !/#\/(review|cover)/.test(t.url))
const ws = await connect(pages[0].webSocketDebuggerUrl)
await send(ws, 'Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(route)}`, returnByValue: true })
await new Promise((r) => setTimeout(r, 1200))
const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.log(out)
process.exit(0)
