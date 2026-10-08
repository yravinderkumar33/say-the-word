import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OVERLAY_PREFS, type OverlayPrefs, type PillCue, type PillState } from '@shared/ipc'
import type * as PillStore from '../../src/renderer/overlay/pill-store'

const cues: string[] = []
/** How loud each cue was asked to be. */
const volumes: number[] = []
vi.mock('../../src/renderer/overlay/sounds', () => ({
  playCue: (cue: string, volume: number) => {
    cues.push(cue)
    volumes.push(volume)
  },
}))

type Store = typeof PillStore

/** A fresh store for each test, with a hand on the lines the main process uses. */
async function setup(): Promise<{
  store: Store
  show: (state: PillState) => void
  cue: (cue: PillCue) => void
  prefer: (prefs: Partial<OverlayPrefs>) => void
}> {
  let handle: (state: PillState) => void = () => {}
  let signal: (cue: PillCue) => void = () => {}
  let settings: (prefs: OverlayPrefs) => void = () => {}
  vi.stubGlobal('window', {
    flow: {
      onPillState: (listener: (state: PillState) => void) => (handle = listener),
      onPillCue: (listener: (cue: PillCue) => void) => (signal = listener),
      onPrefs: (listener: (prefs: OverlayPrefs) => void) => (settings = listener),
    },
  })
  vi.resetModules()
  const store = await import('../../src/renderer/overlay/pill-store')
  store.initPillStore()
  return {
    store,
    show: (state) => handle(state),
    cue: (cue) => signal(cue),
    prefer: (prefs) => settings({ ...DEFAULT_OVERLAY_PREFS, ...prefs }),
  }
}

const message = (text: string, sound: boolean): PillState => ({
  kind: 'recovery',
  message: text,
  messageKind: 'plain',
  canCopy: true,
  sound,
})
const resting: PillState = { kind: 'resting', waiting: false }
const starting: PillState = { kind: 'starting', slow: false }
const listening = (handsFree: boolean): PillState => ({
  kind: 'listening',
  handsFree,
  startedAt: 0,
  limitAt: 1_200_000,
})
const processing = (long = false): PillState => ({ kind: 'processing', long, hint: null })

beforeEach(() => {
  cues.length = 0
  volumes.length = 0
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

    show(listening(true))

    expect(store.acceptsClicks()).toBe(false)
    await vi.advanceTimersByTimeAsync(store.CLICK_GUARD_MS)
    expect(store.acceptsClicks()).toBe(true)
  })

  it('starts the wait again when the buttons move: a lock, a new state, another message', async () => {
    const { store, show } = await setup()
    const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(store.CLICK_GUARD_MS)

    show(listening(false))
    await settle()
    show(listening(true))
    expect(store.acceptsClicks()).toBe(false)

    await settle()
    show(processing())
    expect(store.acceptsClicks()).toBe(false)

    await settle()
    // Cancel arrives where there was nothing to click a moment ago.
    show(processing(true))
    expect(store.acceptsClicks()).toBe(false)

    await settle()
    show(message('Cancelled', false))
    await settle()
    show(message('Copied', false))
    expect(store.acceptsClicks()).toBe(false)
  })

  it('starts the wait again when a message loses its Copy button and keeps its words (Sp-F6)', async () => {
    const { store, show } = await setup()
    const failed = (canCopy: boolean): PillState => ({
      kind: 'recovery',
      message: 'The recognizer took too long',
      messageKind: 'problem',
      canCopy,
      sound: true,
      redo: 'Retry',
    })
    show(failed(true))
    await vi.advanceTimersByTimeAsync(store.CLICK_GUARD_MS)

    // The text was fetched with the paste shortcut: Retry moves to where Copy was.
    show(failed(false))

    expect(store.acceptsClicks()).toBe(false)
  })

  it('does not start the wait again when the same thing is shown twice', async () => {
    const { store, show } = await setup()
    show(processing())
    await vi.advanceTimersByTimeAsync(store.CLICK_GUARD_MS)

    show(processing())

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

  it('plays nothing when a wait only grows longer, or the mark for waiting text changes', async () => {
    const { show } = await setup()
    show(starting)
    show({ kind: 'starting', slow: true })
    show(listening(false))
    show(processing())
    cues.length = 0

    show(processing(true))
    show(resting)
    show({ kind: 'resting', waiting: true })

    expect(cues).toEqual([])
  })
})

