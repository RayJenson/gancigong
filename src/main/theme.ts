import { app, dialog } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { extname, join } from 'node:path'
import { getSettings, setSettings } from './settings'
import type { ThemeState } from '@shared/types'

const MAX_BYTES = 20 * 1024 * 1024

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
}

function themeDir(): string {
  return join(app.getPath('userData'), 'theme')
}

function clearFiles(): void {
  const dir = themeDir()
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (name.startsWith('background')) unlinkSync(join(dir, name))
  }
}

function readDataUrl(name: string): string | null {
  if (!name) return null
  const path = join(themeDir(), name)
  if (!existsSync(path)) return null
  const meta = statSync(path)
  if (!meta.isFile() || meta.size > MAX_BYTES) return null
  const mime = MIME[extname(path).toLowerCase()]
  if (!mime) return null
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

export function themeState(): ThemeState {
  const settings = getSettings()
  return {
    mode: settings.themeMode,
    accent: settings.themeAccent,
    backgroundUrl: readDataUrl(settings.themeBackground),
    scrim: settings.themeScrim,
  }
}

export async function pickBackground(): Promise<string | null> {
  const picked = await dialog.showOpenDialog({
    title: '选择背景图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  })
  const source = picked.filePaths[0]
  if (picked.canceled || !source) return null

  const ext = extname(source).toLowerCase()
  if (!MIME[ext]) throw new Error('只支持 PNG / JPG / WebP / BMP / GIF 图片')
  if (statSync(source).size > MAX_BYTES) throw new Error('图片超过 20 MB，换一张小一点的吧')

  mkdirSync(themeDir(), { recursive: true })
  clearFiles()
  const name = `background${ext}`
  copyFileSync(source, join(themeDir(), name))
  setSettings({ themeBackground: name })
  return readDataUrl(name)
}

export function clearBackground(): boolean {
  clearFiles()
  if (getSettings().themeBackground) setSettings({ themeBackground: '' })
  return true
}
