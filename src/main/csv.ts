import Papa from 'papaparse'
import { Buffer } from 'node:buffer'

export interface CsvWord {
  term: string
  phonetic: string
  meaning: string
  example: string
  tags: string
  listName: string
}

export interface CsvParseResult {
  words: CsvWord[]
  errors: string[]
  columns: string[]
  headerDetected: boolean
  totalRows: number
}

const COLUMN_KEYS: Record<keyof CsvWord, string[]> = {
  term: ['word', 'term', 'english', 'vocabulary', 'headword', '单词', '英文', '词汇'],
  meaning: ['meaning', 'translation', 'chinese', 'definition', '释义', '翻译', '中文', '解释', '意思'],
  phonetic: ['phonetic', 'phonetics', 'ipa', '音标'],
  example: ['example', 'sentence', 'context', '例句', '例子'],
  tags: ['tag', 'tags', 'label', '标签'],
  listName: ['list', 'group', 'book', '词表', '分组', '课本'],
}

function matchKey(header: string): keyof CsvWord | null {
  const norm = header.trim().toLowerCase().replace(/[_\s-]/g, '')
  for (const [key, aliases] of Object.entries(COLUMN_KEYS) as [keyof CsvWord, string[]][]) {
    if (aliases.some((a) => norm === a.replace(/[_\s-]/g, ''))) return key
  }
  return null
}

export function decodeCsv(buf: ArrayBuffer | Buffer): string {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3).toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    for (const encoding of ['gbk', 'gb18030', 'big5']) {
      try {
        return new TextDecoder(encoding).decode(bytes)
      } catch {
        /* 当前 ICU 不含该编码，试下一个 */
      }
    }
    return new TextDecoder('utf-8').decode(bytes)
  }
}

export function parseCsv(text: string): CsvParseResult {
  const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ''), { skipEmptyLines: 'greedy' })
  const grid = parsed.data.map((row) => row.map((cell) => (cell ?? '').toString().trim()))
  // 只有一列的 CSV 必然「探测不到分隔符」，papaparse 会当成错误报出来，这条噪音过滤掉
  const errors = parsed.errors
    .filter((e) => !/Unable to auto-detect delimiting character/i.test(e.message))
    .slice(0, 20)
    .map((e) => `第 ${(e.row ?? 0) + 1} 行：${e.message}`)
  if (!grid.length) {
    return { words: [], errors: errors.length ? errors : ['文件里没有内容'], columns: [], headerDetected: false, totalRows: 0 }
  }

  const first = grid[0]
  const headerMap = first.map(matchKey)
  const headerDetected = headerMap.some((k) => k !== null)
  const columns = headerDetected ? first : first.map((_, i) => `第 ${i + 1} 列`)
  const assign = headerDetected ? headerMap : (['term', 'meaning'] as (keyof CsvWord | null)[])
  const body = headerDetected ? grid.slice(1) : grid

  const words: CsvWord[] = []
  const seen = new Set<string>()
  for (const row of body) {
    const item: CsvWord = { term: '', phonetic: '', meaning: '', example: '', tags: '', listName: '' }
    row.forEach((cell, i) => {
      const key = assign[i]
      if (key && cell && !item[key]) item[key] = cell
    })
    if (!item.term && !headerDetected && row[0]) item.term = row[0]
    if (!item.term) continue
    const dedup = `${item.listName}::${item.term.toLowerCase()}`
    if (seen.has(dedup)) continue
    seen.add(dedup)
    words.push(item)
  }

  return { words, errors, columns, headerDetected, totalRows: body.length }
}

const EXPORT_HEADER = ['term', 'phonetic', 'meaning', 'example', 'tags', 'list', 'interval_days', 'due_at', 'reps', 'lapses']

export function toCsv(rows: (string | number | null)[][]): string {
  const body = rows.map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v))))
  return '﻿' + Papa.unparse({ fields: EXPORT_HEADER, data: body })
}

export function isoOrEmpty(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
