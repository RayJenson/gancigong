#!/usr/bin/env node
/**
 * 从 ECDICT 派生数据（MIT）构建精简离线词典 resources/dictionary/words.json
 * 数据源包 cdict_query 内含 db/cdict2w.db（56992 词，word/phonetic/translation/tag/frq/exchange）
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE_DB = join(ROOT, '.cache', 'cdict2w.db')
const OUT_DIR = join(ROOT, 'resources', 'dictionary')
const REGISTRY = 'https://registry.npmmirror.com'
const PKG = 'cdict_query'
const VERSION = '1.0.0'

const EXAM_TAGS = ['zk', 'gk', 'cet4', 'cet6', 'ky']
const FRQ_CUTOFF = 20000
const TAG_LABELS = {
  zk: '中考', gk: '高考', cet4: '四级', cet6: '六级', ky: '考研',
  toefl: 'TOEFL', ielts: 'IELTS', gre: 'GRE',
}
const FORM_CODES = {
  d: '过去分词', p: '过去式', i: '现在分词', s: '复数/三单', r: '比较级', t: '最高级',
  0: '原形', 1: '过去式', 2: '过去分词', 3: '三单', 4: '现在分词', 5: '复数', 6: '比较级', 7: '最高级',
}

function ensureSourceDb() {
  if (existsSync(CACHE_DB)) return
  mkdirSync(dirname(CACHE_DB), { recursive: true })
  const meta = JSON.parse(readFileSync(fetchJson(`${REGISTRY}/${PKG}/latest`), 'utf8'))
  const tarball = join(dirname(CACHE_DB), `${PKG}-${VERSION}.tgz`)
  console.log('下载词典源包', meta.dist.tarball)
  const code = spawnSync('curl', ['-sSL', '-m', '300', '-o', tarball, meta.dist.tarball], { shell: true })
  if (code.status !== 0) throw new Error('下载失败')
  const tmp = join(dirname(CACHE_DB), 'extract')
  mkdirSync(tmp, { recursive: true })
  const extract = spawnSync('tar', ['-xzf', tarball, '-C', tmp], { shell: true })
  if (extract.status !== 0) throw new Error('解压失败')
  const src = join(tmp, 'package', 'db', 'cdict2w.db')
  writeFileSync(CACHE_DB, readFileSync(src))
}

// 同步取 JSON：先落到临时文件再读，避免依赖 fetch 的顶层 await
function fetchJson(url) {
  const file = join(dirname(CACHE_DB), 'latest.json')
  mkdirSync(dirname(CACHE_DB), { recursive: true })
  const r = spawnSync('curl', ['-sS', '-m', '60', '-o', file, url], { shell: true })
  if (r.status !== 0) throw new Error('元数据获取失败 ' + url)
  return file
}

function cleanPhonetic(raw) {
  if (!raw) return ''
  return raw.replace(/ә/g, 'ə').replace(/^[\/\[]\s*|\s*[\]\/]$/g, '').trim()
}

function cleanMeaning(raw) {
  if (!raw) return ''
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const plain = lines.filter((l) => !/^\[.+?\]/.test(l))
  if (plain.length) return plain.slice(0, 4).join(' ')
  // 只有 [计]/[医] 这类专业释义时，去掉领域标记保留正文
  const stripped = lines.map((l) => l.replace(/^\[.+?\]\s*/, '')).filter(Boolean)
  return stripped.slice(0, 3).join(' ')
}

function parseForms(exchange, word) {
  if (!exchange) return []
  const seen = new Set()
  const out = []
  for (const part of exchange.split('/').filter(Boolean)) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const code = part.slice(0, i)
    const value = part.slice(i + 1).trim()
    if (!value || value.toLowerCase() === word.toLowerCase()) continue
    if (!FORM_CODES[code] || seen.has(value)) continue
    seen.add(value)
    out.push({ form: value, label: FORM_CODES[code] })
  }
  return out.slice(0, 6)
}

function parseTags(tag) {
  if (!tag) return []
  return tag.split(/\s+/).filter((t) => TAG_LABELS[t]).map((t) => TAG_LABELS[t])
}

function main() {
  ensureSourceDb()
  const db = new DatabaseSync(CACHE_DB, { readOnly: true })
  const like = EXAM_TAGS.map((t) => `tag like '%${t}%'`).join(' or ')
  const rows = db
    .prepare(
      `select word, phonetic, translation, tag, nullif(frq, 0) as frq, exchange from stardict
       where coalesce(translation,'') <> '' and length(word) between 2 and 40
         and (${like} or frq between 1 and ?)
       order by frq`
    )
    .all(FRQ_CUTOFF)
  db.close()

  const entries = []
  const dedup = new Set()
  for (const r of rows) {
    const term = String(r.word).trim().toLowerCase()
    const meaning = cleanMeaning(r.translation)
    if (!meaning) continue
    if (!/^[a-z][a-z' -]*$/i.test(term) || dedup.has(term)) continue
    dedup.add(term)
    entries.push({
      w: term,
      p: cleanPhonetic(r.phonetic),
      m: meaning,
      f: parseForms(r.exchange, r.word),
      t: parseTags(r.tag),
    })
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const json = JSON.stringify(entries)
  writeFileSync(join(OUT_DIR, 'words.json'), json, 'utf8')
  writeFileSync(
    join(OUT_DIR, 'meta.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        source: `${PKG}@${VERSION} (ECDICT derived, MIT)`,
        count: entries.length,
        withPhonetic: entries.filter((e) => e.p).length,
        withForms: entries.filter((e) => e.f.length).length,
        bytes: Buffer.byteLength(json),
      },
      null,
      2
    ),
    'utf8'
  )
  console.log(
    `词条 ${entries.length}｜音标 ${entries.filter((e) => e.p).length}｜词形 ${entries.filter((e) => e.f.length).length}｜${(Buffer.byteLength(json) / 1048576).toFixed(2)} MB`
  )
}

main()