describe('what the page senses: a press while busy', () => {
  it('says so on the pill for a moment, with the sound', async () => {
    const { store, show, cue } = await setup()
    show(processing())
    cues.length = 0

    cue('busy')

    expect(cues).toEqual(['busy'])
    expect(store.getPillSenses().busy).toBe(true)
    await vi.advanceTimersByTimeAsync(store.BUSY_MS)
    expect(store.getPillSenses().busy).toBe(false)
  })

  it('stops saying so as soon as the dictation is no longer being processed', async () => {
    const { store, show, cue } = await setup()
    show(processing())
    cue('busy')

    show(resting)

    expect(store.getPillSenses().busy).toBe(false)
  })

  it('plays the notice, and shows nothing, a minute before a recording is stopped', async () => {
    const { store, show, cue } = await setup()
    show(listening(true))
    cues.length = 0

    cue('limitSoon')

    expect(cues).toEqual(['notice'])
    expect(store.getPillSenses().busy).toBe(false)
  })
})

describe('what the page senses: a microphone that hears nothing', () => {
  const live = async () => {
    const t = await setup()
    t.show(starting)
    t.show(listening(false))
    return t
  }

  it('is said after three seconds without a sound', async () => {
    const { store } = await live()
    store.setLevel(0)
    // The hiss of a live microphone in a quiet room is a sound: only silence in the
    // signal itself counts.
    expect(store.QUIET_LEVEL).toBeLessThan(0.005)

    await vi.advanceTimersByTimeAsync(store.QUIET_AFTER_MS - 1)
    expect(store.getPillSenses().quiet).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.getPillSenses().quiet).toBe(true)
  })

  it('is not said of a working microphone in a quiet room', async () => {
    const { store } = await live()

    // About -57 dB, which is what nobody speaking sounded like on the development Mac.
    store.setLevel(0.0085)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(store.getPillSenses().quiet).toBe(false)
  })

  it('is never said once something has been heard, however long the pause after it', async () => {
    const { store } = await live()

    store.setLevel(0.4)
    store.setLevel(0)
    await vi.advanceTimersByTimeAsync(60_000)

    expect(store.getPillSenses().quiet).toBe(false)
  })

  it('is taken back the moment something is heard', async () => {
    const { store } = await live()
    await vi.advanceTimersByTimeAsync(store.QUIET_AFTER_MS)
    expect(store.getPillSenses().quiet).toBe(true)

    store.setLevel(store.QUIET_LEVEL)

    expect(store.getPillSenses().quiet).toBe(false)
  })

  it('counts a word spoken before the pill went live', async () => {
    const { store, show } = await setup()
    show(starting)
    // The first frames arrive a moment before the main process says "listening".
    store.setLevel(0.5)
    show(listening(false))

    await vi.advanceTimersByTimeAsync(store.QUIET_AFTER_MS)

    expect(store.getPillSenses().quiet).toBe(false)
  })

  it('starts afresh with each recording, and ends with it', async () => {
    const { store, show } = await live()
    await vi.advanceTimersByTimeAsync(store.QUIET_AFTER_MS)
    show(processing())
    expect(store.getPillSenses().quiet).toBe(false)

    show(resting)
    show(starting)
    show(listening(false))
    await vi.advanceTimersByTimeAsync(store.QUIET_AFTER_MS)

    expect(store.getPillSenses().quiet).toBe(true)
  })

  it('tells its listeners only when something has changed', async () => {
    const { store } = await live()
    let told = 0
    store.subscribeToPill(() => (told += 1))

    store.setLevel(0)
    store.setLevel(store.QUIET_LEVEL / 10)
    store.setMicrophone('MacBook Pro Microphone (Built-in)')
    store.setMicrophone('MacBook Pro Microphone (Built-in)')

    expect(told).toBe(1)
    expect(store.getPillSenses().microphone).toBe('MacBook Pro Microphone (Built-in)')
  })
})

describe('the settings the pill acts on', () => {
  it('plays its cues as loud as the setting says, and not at all when sounds are off', async () => {
    const { show, cue, prefer } = await setup()

    prefer({ volume: 0.8 })
    show(listening(false))
    expect(cues).toEqual(['start'])
    expect(volumes).toEqual([0.8])

    prefer({ sounds: false })
    show(processing())
    show(message('Could not paste', true))
    cue('limitSoon')
    cue('busy')
    expect(cues).toEqual(['start'])
  })

  it('tells whoever draws the pill when a setting changes', async () => {
    const { store, prefer } = await setup()
    let told = 0
    store.subscribeToPill(() => (told += 1))

    prefer({ pillAtRest: false, key: 'ctrlOption', pausedUntil: 1_000 })

    expect(told).toBe(1)
    expect(store.getPillPrefs()).toMatchObject({
      pillAtRest: false,
      key: 'ctrlOption',
      pausedUntil: 1_000,
    })
  })
})
