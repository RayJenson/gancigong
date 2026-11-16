/**
 * 探针七：验收要点 1 —— 3000 词无释义 CSV 的离线补全率。
 * 直接从词典里取词（含变形词，验证倒排索引），写一份只有「单词」列的 CSV，
 * 走真实导入链路，统计 need_meaning 命中率，最后删掉临时词表。
 * 用法：node scripts/scale-probe.mjs [cdpPort]
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const BASE = `http://127.0.0.1:${process.argv[2] ?? '9222'}`
const dict = (await import('./../resources/dictionary/words.json', { with: { type: 'json' } })).default

// 2500 个原形 + 500 个变形（复数/过去式/现在分词），后者专门压倒排索引
const base = dict.filter((e) => e.m && /^[a-z]{4,12}$/.test(e.w))
const shuffled = base.map((e, i) => [i, Math.random()]).sort((a, b) => a[1] - b[1]).map(([i]) => base[i])
const terms = shuffled.slice(0, 2500).map((e) => e.w)
const inflected = shuffled
  .slice(2500, 4200)
  .flatMap((e) => (e.f ?? []).map((f) => f.form))
  .filter((f) => /^[a-z]+(ed|ing|s)$/.test(f))
  .slice(0, 500)
const all = [...terms, ...inflected]

const csv = `${'单词\r\n' + all.map((t) => `"${t.replace(/"/g, '""')}"`).join('\r\n')}\r\n`
const file = join(tmpdir(), 'ganci-scale-3000.csv')
writeFileSync(file, '﻿' + csv, 'utf8')
console.log(`CSV 就绪：${all.length} 行（原形 ${terms.length} + 变形 ${inflected.length}）→ ${file}`)

let seq = 0
const pending = new Map()
const page = (await (await fetch(`${BASE}/json`)).json()).filter((t) => t.type === 'page')[0]
const ws = await new Promise((resolve, reject) => {
  const s = new WebSocket(page.webSocketDebuggerUrl)
  s.addEventListener('message', (ev) => {
    const d = JSON.parse(ev.data)
    if (d.id && pending.has(d.id)) {
      const { resolve: res, reject: rej } = pending.get(d.id)
      pending.delete(d.id)
      if (d.error) rej(new Error(JSON.stringify(d.error)))
      else res(d.result)
    }
  })
  s.addEventListener('open', () => resolve(s))
  s.addEventListener('error', reject)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
const api = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}

const listName = `scale-probe-${Date.now()}`
await api(`return await window.ganci.listsCreate(${JSON.stringify(listName)}, '探针临时表，跑完即删')`)
const lists = await api('return await window.ganci.listsList()')
const list = lists.find((l) => l.name === listName)

const t0 = Date.now()
const result = await api(`return await window.ganci.wordsImport(${JSON.stringify(file)}, ${list.id})`)
const ms = Date.now() - t0

const written = result.created + result.updated
console.log(`导入耗时 ${ms} ms`)
console.log(
  `总行 ${result.totalRows} / 写入 ${written} / 跳过 ${result.skipped} / 词典补全 ${result.filledFromDict}（${((result.filledFromDict / written) * 100).toFixed(1)}%）/ 待补充 ${result.missingMeaning}`
)
console.log(`错误 ${result.errors.length} 条：${result.errors.join(' | ')}`)
console.log(`词典命中率验收线 90%：${result.filledFromDict / written >= 0.9 ? 'PASS' : 'FAIL'}`)
console.log(`变形词命中样例：${inflected.slice(0, 6).join(', ')}`)

const deleted = await api(`return await window.ganci.listsDelete(${list.id})`)
console.log(`清理临时词表 ${list.id} → ${deleted} 条词被删除`)
process.exit(0)
