import { app, BrowserWindow, globalShortcut, shell } from 'electron'
import { join } from 'node:path'
import { applyAutostart } from './autostart'
import { dbPath, initDb, logEvent, run } from './db'
import { preloadDictionary } from './dictionary'
import { ensureDefaultList } from './words'
import { registerIpc } from './ipc'
import { currentSessionRound, revealMainWindow } from './windows'
import { startScheduler, stopScheduler } from './scheduler'
import { flowStatus, handleEscape, startRound } from './flow'
import { hasActiveRound } from './rounds'
import { getSettings } from './settings'
import { initTray, updateTrayTooltip } from './tray'
import { registerEscapeShortcut } from './shortcuts'
import { formatCountdown } from '@shared/time'

app.setName('赶词工')

let mainWindow: BrowserWindow | null = null
let quitting = false
let tooltipTimer: NodeJS.Timeout | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

/** 上次异常退出留下的未完成轮次：静默补记，不重复弹窗轰炸 */
function cleanupStaleRounds(): void {
  const { changes } = run("update rounds set status = 'aborted', finished_at = ? where status = 'open'", Date.now())
  if (changes) logEvent('stale_rounds_cleaned', { count: changes })
}

function createMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) return
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 940,
    minHeight: 620,
    title: '赶词工',
    backgroundColor: '#F4F6F4',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void mainWindow.loadURL(devUrl)
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const dev = process.env['ELECTRON_RENDERER_URL']
    if (dev && url.startsWith(dev)) return
    if (url.startsWith('file://')) return
    e.preventDefault()
  })
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow()
  revealMainWindow(() => mainWindow)
}

function refreshTrayTooltip(): void {
  const status = flowStatus()
  if (!status.nextFireAt) {
    updateTrayTooltip('当前不在复习时段')
    return
  }
  updateTrayTooltip(`${formatAt(status.nextFireAt)} 提醒（${formatCountdown(status.nextFireAt, Date.now())}）`)
}

function formatAt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

void app.whenReady().then(() => {
  initDb()
  preloadDictionary()
  ensureDefaultList()
  cleanupStaleRounds()
  registerIpc(() => mainWindow)

  const escapeOk = registerEscapeShortcut(() => handleEscape('shortcut'))
  logEvent('startup', {
    db: dbPath(),
    escapeShortcutRegistered: escapeOk,
    mode: getSettings().mode,
    lockLevel: getSettings().lockLevel,
  })

  createMainWindow()
  initTray({
    onShow: showMainWindow,
    onReviewNow: () => startRound(true),
    onQuit: () => {
      quitting = true
      app.quit()
    },
  })

  startScheduler(
    () => startRound(false),
    () => hasActiveRound() || currentSessionRound() !== null
  )
  refreshTrayTooltip()
  tooltipTimer = setInterval(refreshTrayTooltip, 20_000)

  if (getSettings().autostart) applyAutostart(true)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    else showMainWindow()
  })
})

app.on('second-instance', () => showMainWindow())

app.on('before-quit', () => {
  quitting = true
  if (tooltipTimer) clearInterval(tooltipTimer)
  stopScheduler()
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* 快捷键随进程释放 */
  }
})

// 关窗不退出：常驻托盘是「软件主动来找你」的前提
app.on('window-all-closed', () => {
  /* 故意不调用 app.quit() */
})

process.on('uncaughtException', (err) => {
  logEvent('uncaught_exception', { message: err.message, stack: err.stack?.slice(0, 600) })
})
