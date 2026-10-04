import { describe, expect, it } from 'vitest'
import {
  DOUBLE_TAP_WINDOW_MS,
  LOCK_CANCEL_WINDOW_MS,
  TAP_THRESHOLD_MS,
  initialState,
  isRecording,
  transition,
  type MachineEffect,
  type MachineEvent,
  type MachineState,
} from '../../src/main/hotkeys/session-machine'

/** Feeds events in order and returns the final state plus every effect, in order. */
function run(events: MachineEvent[], from: MachineState = initialState) {
  let state = from
  const effects: MachineEffect[] = []
  for (const event of events) {
    const next = transition(state, event)
    state = next.state
    effects.push(...next.effects)
  }
  return { state, effects }
}

const holding: MachineState = { name: 'holding', startedAt: 1_000 }
const processing: MachineState = { name: 'processing' }

describe('push-to-talk', () => {
  it('starts a session when Fn goes down', () => {
    expect(transition(initialState, { type: 'pttDown', t: 1_000 })).toEqual({
      state: { name: 'holding', startedAt: 1_000 },
      effects: [{ type: 'startSession' }],
    })
  })

  it('stops recording and starts processing when Fn is released after a real hold', () => {
    expect(transition(holding, { type: 'pttUp', t: 1_000 + TAP_THRESHOLD_MS })).toEqual({
      state: { name: 'processing' },
      effects: [{ type: 'stopRecording' }],
    })
  })

  it('treats a hold just under the threshold as a tap, and waits to see if a second follows', () => {
    expect(transition(holding, { type: 'pttUp', t: 1_000 + TAP_THRESHOLD_MS - 1 })).toEqual({
      state: { name: 'tapPending', startedAt: 1_000 },
      // The window is counted from when the tap began, so 201 ms of it are left.
      effects: [{ type: 'armTapTimeout', ms: DOUBLE_TAP_WINDOW_MS - (TAP_THRESHOLD_MS - 1) }],
    })
  })

  it('forgets a lone tap without a trace when the window closes', () => {
    const result = run([
      { type: 'pttDown', t: 0 },
      { type: 'pttUp', t: 120 },
      { type: 'tapTimeout' },
    ])

    expect(result.state).toEqual({ name: 'idle' })
    expect(result.effects.at(-1)).toEqual({
      type: 'cancelSession',
      reason: 'quickTap',
      silent: true,
    })
  })

  it('cancels silently when another key is pressed during the hold', () => {
    expect(transition(holding, { type: 'interrupted' })).toEqual({
      state: { name: 'idle' },
      effects: [{ type: 'cancelSession', reason: 'interrupted', silent: true }],
    })
  })

  it('ignores the Fn release that follows an interruption', () => {
    const result = run([
      { type: 'pttDown', t: 0 },
      { type: 'interrupted' },
      { type: 'pttUp', t: 5_000 },
    ])

    expect(result.state).toEqual({ name: 'idle' })
    expect(result.effects.map((effect) => effect.type)).toEqual(['startSession', 'cancelSession'])
  })

  it('stops recording when the length limit is reached', () => {
    expect(transition(holding, { type: 'limitReached' })).toEqual({
      state: { name: 'processing' },
      effects: [{ type: 'stopRecording' }],
    })
  })

  it('returns to idle if the session ends while still recording', () => {
    expect(transition(holding, { type: 'sessionEnded' })).toEqual({
      state: { name: 'idle' },
      effects: [],
    })
  })
})

describe('cancel', () => {
  it.each([
    ['holding', holding],
    ['processing', processing],
  ])('Escape while %s cancels into Recovery', (_name, state) => {
    expect(transition(state, { type: 'escape' })).toEqual({
      state: { name: 'idle' },
      effects: [{ type: 'cancelSession', reason: 'escape', silent: false }],
    })
  })

  it('Escape while idle does nothing', () => {
    expect(transition(initialState, { type: 'escape' })).toEqual({
      state: initialState,
      effects: [],
    })
  })
})

describe('processing', () => {
  it('ignores a new Fn press and shows a cue', () => {
    expect(transition(processing, { type: 'pttDown', t: 9_000 })).toEqual({
      state: processing,
      effects: [{ type: 'cueStillProcessing' }],
    })
  })

  it('ignores the Fn release that follows an ignored press', () => {
    expect(transition(processing, { type: 'pttUp', t: 9_500 })).toEqual({
      state: processing,
      effects: [],
    })
  })

  it('returns to idle when the session ends', () => {
    expect(transition(processing, { type: 'sessionEnded' })).toEqual({
      state: { name: 'idle' },
      effects: [],
    })
  })

  it('paste-last cancels the session in progress and pastes the previous transcript', () => {
    expect(transition(processing, { type: 'pasteLast' })).toEqual({
      state: { name: 'idle' },
      effects: [
        { type: 'cancelSession', reason: 'superseded', silent: false },
        { type: 'pasteLast' },
      ],
    })
  })

  it('copy-last works without disturbing the session in progress', () => {
    expect(transition(processing, { type: 'copyLast' })).toEqual({
      state: processing,
      effects: [{ type: 'copyLast' }],
    })
  })
})

describe('paste-last and copy-last while idle', () => {
  it.each(['pasteLast', 'copyLast'] as const)('%s runs immediately', (type) => {
    expect(transition(initialState, { type })).toEqual({
      state: initialState,
      effects: [{ type }],
    })
  })
})

