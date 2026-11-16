import { Menu, Tray, nativeImage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resourcePath } from './dictionary'

let tray: Tray | null = null

function trayImage(): Electron.NativeImage {
  const file = resourcePath(join('resources', 'tray.png'))
  if (existsSync(file)) {
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) return image.resize({ width: 16, height: 16 })
  }
  // 资源缺失时的兜底：16×16 品牌色方块，保证托盘不会因为空图标而消失
  const size = 16
  const bitmap = Buffer.alloc(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    bitmap[i * 4] = 0x5c
    bitmap[i * 4 + 1] = 0x7a
    bitmap[i * 4 + 2] = 0x1f
    bitmap[i * 4 + 3] = 0xff
  }
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size })
}

export interface TrayHandlers {
  onShow: () => void
  onReviewNow: () => void
  onQuit: () => void
}

export function initTray(handlers: TrayHandlers): Tray | null {
  if (tray) return tray
  try {
    tray = new Tray(trayImage())
  } catch {
    return null
  }
  tray.setToolTip('赶词工 · 别让单词等你')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开赶词工', click: handlers.onShow },
      { label: '立即复习一轮', click: handlers.onReviewNow },
      { type: 'separator' },
      {
        label: '退出',
        click: () => handlers.onQuit(),
      },
    ])
  )
  tray.on('click', () => handlers.onShow())
  return tray
}

export function updateTrayTooltip(text: string): void {
  tray?.setToolTip(`赶词工 · ${text}`)
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/** 供构建/调试用：确认托盘图标资源是否就位 */
export function trayIconPresent(): boolean {
  const file = resourcePath(join('resources', 'tray.png'))
  return existsSync(file) && readFileSync(file).length > 0
}
