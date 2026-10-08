import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HelperEvent } from '@shared/helper-protocol'
import { pillMessage } from '../../src/main/dictation/pill-messages'
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
  vi.restoreAllMocks()
})

/** What the pill says for a dictation that failed with this error. */
const onThePill = (error: unknown): string | undefined =>
  pillMessage(
    { kind: 'failed', sessionId: 1, message: error instanceof Error ? error.message : '' },
    () => false,
  )?.message

/** Has the stand-in write this line, as if the helper had sent it of its own accord. */
async function sendFromHelper(bridge: HelperBridge, event: unknown): Promise<void> {
  await bridge['request']('emit', { event })
  // Answered after the line above: by then the bridge has handled it.
  await bridge.ping()
}

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

  it('rejects a reply that does not have the expected shape, in plain words', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = startBridge('malformed')
    await bridge.whenReady()

    const error = await bridge.checkPermissions().catch((reason: unknown) => reason)
    await expect(bridge.checkPermissions()).rejects.toThrow('does not understand')

    expect(error).toEqual(new Error('helper sent a reply this build does not understand'))
    expect(onThePill(error)).toBe('The shortcut helper did not respond')
    // The log names the fields that did not fit, and nothing of what they held, once.
    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0]?.[0])
    expect(line).toContain('accessibilityTrusted')
    expect(line).not.toContain('yes')
  })

  it('names the helper in a refusal it sends, which the pill then puts into plain words', async () => {
    const bridge = startBridge()
    await bridge.whenReady()

    const error = await bridge['request']('nonsense').catch((reason: unknown) => reason)

    expect(error).toEqual(new Error('helper: unknown request type: nonsense'))
    expect(onThePill(error)).toBe('The shortcut helper did not respond')
  })

  it('says once, by field, when a message of a known type does not have its shape', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bridge = startBridge()
    await bridge.whenReady()
    const events: HelperEvent[] = []
    bridge.on('event', (event) => events.push(event))

    await sendFromHelper(bridge, { type: 'bindingDown', id: 4242, t: 1 })
    await sendFromHelper(bridge, { type: 'bindingDown', id: 4242, t: 2 })
    // A type this build does not know may come from a newer helper: dropped unsaid.
    await sendFromHelper(bridge, { type: 'commandMode', id: 'x' })

    expect(events).toEqual([])
    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0]?.[0])
    expect(line).toContain('"bindingDown"')
    expect(line).toContain('id')
    expect(line).not.toContain('4242')
  })

  it('sends no lone half of a surrogate pair, which the helper could not read', async () => {
    const bridge = startBridge()
    await bridge.whenReady()
    const child = bridge['child']!
    const lines: string[] = []
    const write = child.stdin.write.bind(child.stdin)
    vi.spyOn(child.stdin, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk))
      return write(String(chunk))
    })

    const result = await bridge.paste({ text: 'a\uD800b\uD83D\uDE00', targetId: 7 })

    expect(result).toEqual({ outcome: 'pasted' })
    expect(JSON.parse(lines.at(-1) ?? '{}').text).toBe('a\uFFFDb\uD83D\uDE00')
  })

  it('does not act on output from a helper that has already exited', async () => {
    const bridge = startBridge('crash')
    await bridge.whenReady()
    const child = bridge['child']!
    const events: HelperEvent[] = []
    bridge.on('event', (event) => events.push(event))
    // Node can hand over a process's last output after it has reported the exit.
    bridge.once('exit', () => {
      child.stdout.emit('data', '{"type":"bindingDown","id":"ptt","t":1}\n')
    })

    await expect(bridge.checkPermissions()).rejects.toThrow('helper exited')

    expect(events).toEqual([])
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
