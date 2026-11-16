/**
 * 探针二：验证间隔重复阶梯、延后配额扣减与额度耗尽后的强制复习。
 * 用一个只含 1 个词的临时词表，跑完再恢复设置。
 */
const BASE = 'http://127.0.0.1:9222'
let id = 0
const pending = new Map()

function send(session, method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    session.ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}

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
    ws.addEventListener('open', () => resolve({ ws }))
    ws.addEventListener('error', reject)
  })
}

async function mainSession() {
  for (let i = 0; i < 40; i++) {
    const targets = (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page')
    const hit = targets.find((t) => !/#\/(review|cover)/.test(t.url))
    if (hit) return connect(hit.webSocketDebuggerUrl)
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('main window not found')
}

const session = await mainSession()
async function api(expr) {
  const r = await send(session, 'Runtime.evaluate', {
    expression: `(async () => { ${expr} })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
  return r.result.value
}
const log = (label, v) => console.log(`\n### ${label}\n${typeof v === 'string' ? v : JSON.stringify(v)}`)

const setup = await api(`
  const before = (await window.ganci.settingsAll()).settings;
  const listId = await window.ganci.listsCreate('__探针词表__');
  const created = await window.ganci.wordsCreate(listId, { term: 'ladder', meaning: '探针用词' });
  await window.ganci.settingsSet({ activeListId: listId, wordsPerRound: 1 });
  return { before: { activeListId: before.activeListId, wordsPerRound: before.wordsPerRound }, listId, wordId: created.row.id };
`)
log('临时词表', setup)

const ladder = []
for (let i = 0; i < 7; i++) {
  const r = await api(`
    const s = await window.ganci.reviewStartNow();
    if (!s.ok) return { error: s.reason };
    const p = await window.ganci.reviewPlan(s.roundId);
    const x = await window.ganci.reviewRate(s.roundId, p.cards[0].wordId, 1);
    await window.ganci.reviewFinish(s.roundId);
    return { intervalDays: x.intervalDays, due: new Date(x.nextDueAt).toLocaleDateString('zh-CN') };
  `)
  ladder.push(r)
}
log('连续 7 次「认识」的间隔阶梯', ladder)

const forget = await api(`
  const s = await window.ganci.reviewStartNow();
  const p = await window.ganci.reviewPlan(s.roundId);
  const x = await window.ganci.reviewRate(s.roundId, p.cards[0].wordId, 0);
  await window.ganci.reviewFinish(s.roundId);
  const row = (await window.ganci.wordsList({ listId: ${setup.listId} })).rows[0];
  return { intervalDays: x.intervalDays, reps: row.reps, lapses: row.lapses };
`)
log('一次「不认识」打回', forget)

const quota = await api(`
  const out = [];
  for (let i = 0; i < 5; i++) {
    const s = await window.ganci.reviewStartNow();
    if (!s.ok) { out.push({ start: s.reason }); continue }
    const d = await window.ganci.reviewDelay(s.roundId, 'probe');
    out.push({ left: d.left, ok: d.ok, minutes: d.minutes });
  }
  const q = (await window.ganci.flowStatus()).delay;
  return { out, quota: q };
`)
log('延后配额（默认每日 3 次）', quota)

const forced = await api(`
  const s = await window.ganci.reviewStartNow();
  const p = s.ok ? await window.ganci.reviewPlan(s.roundId) : null;
  const again = p ? await window.ganci.reviewDelay(s.roundId, 'probe_after_exhaust') : null;
  if (s.ok) await window.ganci.reviewFinish(s.roundId);
  return { roundOpened: s.ok, quotaLeftInPlan: p ? p.delayQuotaLeft : null, delayAttempt: again };
`)
log('额度用尽后仍开轮、延后被拒', forced)

const cleanup = await api(`
  await window.ganci.wordsDelete([${setup.wordId}]);
  await window.ganci.listsDelete(${setup.listId});
  return await window.ganci.settingsSet(${JSON.stringify({ activeListId: setup.before.activeListId, wordsPerRound: setup.before.wordsPerRound })});
`)
log('恢复设置', { activeListId: cleanup.activeListId, wordsPerRound: cleanup.wordsPerRound })

const dash = await api('return await window.ganci.dashboardState()')
log('复习台', {
  reason: dash.nextFireReason,
  nextFireAt: dash.nextFireAt ? new Date(dash.nextFireAt).toLocaleTimeString('zh-CN') : null,
  dueToday: dash.dueToday,
  fresh: dash.fresh,
  totalWords: dash.totalWords,
  delayUsed: dash.delayUsed,
  delayQuota: dash.delayQuota,
  roundsToday: dash.roundsToday,
  wordsToday: dash.wordsToday,
})

process.exit(0)
