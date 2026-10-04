import { BrowserWindow, ipcMain, screen } from 'electron'
import { IPC } from '@shared/ipc'
import { preloadPath } from '../paths'

// Fixed size: resizing a transparent always-on-top window leaves a stale frame behind.
const OVERLAY_WIDTH = 420
const OVERLAY_HEIGHT = 140
/** Gap between the pill and the bottom of the usable screen area (above the Dock). */
const BOTTOM_GAP = 6

/** The overlay page is loaded again after its process ends, this often at most. */
const MAX_RELOADS = 3
const RELOAD_WINDOW_MS = 60_000

/** Windows that are taking mouse events right now, rather than letting them through. */
const interactive = new WeakSet<BrowserWindow>()

/** True while the pointer is over a pill button, which is the only time the window takes clicks. */
export function isOverlayInteractive(win: BrowserWindow): boolean {
  return interactive.has(win)
}

/**
 * The pill's window. It floats above everything, including fullscreen apps, and must
 * never take focus from the app being dictated into. It also hosts microphone capture.
 */
export function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    hiddenInMissionControl: true,
    ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
    webPreferences: {
      preload: preloadPath('overlay'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // Capture and level metering must keep running while the window is not frontmost.
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver', 1)
  // Called once only: re-applying it makes the window blink.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  // Clicks pass through to the app below, except while the pointer is on a pill control.
  win.setIgnoreMouseEvents(true, { forward: true })

  ipcMain.on(IPC.overlayInteractive, (event, takesClicks: unknown) => {
    if (event.sender !== win.webContents || win.isDestroyed()) return
    if (takesClicks === true) interactive.add(win)
    else interactive.delete(win)
    win.setIgnoreMouseEvents(takesClicks !== true, { forward: true })
  })

  // Only the page ever asks for clicks, so a page that has just loaded, or whose
  // process has ended, cannot be holding the pointer on a button. Left as it was, the
  // whole window would go on swallowing clicks meant for the app underneath.
  const letClicksThrough = (): void => {
    interactive.delete(win)
    if (!win.isDestroyed()) win.setIgnoreMouseEvents(true, { forward: true })
  }
  win.webContents.on('did-finish-load', letClicksThrough)

  // Without its page there is no pill and no microphone. It is loaded again, a few
  // times at most: a page that dies as soon as it loads must not be reloaded for ever.
  let reloads: number[] = []
  win.webContents.on('render-process-gone', (_event, details) => {
    letClicksThrough()
    const now = Date.now()
    reloads = reloads.filter((at) => now - at < RELOAD_WINDOW_MS)
    if (win.isDestroyed() || reloads.length >= MAX_RELOADS) {
      console.error(`[overlay] its process ended (${details.reason}) and it was not loaded again`)
      return
    }
    reloads.push(now)
    console.error(`[overlay] its process ended (${details.reason}); loading it again`)
    win.webContents.reload()
  })
  return win
}

/** Puts the pill at the bottom centre of the display the pointer is on. */
export function positionOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setBounds({
    x: Math.round(workArea.x + (workArea.width - OVERLAY_WIDTH) / 2),
    y: Math.round(workArea.y + workArea.height - OVERLAY_HEIGHT - BOTTOM_GAP),
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
  })
}

/** Shows the pill without activating the app or taking focus. */
export function showOverlay(win: BrowserWindow): void {
  positionOverlay(win)
  win.showInactive()
  const reposition = (): void => positionOverlay(win)
  screen.on('display-metrics-changed', reposition)
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  win.once('closed', () => {
    screen.off('display-metrics-changed', reposition)
    screen.off('display-added', reposition)
    screen.off('display-removed', reposition)
  })
}
