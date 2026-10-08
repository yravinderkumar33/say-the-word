import { IPC } from '@shared/ipc-channels'

let current: MessagePort | null = null
const waiting: Array<(port: MessagePort) => void> = []

/**
 * Receives the MessagePort that leads to the speech worker. The preload forwards it
 * with window.postMessage. A later delivery means the worker was restarted and
 * replaces the old port; `onPort` is told about every one.
 */
export function listenForSttPort(onPort?: (port: MessagePort) => void): void {
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return
    const data = event.data as { channel?: unknown } | null
    if (data?.channel !== IPC.sttPort) return
    const port = event.ports[0]
    if (!port) return
    current = port
    onPort?.(port)
    for (const resolve of waiting.splice(0)) resolve(port)
  })
}

export function sttPort(timeoutMs: number): Promise<MessagePort> {
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const deliver = (port: MessagePort): void => {
      clearTimeout(timer)
      resolve(port)
    }
    const timer = setTimeout(() => {
      // Given up on: nothing is left waiting for the port.
      const index = waiting.indexOf(deliver)
      if (index >= 0) waiting.splice(index, 1)
      reject(new Error(`no port to the speech worker within ${timeoutMs} ms`))
    }, timeoutMs)
    waiting.push(deliver)
  })
}
