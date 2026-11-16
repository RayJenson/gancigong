/**
 * 探针六：验证「打包后的应用」而不是 dev 版本。
 * 检查词典是否从 process.resourcesPath 读到、调度器是否排上、逃生快捷键是否注册，并跑完整一轮。
 * 用法：node scripts/packed-probe.mjs [cdpPort]
 */
const BASE = `http://127.0.0.1:${process.argv[2] ?? '9223'}`
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

const pages = (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page')
if (!pages.length) {
  console.log('没有可调试页面：打包版可能没带 --remote-debugging-port 启动')
  process.exit(1)
}
const ws = await connect(pages[0].webSocketDebuggerUrl)
const api = async (expr) => {
  const r = await send(ws, 'Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}

const bundle = await api('return await window.ganci.settingsAll()')
console.log('数据目录            :', bundle.dataDir)
console.log('离线词典            :', JSON.stringify(bundle.dictionary))
console.log('复习模式 / 锁       :', bundle.settings.mode, '/', bundle.settings.lockLevel)

const flow = await api('return await window.ganci.flowStatus()')
console.log('调度               :', JSON.stringify({ reason: flow.reason, next: flow.nextFireAt, escape: flow.escapeShortcutReady, combo: flow.escapeShortcutCombo }))

const dash = await api('return await window.ganci.dashboardState()')
console.log('面板               :', JSON.stringify({ due: dash.dueToday, total: dash.totalWords, mastered: dash.mastered, fresh: dash.fresh, next: dash.nextFireReason }))

const started = await api('return await window.ganci.reviewStartNow()')
console.log('开轮               :', JSON.stringify(started))
if (started.ok) {
  const plan = await api(`return await window.ganci.reviewPlan(${started.roundId})`)
  console.log('本轮词             :', plan.cards.map((c) => `${c.term}(${c.meaning ? '有释义' : '无释义'})`).join(' '))
  for (const c of plan.cards) await api(`return await window.ganci.reviewRate(${started.roundId}, ${c.wordId}, 1)`)
  console.log('收轮               :', JSON.stringify(await api(`return await window.ganci.reviewFinish(${started.roundId})`)))
}
process.exit(0)
