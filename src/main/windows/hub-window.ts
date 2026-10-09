import { BrowserWindow, app, nativeTheme } from 'electron'
import { IPC, type HubPage } from '@shared/ipc'
import { PRODUCT_NAME } from '@shared/product'
import { preloadPath } from '../paths'
import { loadRenderer } from './load-renderer'

let hub: BrowserWindow | null = null

/** The Hub window, if there is one. */
export function currentHubWindow(): BrowserWindow | null {
  return hub && !hub.isDestroyed() ? hub : null
}

/** Opens the Hub window, or brings the existing one forward. With a page, shows that page. */
export function showHubWindow(page?: HubPage): BrowserWindow {
  if (hub && !hub.isDestroyed()) {
    hub.show()
    hub.focus()
    comeForward()
    if (page) hub.webContents.send(IPC.hubNavigate, page)
    return hub
  }
  const win = createHubWindow()
  win.once('ready-to-show', () => {
    win.show()
    comeForward()
  })
  // The page is not listening until it has loaded.
  if (page)
    win.webContents.once('did-finish-load', () => win.webContents.send(IPC.hubNavigate, page))
  return win
}

/**
 * Brings the app to the front with its window. Without a Dock icon macOS does not do
 * that by itself: the window would open behind whatever is in front.
 */
function comeForward(): void {
  // A test's instance never comes to the front: someone may be using the Mac.
  if (!process.env['WHISPER_FLOW_QUIET']) app.focus({ steal: true })
}

/** Closes the Hub window. The app runs on: the pill and the menu bar are the product. */
export function closeHubWindow(): void {
  if (hub && !hub.isDestroyed()) hub.close()
}

/** Creates the Hub window without showing it. */
export function createHubWindow(): BrowserWindow {
  if (hub && !hub.isDestroyed()) return hub

  const win = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: PRODUCT_NAME,
    // The window's own sidebar runs to the top, with the close, minimise and zoom
    // buttons over it. The page marks which parts of its top edge drag the window.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // The page's own background, so that the window does not flash white before it draws.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e20' : '#ffffff',
    webPreferences: {
      preload: preloadPath('hub'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  hub = win
  win.once('closed', () => {
    hub = null
  })
  loadRenderer(win, 'hub').catch((error: unknown) => {
    console.error('[hub] the window did not load:', error instanceof Error ? error.message : error)
  })
  return win
}