describe('whole gestures', () => {
  it('a full dictation: press, hold, release, finish', () => {
    const result = run([
      { type: 'pttDown', t: 0 },
      { type: 'pttUp', t: 2_000 },
      { type: 'sessionEnded' },
    ])

    expect(result.state).toEqual({ name: 'idle' })
    expect(result.effects).toEqual([{ type: 'startSession' }, { type: 'stopRecording' }])
  })

  it('a second press during processing never starts a second session', () => {
    const result = run([
      { type: 'pttDown', t: 0 },
      { type: 'pttUp', t: 2_000 },
      { type: 'pttDown', t: 2_100 },
      { type: 'pttUp', t: 4_000 },
      { type: 'sessionEnded' },
    ])

    expect(result.effects.filter((effect) => effect.type === 'startSession')).toHaveLength(1)
    expect(result.effects.filter((effect) => effect.type === 'stopRecording')).toHaveLength(1)
  })
})

describe('hands-free', () => {
  const kinds = (effects: MachineEffect[]): string[] => effects.map((effect) => effect.type)
  const locked: MachineState = { name: 'locked', lockedAt: 10_000 }
  const doubleTap: MachineEvent[] = [
    { type: 'pttDown', t: 0 },
    { type: 'pttUp', t: 120 },
    { type: 'pttDown', t: 300 },
    { type: 'pttUp', t: 420 },
  ]

  it('a double tap locks the recording on, as one session', () => {
    const result = run(doubleTap)

    expect(result.state).toEqual({ name: 'locked', lockedAt: 300 })
    expect(kinds(result.effects)).toEqual(['startSession', 'armTapTimeout'])
  })

  it('a second press after the window is a new push-to-talk, not a double tap', () => {
    const result = run([
      { type: 'pttDown', t: 0 },
      { type: 'pttUp', t: 120 },
      { type: 'pttDown', t: DOUBLE_TAP_WINDOW_MS + 1 },
    ])

    expect(result.state).toEqual({ name: 'holding', startedAt: DOUBLE_TAP_WINDOW_MS + 1 })
    expect(result.effects.slice(-2)).toEqual([
      { type: 'cancelSession', reason: 'quickTap', silent: true },
      { type: 'startSession' },
    ])
  })

  it('Space while the key is held locks the recording on, and the key can be let go', () => {
    const result = run([
      { type: 'pttDown', t: 0 },
      { type: 'handsFreeDown', t: 400 },
      { type: 'pttUp', t: 900 },
    ])

    expect(result.state).toEqual({ name: 'locked', lockedAt: 400 })
    expect(kinds(result.effects)).toEqual(['startSession'])
  })

  it('the hands-free shortcut or a click on the pill starts a locked recording from rest', () => {
    expect(transition(initialState, { type: 'handsFreeDown', t: 50 })).toEqual({
      state: { name: 'locked', lockedAt: 50 },
      effects: [{ type: 'startSession' }],
    })
  })

  it.each<MachineEvent>([
    { type: 'pttDown', t: 20_000 },
    { type: 'handsFreeDown', t: 20_000 },
    { type: 'stop' },
    { type: 'limitReached' },
  ])('$type stops a locked recording and starts processing', (event) => {
    expect(transition(locked, event)).toEqual({
      state: { name: 'processing' },
      effects: [{ type: 'stopRecording' }],
    })
  })

  it('a lock started by a click on the pill is stopped by the next press, however soon', () => {
    // A click carries no key time, so it is dated before every key event: the "third
    // tap means never mind" rule is about taps, not clicks.
    const result = run([
      { type: 'handsFreeDown', t: Number.NEGATIVE_INFINITY },
      { type: 'pttDown', t: 5 },
    ])

    expect(result.state).toEqual({ name: 'processing' })
    expect(result.effects).toEqual([{ type: 'startSession' }, { type: 'stopRecording' }])
  })

  it('a third tap right after locking cancels instead', () => {
    const result = run([...doubleTap, { type: 'pttDown', t: 300 + LOCK_CANCEL_WINDOW_MS - 1 }])

    expect(result.state).toEqual({ name: 'idle' })
    expect(result.effects.at(-1)).toEqual({
      type: 'cancelSession',
      reason: 'tripleTap',
      silent: false,
    })
  })

  it('but a press once the window has passed stops and keeps the text', () => {
    const result = run([...doubleTap, { type: 'pttDown', t: 300 + LOCK_CANCEL_WINDOW_MS }])

    expect(result.state).toEqual({ name: 'processing' })
  })

  it('the stop button stops even right after locking', () => {
    expect(transition({ name: 'locked', lockedAt: 0 }, { type: 'stop' }).state).toEqual({
      name: 'processing',
    })
  })

  it('typing, and the release of the key that locked it, change nothing', () => {
    for (const event of [{ type: 'interrupted' }, { type: 'pttUp', t: 10_500 }] as MachineEvent[]) {
      expect(transition(locked, event)).toEqual({ state: locked, effects: [] })
    }
  })

  it('Escape cancels a locked recording; an interruption keeps its text', () => {
    expect(transition(locked, { type: 'escape' }).effects).toEqual([
      { type: 'cancelSession', reason: 'escape', silent: false },
    ])
    expect(transition(locked, { type: 'abort' }).effects).toEqual([
      { type: 'cancelSession', reason: 'aborted', silent: false },
    ])
  })

  it('Escape or an interruption during the double-tap window leaves no trace', () => {
    const pending: MachineState = { name: 'tapPending', startedAt: 0 }
    for (const event of [{ type: 'escape' }, { type: 'abort' }] as MachineEvent[]) {
      expect(transition(pending, event)).toEqual({
        state: { name: 'idle' },
        effects: [{ type: 'cancelSession', reason: 'quickTap', silent: true }],
      })
    }
  })

  it('knows which states have the microphone open', () => {
    expect(
      ['idle', 'holding', 'tapPending', 'locked', 'processing'].filter((name) =>
        isRecording(name as MachineState['name']),
      ),
    ).toEqual(['holding', 'tapPending', 'locked'])
  })
})
