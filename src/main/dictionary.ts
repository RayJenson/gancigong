import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { DictEntry } from '@shared/types'

export function resourcePath(relative: string): string {
  return app.isPackaged ? join(process.resourcesPath, relative) : join(app.getAppPath(), relative)
}

let entries: Map<string, DictEntry> | null = null
let inflections: Map<string, string> | null = null
let meta: { count: number; source: string; generatedAt: string; bytes: number } | null = null

function load(): void {
  if (entries) return
  const file = resourcePath(join('resources', 'dictionary', 'words.json'))
  const metaFile = resourcePath(join('resources', 'dictionary', 'meta.json'))
  entries = new Map()
  inflections = new Map()
  if (!existsSync(file)) {
    meta = { count: 0, source: '未构建（运行 npm run dict:build）', generatedAt: '', bytes: 0 }
    return
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as DictEntry[]
  for (const e of raw) {
    const term = e.w.toLowerCase()
    if (!entries.has(term)) entries.set(term, e)
    for (const f of e.f ?? []) {
      const form = f.form.toLowerCase()
      if (form !== term && !entries.has(form) && !inflections.has(form)) inflections.set(form, term)
    }
  }
  meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : { count: raw.length, source: 'ECDICT (MIT)', generatedAt: '', bytes: 0 }
}

export interface LookupResult {
  term: string
  phonetic: string
  meaning: string
  tags: string[]
  forms: { form: string; label: string }[]
  matchedVia?: string
}

/** 精确命中优先，其次通过词形变化（复数/过去式/现在分词）回溯原形 */
export function lookup(term: string): LookupResult | null {
  load()
  const key = term.trim().toLowerCase()
  if (!key || !entries) return null
  const direct = entries.get(key)
  if (direct) return toResult(direct)
  const base = inflections?.get(key)
  if (base) {
    const via = entries.get(base)
    if (via) return { ...toResult(via), matchedVia: base }
  }
  return null
}

function toResult(e: DictEntry): LookupResult {
  return { term: e.w, phonetic: e.p ?? '', meaning: e.m ?? '', tags: e.t ?? [], forms: e.f ?? [] }
}

export function dictionaryStatus() {
  load()
  return { loaded: Boolean(entries), ...(meta ?? { count: 0, source: '', generatedAt: '', bytes: 0 }) }
}

export function preloadDictionary(): void {
  load()
}
