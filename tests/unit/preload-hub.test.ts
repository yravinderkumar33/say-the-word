import { describe, expect, it, vi } from 'vitest'
import type { HubBridge } from '@shared/bridge'
import { IPC } from '@shared/ipc-channels'

type Listener = (...args: unknown[]) => void
const electron = vi.hoisted(() => ({
  listeners: new Map<string, Set<(...args: unknown[]) => void>>(),
  bridge: null as unknown,
}))
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => (electron.bridge = api),
  },
  ipcRenderer: {
    invoke: () => Promise.resolve(),
    on: (channel: string, listener: Listener) => {
      const set = electron.listeners.get(channel) ?? new Set()
      set.add(listener)
      electron.listeners.set(channel, set)
    },
    removeListener: (channel: string, listener: Listener) =>
      electron.listeners.get(channel)?.delete(listener),
  },
}))
await import('../../src/preload/hub')

/** What the main process sending on a channel looks like to the preload. */
const send = (channel: string, ...args: unknown[]): void => {
  const event = { sender: 'the ipcRenderer itself', senderFrame: null, ports: [] }
  for (const listener of electron.listeners.get(channel) ?? []) listener(event, ...args)
}

describe("the main window's bridge", () => {
  it('tells the page of a privacy reset without handing it the IPC event', () => {
    const bridge = electron.bridge as HubBridge
    const handle = vi.fn()

    const stop = bridge.onPrivacyReset(handle)
    send(IPC.privacyReset)

    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls[0]).toEqual([])

    stop()
    send(IPC.privacyReset)
    expect(handle).toHaveBeenCalledTimes(1)
  })
})
