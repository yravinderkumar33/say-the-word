import { app, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { isOwnPageUrl } from './app-url'

/** True for our own pages: the `app://` scheme, plus the dev server in development. */
function isOwnUrl(url: string): boolean {
  return isOwnPageUrl(url, process.env['ELECTRON_RENDERER_URL'])
}

/** Grants nothing except microphone audio, and only to our own pages. */
export function restrictPermissions(): void {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const audioOnly =
      permission === 'media' &&
      'mediaTypes' in details &&
      details.mediaTypes?.length === 1 &&
      details.mediaTypes[0] === 'audio'
    callback(audioOnly && isOwnUrl(details.requestingUrl))
  })

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return permission === 'media' && isOwnUrl(requestingOrigin)
  })
}

/** No page may open a window, embed a webview, or navigate away from our own origins. */
export function lockDownWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('will-navigate', (event, url) => {
      if (!isOwnUrl(url)) event.preventDefault()
    })
  })
}

/**
 * Registers an IPC handler that answers only our own pages. A frame from anywhere
 * else is refused, whatever it asks for.
 */
export function handleFromOwnPages<T>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, payload: unknown) => T | Promise<T>,
): void {
  ipcMain.handle(channel, (event, payload: unknown) => {
    const url = event.senderFrame?.url
    if (!url || !isOwnUrl(url)) throw new Error(`refused ${channel} from an untrusted frame`)
    return handler(event, payload)
  })
}

/** The same rule for one-way messages: anything not sent by our own pages is dropped. */
export function listenFromOwnPages(
  channel: string,
  listener: (payload: unknown, event: IpcMainEvent) => void,
): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    const url = event.senderFrame?.url
    if (url && isOwnUrl(url)) listener(payload, event)
  })
}
