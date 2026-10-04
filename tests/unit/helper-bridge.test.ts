import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { HelperEvent } from '@shared/helper-protocol'
import { HelperBridge, PASTE_EXPIRY_MS } from '../../src/main/native/helper-bridge'

const fakeHelper = fileURLToPath(new URL('../fixtures/fake-helper.mjs', import.meta.url))
const bridges: HelperBridge[] = []

/** Starts a bridge that runs the stand-in helper under Node. */
function startBridge(mode?: 'crash' | 'silent' | 'malformed' | 'stubborn'): HelperBridge {
  if (mode) process.env['FAKE_HELPER_MODE'] = mode
  else delete process.env['FAKE_HELPER_MODE']
  const bridge = new HelperBridge(process.execPath, {
    args: [fakeHelper],
    restartDelaysMs: [20],
    exitGraceMs: 150,
  })
  bridges.push(bridge)
  bridge.start()
  return bridge
}

function nextEvent(bridge: HelperBridge, type: HelperEvent['type']): Promise<HelperEvent> {
  return new Promise((resolve) => {
    const onEvent = (event: HelperEvent): void => {
      if (event.type !== type) return
      bridge.off('event', onEvent)
      resolve(event)
    }
    bridge.on('event', onEvent)
  })
}

afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.stop()
  delete process.env['FAKE_HELPER_MODE']
})

describe('HelperBridge', () => {
  it('reports ready and ignores stray output that is not part of the protocol', async () => {
    const bridge = startBridge()

    const ready = await bridge.whenReady()

    expect(ready).toEqual({
      type: 'ready',
      protocol: 3,
      accessibilityTrusted: true,
      tapInstalled: true,
    })
    expect(bridge.running).toBe(true)
  })

  it('matches each reply to its request', async () => {
    const bridge = startBridge()
    await bridge.whenReady()

    const [pong, target, outcome] = await Promise.all([
      bridge.ping(),
      bridge.captureTarget(),
      bridge.paste({ text: 'hello', targetId: 7 }),
    ])

    expect(pong).toEqual({ pong: true })
    expect(target).toMatchObject({ targetId: 7, secure: false, hasElement: true })
    expect(outcome).toEqual({ outcome: 'pasted' })
  })

  it('returns the helper refusal as the paste outcome', async () => {
    const bridge = startBridge()
    await bridge.whenReady()

    expect(await bridge.paste({ text: 'refuse', targetId: 7 })).toEqual({
      outcome: 'targetChanged',
      detail: 'window',
    })
  })

  it('tells the helper when it stops waiting for a paste, and takes "too late" for an answer', async () => {
    const bridge = startBridge()
    await bridge.whenReady()

    const result = await bridge.paste({ text: 'too late', targetId: 7 })

    expect(result.outcome).toBe('expired')
    const allowedMs = Number(result.detail?.replace('allowed:', ''))
    expect(allowedMs).toBeGreaterThan(PASTE_EXPIRY_MS - 1_000)
    expect(allowedMs).toBeLessThanOrEqual(PASTE_EXPIRY_MS)
  })

  it('emits helper events', async () => {
    const bridge = startBridge()
    await bridge.whenReady()
    const settled = nextEvent(bridge, 'pasteSettled')

    await bridge.paste({ text: 'hello', targetId: 7 })

    expect(await settled).toEqual({ type: 'pasteSettled', pasteId: 1, restored: true })
  })

  it('sends the shortcut table once the helper is ready', async () => {
    const bridge = startBridge()
    const configured = nextEvent(bridge, 'tapState')
    bridge.setBindings([{ id: 'ptt', chords: [[63]] }])

    expect(await configured).toMatchObject({ reason: 'configured:1' })
  })

  it('rejects a reply that does not have the expected shape', async () => {
    const bridge = startBridge('malformed')
    await bridge.whenReady()

    await expect(bridge.checkPermissions()).rejects.toThrow()
  })

  it('rejects requests when the helper is not running', async () => {
    const bridge = new HelperBridge(process.execPath, { args: [fakeHelper] })

    await expect(bridge.ping()).rejects.toThrow('helper is not running')
  })

  it('fails pending requests when the helper dies, then restarts it and restores the shortcuts', async () => {
    const bridge = startBridge('crash')
    await bridge.whenReady()
    bridge.setBindings([
      { id: 'ptt', chords: [[63]] },
      { id: 'pasteLast', chords: [[55, 59, 9]] },
    ])
    await nextEvent(bridge, 'tapState')
    const exited = new Promise<number | null>((resolve) => bridge.once('exit', resolve))

    // In crash mode the stand-in exits when asked for permissions.
    await expect(bridge.checkPermissions()).rejects.toThrow('helper exited')
    expect(await exited).toBe(3)
    expect(bridge.running).toBe(false)

    // It comes back on its own, and the shortcut table is sent again.
    const reconfigured = nextEvent(bridge, 'tapState')
    const ready = await bridge.whenReady()
    expect(ready.protocol).toBe(3)
    expect(await reconfigured).toMatchObject({ reason: 'configured:2' })
  })

  it('restart() replaces the helper at once and sends the shortcuts again', async () => {
    const bridge = startBridge()
    bridge.setBindings([{ id: 'ptt', chords: [[63]] }])
    await bridge.whenReady()
    await nextEvent(bridge, 'tapState')
    const exits: Array<number | null> = []
    bridge.on('exit', (code) => exits.push(code))

    const configuredAgain = nextEvent(bridge, 'tapState')
    bridge.restart()

    expect(await configuredAgain).toMatchObject({ reason: 'configured:1' })
    expect(exits).toEqual([0])
    expect(bridge.running).toBe(true)
    await expect(bridge.ping()).resolves.toEqual({ pong: true })
  })

  it('restart() ends a helper that does not leave when its input closes', async () => {
    const bridge = startBridge('stubborn')
    await bridge.whenReady()
    const exited = new Promise<number | null>((resolve) => bridge.once('exit', resolve))
    delete process.env['FAKE_HELPER_MODE']

    bridge.restart()

    // Ended from outside, so there is no exit code; and a fresh one takes its place.
    expect(await exited).toBeNull()
    const ready = await bridge.whenReady()
    expect(ready.protocol).toBe(3)
    await expect(bridge.ping()).resolves.toEqual({ pong: true })
  })

  it('stop() ends a helper that does not leave when its input closes', async () => {
    const bridge = startBridge('stubborn')
    await bridge.whenReady()
    const exited = new Promise<number | null>((resolve) => bridge.once('exit', resolve))

    bridge.stop()

    expect(await exited).toBeNull()
    expect(bridge.running).toBe(false)
  })

  it('restart() does nothing after stop()', async () => {
    const bridge = startBridge()
    await bridge.whenReady()
    const exited = new Promise((resolve) => bridge.once('exit', resolve))
    bridge.stop()
    await exited

    bridge.restart()

    expect(bridge.running).toBe(false)
  })

  it('does not restart after stop()', async () => {
    const bridge = startBridge()
    await bridge.whenReady()
    const exited = new Promise<number | null>((resolve) => bridge.once('exit', resolve))

    bridge.stop()

    expect(await exited).toBe(0)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(bridge.running).toBe(false)
  })
})
