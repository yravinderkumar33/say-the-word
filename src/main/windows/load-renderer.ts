import type { BrowserWindow } from 'electron'
import { APP_ORIGIN } from '../app-url'

/** Loads a renderer page from the dev server in development, or from `app://` otherwise. */
export function loadRenderer(win: BrowserWindow, page: 'overlay' | 'hub'): Promise<void> {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  return win.loadURL(`${devUrl ?? APP_ORIGIN}/${page}.html`)
}
