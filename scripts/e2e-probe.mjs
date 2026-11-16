/**
 * 端到端探针：通过 Electron 的远程调试端口驱动真实 IPC 管线。
 * 仅开发期使用，不属于应用代码。
 */
const BASE = 'http://127.0.0.1:9222'
const CSV = process.argv[2] ?? ''

let id = 0
const pending = new Map()
let ws

function send(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    target.ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data)
      if (data.id && pending.has(data.id)) {
        const { resolve: res, reject: rej } = pending.get(data.id)
        pending.delete(data.id)
        if (data.error) rej(new Error(JSON.stringify(data.error)))
        else res(data.result)
      }
    })
    socket.addEventListener('open', () => resolve({ ws: socket }))
    socket.addEventListener('error', reject)
  })
}

async function listTargets() {
  const res = await fetch(`${BASE}/json`)
  return (await res.json()).filter((t) => t.type === 'page')
}

async function evalIn(session, expression) {
  const result = await send(session, 'Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
  }
  return result.result.value
}

async function openPage(match) {
  for (let i = 0; i < 40; i++) {
    const targets = await listTargets()
    const hit = targets.find(match)
    if (hit) return { session: await connect(hit.webSocketDebuggerUrl), target: hit }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('target not found')
}

const log = (label, value) => console.log(`\n### ${label}\n${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}`)

const main = await openPage((t) => /localhost|index\.html/.test(t.url) && !/#\/(review|cover)/.test(t.url))
log('main page', main.target.url)

const api = (expr) => evalIn(main.session, expr)

const importResult = await api(`
  const r = await window.ganci.wordsImport(${JSON.stringify(CSV)}, null);
  return r;
`)
log('CSV 导入', importResult)

const lists = await api('return await window.ganci.listsList()')
log('词表', lists)

const page1 = await api('return (await window.ganci.wordsList({ limit: 5, sort: "due" })).rows.map(w => ({ term: w.term, meaning: w.meaning.slice(0, 24), needMeaning: w.needMeaning, tags: w.tags }))')
log('前 5 个词', page1)

const inflection = await api('return await window.ganci.dictLookup("abandoned")')
log('词典词形还原 abandoned', inflection && { term: inflection.term, matchedVia: inflection.matchedVia, meaning: inflection.meaning.slice(0, 30) })

const started = await api('return await window.ganci.reviewStartNow()')
log('开启复习轮', started)

const review = await openPage((t) => /#\/review/.test(t.url))
log('复习窗口', review.target.url)
log(
  '所有页面目标',
  (await listTargets()).map((t) => t.url)
)

const plan = await api(`return await window.ganci.reviewPlan(${started.roundId})`)
log('本轮卡片', {
  mode: plan.mode,
  lockLevel: plan.lockLevel,
  quotaLeft: plan.delayQuotaLeft,
  cards: plan.cards.map((c) => ({ term: c.term, hasMeaning: Boolean(c.meaning), forms: c.forms.length })),
})

const shot = await send(review.session, 'Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(`${process.env.TEMP}/ganci-review.png`, Buffer.from(shot.data, 'base64'))
log('已截图', `${process.env.TEMP}\\ganci-review.png`)

const rated = []
for (const card of plan.cards) {
  const r = await api(`return await window.ganci.reviewRate(${plan.roundId}, ${card.wordId}, 1)`)
  rated.push({ term: card.term, ...r })
}
log('逐词标记（认识）', rated.map((r) => ({ term: r.term, intervalDays: r.intervalDays, nextDue: new Date(r.nextDueAt).toLocaleDateString('zh-CN') })))

const finished = await api(`return await window.ganci.reviewFinish(${plan.roundId})`)
log('结束本轮', finished)

const forget = await api(`
  const r0 = await window.ganci.reviewStartNow();
  const p = await window.ganci.reviewPlan(r0.roundId);
  const first = p.cards[0];
  const before = first ? first.term : null;
  const x = first ? await window.ganci.reviewRate(r0.roundId, first.wordId, 0) : null;
  if (x) await window.ganci.reviewFinish(r0.roundId);
  return { before, x };
`)
log('标记不认识后间隔回落', forget)

const quota = await api(`
  const out = [];
  for (let i = 0; i < 4; i++) {
    const r = await window.ganci.reviewStartNow();
    if (!r.ok) { out.push({ step: i, start: r }); break }
    const d = await window.ganci.reviewDelay(r.roundId, 'probe');
    out.push({ step: i, roundId: r.roundId, delay: d });
  }
  return out;
`)
log('延后配额（默认每日 3 次）', quota)

const dash = await api('return await window.ganci.dashboardState()')
log('复习台状态', {
  nextFireAt: dash.nextFireAt ? new Date(dash.nextFireAt).toLocaleTimeString('zh-CN') : null,
  reason: dash.nextFireReason,
  dueToday: dash.dueToday,
  mastered: dash.mastered,
  fresh: dash.fresh,
  needMeaning: dash.needMeaning,
  totalWords: dash.totalWords,
  delayUsed: dash.delayUsed,
  delayQuota: dash.delayQuota,
  roundsToday: dash.roundsToday,
  wordsToday: dash.wordsToday,
  recentRounds: dash.recentRounds.length,
})

const stats = await api('return await window.ganci.statsOverview()')
log('统计', {
  counts: stats.counts,
  streak: stats.streak,
  knowRateToday: stats.knowRateToday,
  dailyTail: stats.daily.slice(-3),
  topLapse: stats.topLapses[0] ?? null,
})

const flow = await api('return await window.ganci.flowStatus()')
log('调度与逃生键', flow)

process.exit(0)
