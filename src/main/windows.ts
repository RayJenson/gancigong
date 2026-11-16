import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ActiveRound } from './rounds'
import type { LockLevel, ReviewMode } from '@shared/types'

export interface ReviewWindowHandlers {
  /** 用户尝试关闭窗口时回调；返回 false 表示不允许关闭（额度用尽） */
  onCloseAttempt: (roundId: number) => boolean
  /** 窗口全部销毁后回调，用于收尾 */
  onWindowsClosed: (roundId: number) => void
}

export interface ReviewSession {
  roundId: number
  mode: ReviewMode
  lockLevel: LockLevel
  windows: BrowserWindow[]
  handlers: ReviewWindowHandlers
  destroyed: boolean
}

let session: ReviewSession | null = null
let closingSilently = false

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function rendererUrl(hash: string): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return `${devUrl}#/${hash}`
  return pathToFileURL(join(__dirname, '../renderer/index.html')).toString() + `#/${hash}`
}

const GENTLE = { width: 420, height: 300, margin: 24 }

function basePreferences() {
  return {
    preload: preloadPath(),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
  }
}

function topRight(): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - GENTLE.width - GENTLE.margin, y: wa.y + GENTLE.margin }
}

function createGentle(roundId: number): BrowserWindow {
  const win = new BrowserWindow({
    ...topRight(),
    width: GENTLE.width,
    height: GENTLE.height,
    useContentSize: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: basePreferences(),
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadURL(rendererUrl(`review?round=${roundId}&mode=gentle`))
  return win
}

function createFullscreen(roundId: number, display: Electron.Display, isPrimary: boolean, lockLevel: LockLevel): BrowserWindow {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    fullscreenable: true,
    skipTaskbar: false,
    backgroundColor: '#121917',
    show: false,
    webPreferences: basePreferences(),
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setMenuBarVisibility(false)
  if (lockLevel === 'kiosk') win.setKiosk(true)
  win.setFullScreen(true)
  const route = isPrimary ? `review?round=${roundId}&mode=fullscreen&lock=${lockLevel}` : `cover?round=${roundId}`
  win.loadURL(rendererUrl(route))
  return win
}

function wireWindow(win: BrowserWindow, roundId: number): void {
  win.on('close', (e) => {
    if (closingSilently || !session) return
    e.preventDefault()
    const allowed = session.handlers.onCloseAttempt(roundId)
    if (!allowed) win.focus()
  })
  if (session?.mode === 'fullscreen') {
    // 应用级锁定不去动系统快捷键，但要把焦点抢回来
    win.on('blur', () => {
      if (!session || closingSilently) return
      setTimeout(() => {
        if (session && !closingSilently && !win.isDestroyed() && !win.isFocused()) win.focus()
      }, 120)
    })
  }
  win.once('closed', () => {
    if (!session) return
    session.windows = session.windows.filter((w) => w !== win)
    if (session.windows.length === 0 && !session.destroyed) {
      session.destroyed = true
      const id = session.roundId
      const handlers = session.handlers
      session = null
      handlers.onWindowsClosed(id)
    }
  })
}

export function currentSessionRound(): number | null {
  return session?.roundId ?? null
}

export function openReviewWindows(round: ActiveRound, handlers: ReviewWindowHandlers, lockAllDisplays: boolean): void {
  closeReviewWindows()
  const displays = screen.getAllDisplays()
  const primaryId = screen.getPrimaryDisplay().id
  const windows: BrowserWindow[] = []

  if (round.mode === 'gentle') {
    windows.push(createGentle(round.id))
  } else {
    const chosen = lockAllDisplays ? displays : displays.filter((d) => d.id === primaryId)
    const targets = chosen.length ? chosen : displays.slice(0, 1)
    for (const d of targets) windows.push(createFullscreen(round.id, d, d.id === primaryId, round.lockLevel))
  }

  session = { roundId: round.id, mode: round.mode, lockLevel: round.lockLevel, windows, handlers, destroyed: false }
  for (const w of windows) {
    wireWindow(w, round.id)
    w.once('ready-to-show', () => {
      if (session?.roundId !== round.id || w.isDestroyed()) return
      w.show()
      if (round.mode === 'fullscreen') w.focus()
    })
    // ready-to-show 在全屏切换时偶尔不触发，兜底显示
    setTimeout(() => {
      if (session?.roundId === round.id && !w.isDestroyed() && !w.isVisible()) w.show()
    }, 1500)
  }
}

/** 静默关闭所有复习窗口：不走 onCloseAttempt，用于本轮完成/中止/逃生 */
export function closeReviewWindows(): void {
  const s = session
  if (!s) return
  // 先清会话，否则 currentSessionRound() 会一直返回已结束的轮次，后续复习全被 already_running 挡掉
  session = null
  closingSilently = true
  for (const w of s.windows) {
    if (!w.isDestroyed()) {
      try {
        if (w.isFullScreen()) w.setFullScreen(false)
        if (s.lockLevel === 'kiosk') w.setKiosk(false)
      } catch {
        /* 窗口正在销毁 */
      }
      w.destroy()
    }
  }
  closingSilently = false
}

export function revealMainWindow(getWindow: () => BrowserWindow | null): void {
  const win = getWindow()
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
