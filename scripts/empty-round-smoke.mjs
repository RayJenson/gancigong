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
const evalJs = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) return { __err: r.exceptionDetails.exception?.description ?? 'eval error' }
  return r?.result?.value
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const G = (body) => `(async () => { ${body} })()`

await wait(1200)

// 1. 塞三个测试词
const made = await evalJs(G(`
  const list = (await window.ganci.listsList())[0];
  const terms = ['apple','chasten','dedupe'];
  const out = [];
  for (const t of terms) out.push(await window.ganci.wordsCreate(list.id, { term: t, meaning: '测试释义 ' + t }));
  return JSON.stringify({ listId: list.id, created: out.map(o => o.row.id), fromDict: out.map(o => o.fromDictionary) });
`))
console.log('1 建词:', JSON.stringify(made))

// 2. 手动开一轮（有词）
const started = await evalJs(G(`return JSON.stringify(await window.ganci.reviewStartNow())`))
console.log('2 开轮:', started)
const parsed = JSON.parse(started)
if (!parsed.ok) {
  console.log('FAIL: 有词也开不了轮')
  ws.close()
  process.exit(1)
}

// 3. 逐词标记（走 review 窗口自己的链路更真，这里用 IPC 直接标完）
const rated = await evalJs(G(`
  const plan = await window.ganci.reviewPlan(${parsed.roundId});
  if (!plan) return JSON.stringify({ error: 'no plan' });
  const res = [];
  for (const c of plan.cards) res.push(await window.ganci.reviewRate(${parsed.roundId}, c.wordId, 2));
  const done = await window.ganci.reviewFinish(${parsed.roundId});
  return JSON.stringify({ cards: plan.cards.length, rated: res.length, done });
`))
console.log('3 标记:', JSON.stringify(rated))

await wait(800)

// 4. 面板与库状态
const afterRound = await evalJs(G(`
  const d = await window.ganci.dashboardState();
  return JSON.stringify({ reason: d.nextFireReason, rounds: d.recentRounds, total: d.totalWords, mastered: d.mastered });
`))
console.log('4 轮后面板:', JSON.stringify(afterRound))

// 5. 清空词库，再手动开轮 → 不应新增 rounds 行
const wiped = await evalJs(G(`
  const list = (await window.ganci.listsList())[0];
  const rows = (await window.ganci.wordsList({ listId: list.id, limit: 50 })).rows;
  return String(await window.ganci.wordsDelete(rows.map(r => r.id)));
`))
console.log('5 删词:', JSON.stringify(wiped))
const emptyStart = await evalJs(G(`return JSON.stringify(await window.ganci.reviewStartNow())`))
console.log('6 空库手动开轮:', emptyStart)
await wait(600)
const final = await evalJs(G(`
  const d = await window.ganci.dashboardState();
  return JSON.stringify({ reason: d.nextFireReason, next: d.nextFireAt, rounds: d.recentRounds.length });
`))
console.log('7 收尾面板:', JSON.stringify(final))

ws.close()
process.exit(0)
