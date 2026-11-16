/**
 * 探针四：从 #app 往下打印每一层的实际高度，定位 h-full 断在哪一层。
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

const targets = (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page')
const main = await connect(targets[0].webSocketDebuggerUrl)
const r = await send(main, 'Runtime.evaluate', {
  expression: `(() => {
    const out = []
    let el = document.getElementById('app')
    while (el && out.length < 10) {
      const cls = (el.className || '').toString().split(' ').slice(0, 4).join('.')
      out.push(el.tagName.toLowerCase() + '.' + cls + ' | client=' + el.clientHeight + ' | css=' + getComputedStyle(el).height + ' | pos=' + getComputedStyle(el).position)
      el = el.firstElementChild
    }
    return out.join('\\n')
  })()`,
  returnByValue: true,
})
console.log(`视口 ${JSON.stringify(await send(main, 'Runtime.evaluate', { expression: 'innerWidth + "x" + innerHeight', returnByValue: true }).then((x) => x.result.value))}`)
console.log(r.result.value)
process.exit(0)
