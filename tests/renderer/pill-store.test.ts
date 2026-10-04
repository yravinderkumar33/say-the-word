import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PillState } from '@shared/ipc'
import type * as PillStore from '../../src/renderer/overlay/pill-store'

const cues: string[] = []
vi.mock('../../src/renderer/overlay/sounds', () => ({
  playCue: (cue: string) => cues.push(cue),
}))

type Store = typeof PillStore

/** A fresh store for each test, with a hand on the line the main process uses. */
async function setup(): Promise<{ store: Store; show: (state: PillState) => void }> {
  let handle: (state: PillState) => void = () => {}
  vi.stubGlobal('window', {
    flow: {
      onPillState: (listener: (state: PillState) => void) => (handle = listener),
      onPillCue: () => {},
    },
  })
  vi.resetModules()
  const store = await import('../../src/renderer/overlay/pill-store')
  store.initPillStore()
  return { store, show: (state) => handle(state) }
}

const message = (text: string, sound: boolean): PillState => ({
  kind: 'recovery',
  message: text,
  canCopy: true,
  sound,
})

beforeEach(() => {
  cues.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the pill store', () => {
  it('ignores clicks for a moment after the pill changes, then takes them', async () => {
    const { store, show } = await setup()
    expect(store.acceptsClicks()).toBe(true)

    show({ kind: 'listening', handsFree: true })

    expect(store.acceptsClicks()).toBe(false)
    await vi.advanceTimersByTimeAsync(store.CLICK_GUARD_MS)
    expect(store.acceptsClicks()).toBe(true)
  })

  it('starts the wait again when the buttons move: a lock, a new state, another message', async () => {
    const { store, show } = await setup()
    const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(store.CLICK_GUARD_MS)

    show({ kind: 'listening', handsFree: false })
    await settle()
    show({ kind: 'listening', handsFree: true })
    expect(store.acceptsClicks()).toBe(false)

    await settle()
    show({ kind: 'processing' })
    expect(store.acceptsClicks()).toBe(false)

    await settle()
    show(message('Cancelled', false))
    await settle()
    show(message('Copied', false))
    expect(store.acceptsClicks()).toBe(false)
  })

  it('does not start the wait again when the same thing is shown twice', async () => {
    const { store, show } = await setup()
    show({ kind: 'processing' })
    await vi.advanceTimersByTimeAsync(store.CLICK_GUARD_MS)

    show({ kind: 'processing' })

    expect(store.acceptsClicks()).toBe(true)
  })

  it('plays the alert when one message replaces another', async () => {
    const { show } = await setup()
    show(message('Cancelled', false))
    expect(cues).toEqual([])

    show(message('Password field: nothing was pasted', true))

    expect(cues).toEqual(['notice'])
  })

  it('does not repeat the alert for the same message, or play one for a quiet message', async () => {
    const { show } = await setup()
    show(message('Could not paste', true))
    show(message('Could not paste', true))
    show(message('Copied', false))

    expect(cues).toEqual(['notice'])
  })
})
