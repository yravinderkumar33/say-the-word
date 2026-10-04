import { BrowserWindow } from 'electron'
import { preloadPath } from '../paths'
import { loadRenderer } from './load-renderer'

let hub: BrowserWindow | null = null

/** Opens the Hub window, or brings the existing one forward. */
export function showHubWindow(): BrowserWindow {
  if (hub && !hub.isDestroyed()) {
    hub.show()
    hub.focus()
    return hub
  }
  const win = createHubWindow()
  win.once('ready-to-show', () => win.show())
  return win
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
    title: 'Whisper Flow',
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
