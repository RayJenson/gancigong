import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { all, logEvent, run, transaction } from './db'
import { decodeCsv, isoOrEmpty, parseCsv, toCsv } from './csv'
import { lookup } from './dictionary'
import { createList, ensureDefaultList } from './words'
import type { ImportResult } from '@shared/types'

const TERM_SHAPE = /^[A-Za-z][A-Za-z'’.\- ]{0,47}$/

interface ImportRowDb {
  list_id: number
  term: string
  phonetic: string
  meaning: string
  example: string
  tags: string
}

function existingIndex(listId: number): Map<string, ImportRowDb> {
  const rows = all<ImportRowDb>('select list_id, term, phonetic, meaning, example, tags from words where list_id = ?', listId)
  return new Map(rows.map((r) => [r.term.toLowerCase(), r]))
}

function upsertIntoList(listId: number, words: { term: string; phonetic: string; meaning: string; example: string; tags: string }[], result: ImportResult): void {
  const index = existingIndex(listId)
  for (const item of words) {
    const term = item.term.trim().toLowerCase()
    const hit = lookup(term)
    const current = index.get(term)
    if (current) {
      const meaning = item.meaning || current.meaning || hit?.meaning || ''
      const phonetic = item.phonetic || current.phonetic || hit?.phonetic || ''
      const example = item.example || current.example
      const tags = item.tags || current.tags || (hit?.tags ?? []).join(' ')
      const changed = meaning !== current.meaning || phonetic !== current.phonetic || example !== current.example || tags !== current.tags
      if (!changed) {
        result.skipped++
        continue
      }
      if (!item.meaning && hit?.meaning && !current.meaning) result.filledFromDict++
      run(
        'update words set meaning = ?, phonetic = ?, example = ?, tags = ?, need_meaning = ? where list_id = ? and lower(term) = ?',
        meaning, phonetic, example, tags, meaning ? 0 : 1, listId, term
      )
      result.updated++
      continue
    }
    const meaning = item.meaning || hit?.meaning || ''
    if (meaning && !item.meaning) result.filledFromDict++
    if (!meaning) result.missingMeaning++
    run(
      'insert into words (list_id, term, phonetic, meaning, example, tags, need_meaning, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
      listId, term, item.phonetic || hit?.phonetic || '', meaning, item.example, item.tags || (hit?.tags ?? []).join(' '), meaning ? 0 : 1, Date.now()
    )
    result.created++
  }
}

export function importCsvFile(filePath: string, targetListId: number | null): ImportResult {
  const raw = readFileSync(filePath)
  const parsed = parseCsv(decodeCsv(raw))
  const result: ImportResult = {
    created: 0,
    updated: 0,
    skipped: 0,
    filledFromDict: 0,
    missingMeaning: 0,
    totalRows: parsed.totalRows,
    errors: [...parsed.errors],
    fileName: basename(filePath),
  }
  if (!parsed.words.length) {
    result.errors.push('没有解析出任何单词，请检查表头是否包含「单词 / 释义」之类的列')
    return result
  }

  const defaultList = targetListId ?? ensureDefaultList()
  const grouped = new Map<number, typeof parsed.words>()
  const badRows: string[] = []
  for (const w of parsed.words) {
    if (!TERM_SHAPE.test(w.term)) {
      if (badRows.length < 8) badRows.push(`「${w.term.slice(0, 24)}」不像英文单词，已跳过`)
      result.skipped++
      continue
    }
    const listId = w.listName ? createList(w.listName, `来自 ${basename(filePath)}`) : defaultList
    const bucket = grouped.get(listId)
    if (bucket) bucket.push(w)
    else grouped.set(listId, [w])
  }
  result.errors.push(...badRows)

  transaction(() => {
    for (const [listId, words] of grouped) upsertIntoList(listId, words, result)
  })
  logEvent('import', { file: basename(filePath), ...result })
  return result
}

export function exportCsv(listId: number | null, outPath: string): number {
  const rows = all<{
    term: string
    phonetic: string
    meaning: string
    example: string
    tags: string
    list_name: string
    interval_days: number | null
    due_at: number | null
    reps: number | null
    lapses: number | null
  }>(
    `select w.term, w.phonetic, w.meaning, w.example, w.tags, l.name as list_name,
            s.interval_days, s.due_at, s.reps, s.lapses
     from words w join lists l on l.id = w.list_id
     left join word_states s on s.word_id = w.id
     ${listId ? 'where w.list_id = ?' : ''}
     order by l.id, s.due_at is null, s.due_at, w.term`,
    ...(listId ? [listId] : [])
  )
  const grid = rows.map((r) => [
    r.term, r.phonetic, r.meaning, r.example, r.tags, r.list_name,
    r.interval_days ?? 0, isoOrEmpty(r.due_at), r.reps ?? 0, r.lapses ?? 0,
  ])
  writeFileSync(outPath, toCsv(grid), 'utf8')
  logEvent('export', { file: basename(outPath), rows: grid.length })
  return grid.length
}
