import { describe, expect, it } from 'vitest'
import type { PillRecovery, PillState } from '@shared/ipc'
import { PillPresenter } from '../../src/main/dictation/pill-presenter'

function setup() {
  const sent: PillState[] = []
  const timers: Array<{ run: () => void; at: number; cleared: boolean }> = []
  let now = 1_000_000
  let gone = 0
  const presenter = new PillPresenter((state) => sent.push(state), {
    recoveryMs: 6_000,
    confirmMs: 2_000,
    slowMs: 1_000,
    maxHoldMs: 60_000,
    now: () => now,
    onRecoveryGone: () => (gone += 1),
    setTimer: (run, ms) => {
      const timer = { run, at: now + ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })
  /** Lets time pass, running the timers that fall due on the way, in order. */
  const advance = (ms: number): void => {
    const until = now + ms
    for (;;) {
      const due = timers
        .filter((timer) => !timer.cleared && timer.at <= until)
        .sort((a, b) => a.at - b.at)[0]
      if (!due) break
      now = due.at
      due.cleared = true
      due.run()
    }
    now = until
  }
  const pending = (): number => timers.filter((timer) => !timer.cleared).length
  return { presenter, sent, advance, pending, gone: () => gone }
}

const kinds = (states: PillState[]): string[] => states.map((state) => state.kind)
const plain = (message: string): PillRecovery => ({
  message,
  messageKind: 'plain',
  canCopy: false,
  sound: false,
})
const confirm = (message: string): PillRecovery => ({ ...plain(message), messageKind: 'confirm' })
const kept: PillRecovery = {
  message: 'Focus moved, so nothing was pasted',
  messageKind: 'protected',
  canCopy: true,
  sound: true,
}
const CLOCK = { startedAt: 5_000, limitAt: 1_205_000 }

describe('PillPresenter', () => {
  it('shows starting, not listening, until audio is flowing', () => {
    const t = setup()

    t.presenter.setGesture('holding')
    expect(kinds(t.sent)).toEqual(['starting'])

    t.presenter.setLive()
    expect(kinds(t.sent)).toEqual(['starting', 'listening'])
  })

  it('follows a whole dictation: starting, listening, processing, resting', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('processing')
    t.presenter.setGesture('idle')

    expect(kinds(t.sent)).toEqual(['starting', 'listening', 'processing', 'resting'])
  })

  it('does not carry "audio is flowing" over to the next session', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('idle')

    t.presenter.setGesture('holding')

    expect(t.sent.at(-1)).toEqual({ kind: 'starting', slow: false })
  })

  it('ignores a late "audio is flowing" once the recording is over', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setGesture('processing')

    t.presenter.setLive()

    expect(t.sent.at(-1)).toEqual({ kind: 'processing', long: false, hint: null })
  })

  it('shows a recovery message once the session is over, then returns to rest', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setGesture('processing')
    t.presenter.showRecovery(kept)
    t.presenter.setGesture('idle')

    expect(t.sent.at(-1)).toEqual({ kind: 'recovery', ...kept })

    t.advance(6_000)
    expect(t.sent.at(-1)?.kind).toBe('resting')
  })

  it('drops an old recovery message when a new session starts', () => {
    const t = setup()
    t.presenter.showRecovery(plain('Cancelled'))

    t.presenter.setGesture('holding')
    t.advance(500)

    expect(kinds(t.sent)).toEqual(['recovery', 'starting'])
  })

  it('can be dismissed by the user', () => {
    const t = setup()
    t.presenter.showRecovery(plain('Cancelled'))

    t.presenter.dismissRecovery()

    expect(kinds(t.sent)).toEqual(['recovery', 'resting'])
  })

  it('replaces one recovery message with the next and restarts its timer', () => {
    const t = setup()
    t.presenter.showRecovery(plain('Cancelled'))
    t.presenter.showRecovery(plain('No speech heard'))

    expect(t.pending()).toBe(1)
    expect(t.sent.at(-1)).toEqual({ kind: 'recovery', ...plain('No speech heard') })
  })

  it('sends nothing when the state has not changed', () => {
    const t = setup()
    t.presenter.setGesture('idle')
    t.presenter.setGesture('idle')
    t.presenter.dismissRecovery()

    expect(t.sent).toEqual([{ kind: 'resting', waiting: false }])
  })

  it('keeps listening through a tap and into hands-free, then offers Stop and Cancel', () => {
    const t = setup()
    t.presenter.setRecording(CLOCK)
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('tapPending')
    t.presenter.setGesture('locked')

    expect(t.sent).toEqual([
      { kind: 'starting', slow: false },
      { kind: 'listening', handsFree: false, ...CLOCK },
      { kind: 'listening', handsFree: true, ...CLOCK },
    ])
  })

  it('does not carry "audio is flowing" into a session that follows a tap with no pause', () => {
    const t = setup()
    t.presenter.setRecording(CLOCK)
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('tapPending')

    // A press just too late to be a double tap: the tap's session ends, the next begins.
    t.presenter.setRecording({ startedAt: 6_000, limitAt: 1_206_000 })
    t.presenter.setGesture('holding')

    expect(t.sent.at(-1)).toEqual({ kind: 'starting', slow: false })
    t.advance(1_000)
    expect(t.sent.at(-1)).toEqual({ kind: 'starting', slow: true })
  })

  it('shows starting for a hands-free recording until audio is flowing', () => {
    const t = setup()
    t.presenter.setRecording(CLOCK)
    t.presenter.setGesture('locked')
    expect(t.sent.at(-1)).toEqual({ kind: 'starting', slow: false })

    t.presenter.setLive()
    expect(t.sent.at(-1)).toEqual({ kind: 'listening', handsFree: true, ...CLOCK })
  })

  it('says when a message has gone, by time or by hand, but not when one replaces another', () => {
    const t = setup()
    t.presenter.showRecovery(plain('Cancelled'))
    t.presenter.showRecovery(plain('No speech heard'))
    expect(t.gone()).toBe(0)

    t.advance(6_000)
    expect(t.gone()).toBe(1)

    t.presenter.showRecovery(plain('Cancelled'))
    t.presenter.dismissRecovery()
    expect(t.gone()).toBe(2)
  })
})

describe('a wait that lasts', () => {
  it('says in words that the microphone is slow, once it has been a second', () => {
    const t = setup()
    t.presenter.setGesture('holding')

    t.advance(999)
    expect(t.sent.at(-1)).toEqual({ kind: 'starting', slow: false })
    t.advance(1)
    expect(t.sent.at(-1)).toEqual({ kind: 'starting', slow: true })
  })

  it('says nothing about a microphone that opened in time', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.advance(120)
    t.presenter.setLive()

    t.advance(5_000)

    expect(t.sent.some((state) => state.kind === 'starting' && state.slow)).toBe(false)
    expect(kinds(t.sent)).toEqual(['starting', 'listening'])
  })

  it('does not call the next recording slow because the last one was', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.advance(1_500)
    t.presenter.setGesture('idle')

    t.presenter.setGesture('holding')

    expect(t.sent.at(-1)).toEqual({ kind: 'starting', slow: false })
  })

  it('offers Cancel only once the text has taken a second', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('processing')
    expect(t.sent.at(-1)).toEqual({ kind: 'processing', long: false, hint: null })

    t.advance(1_000)

    expect(t.sent.at(-1)).toEqual({ kind: 'processing', long: true, hint: null })
  })

  it('leaves no Cancel behind for a text that arrived at once', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setGesture('processing')
    t.advance(400)
    t.presenter.setGesture('idle')

    t.advance(5_000)

    expect(t.sent.some((state) => state.kind === 'processing' && state.long)).toBe(false)
  })

  it('says the text is being tidied, from the start, in Cleaned mode', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setTidying(true)
    t.presenter.setGesture('processing')

    expect(t.sent.at(-1)).toEqual({ kind: 'processing', long: false, hint: 'tidying' })
  })

  it('says the model is loading when that is what a long wait is for', () => {
    const t = setup()
    t.presenter.setModelLoading(true)
    t.presenter.setGesture('holding')
    t.presenter.setTidying(true)
    t.presenter.setGesture('processing')
    // Not at once: a model that loads in a moment is not worth words.
    expect(t.sent.at(-1)).toMatchObject({ hint: 'tidying' })

    t.advance(1_000)
    expect(t.sent.at(-1)).toEqual({ kind: 'processing', long: true, hint: 'loadingModel' })

    t.presenter.setModelLoading(false)
    expect(t.sent.at(-1)).toEqual({ kind: 'processing', long: true, hint: 'tidying' })
  })
})

describe('how long a message stays', () => {
  it('is two seconds for a confirmation, which has nothing to press', () => {
    const t = setup()
    t.presenter.showRecovery(confirm('Copied'))

    t.advance(1_999)
    expect(t.sent.at(-1)?.kind).toBe('recovery')
    t.advance(1)
    expect(t.sent.at(-1)?.kind).toBe('resting')
  })

  it('stands still while the pointer is on the pill, and goes on from where it was', () => {
    const t = setup()
    t.presenter.showRecovery(plain('Cancelled'))
    t.advance(4_000)

    t.presenter.setPointerOver(true)
    t.advance(30_000)
    expect(t.sent.at(-1)?.kind).toBe('recovery')
    expect(t.gone()).toBe(0)

    t.presenter.setPointerOver(false)
    t.advance(1_999)
    expect(t.sent.at(-1)?.kind).toBe('recovery')
    t.advance(1)
    expect(t.sent.at(-1)?.kind).toBe('resting')
    expect(t.gone()).toBe(1)
  })

  it('waits for the pointer to leave when the message appears under it', () => {
    const t = setup()
    t.presenter.setPointerOver(true)
    t.presenter.showRecovery(plain('Cancelled'))

    t.advance(20_000)
    expect(t.sent.at(-1)?.kind).toBe('recovery')

    // The whole of its time is still to come.
    t.presenter.setPointerOver(false)
    t.advance(5_999)
    expect(t.sent.at(-1)?.kind).toBe('recovery')
    t.advance(1)
    expect(t.sent.at(-1)?.kind).toBe('resting')
  })

  it('does not wait for ever under a pointer that never leaves', () => {
    const t = setup()
    t.presenter.showRecovery({ ...plain('Cancelled'), redo: 'Undo' })
    t.presenter.setPointerOver(true)

    t.advance(60_000)

    expect(t.sent.at(-1)?.kind).toBe('resting')
    // The recording kept for Undo is let go with the message.
    expect(t.gone()).toBe(1)
  })

  it('gives a message that replaces a held one its own time under the same pointer', () => {
    const t = setup()
    t.presenter.showRecovery(kept)
    t.presenter.setPointerOver(true)
    t.presenter.showRecovery(confirm('Copied'))

    // The page reports the pointer gone once the pill has nothing left to click.
    t.presenter.setPointerOver(false)
    t.advance(1_999)
    expect(t.sent.at(-1)?.kind).toBe('recovery')
    t.advance(1)

    expect(t.sent.at(-1)?.kind).toBe('resting')
  })

  it('is counted from when the message is shown, not from when it was said', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    // The recording stopped itself, and its text takes a long time to arrive.
    t.presenter.setGesture('processing')
    t.presenter.showRecovery({ ...plain('Stopped at the 20-minute limit'), sound: true })
    t.advance(30_000)
    expect(t.sent.at(-1)?.kind).toBe('processing')
    expect(t.gone()).toBe(0)

    t.presenter.setGesture('idle')
    expect(t.sent.at(-1)).toMatchObject({ kind: 'recovery', sound: true })

    t.advance(5_999)
    expect(t.sent.at(-1)?.kind).toBe('recovery')
    t.advance(1)
    expect(t.sent.at(-1)?.kind).toBe('resting')
    expect(t.gone()).toBe(1)
  })

  it('does not hold a message that is not on show yet for a pointer that came and went', () => {
    const t = setup()
    t.presenter.setGesture('processing')
    t.presenter.showRecovery(confirm('Copied'))
    t.presenter.setPointerOver(true)
    t.presenter.setPointerOver(false)

    t.presenter.setGesture('idle')
    t.advance(2_000)

    expect(t.sent.at(-1)?.kind).toBe('resting')
  })
})

describe('the mark for text that was not pasted', () => {
  const afterMessage = (recovery: PillRecovery) => {
    const t = setup()
    t.presenter.showRecovery(recovery)
    t.advance(6_000)
    return t
  }

  it('stays on the resting pill once a message that offered the text has gone', () => {
    expect(afterMessage(kept).sent.at(-1)).toEqual({ kind: 'resting', waiting: true })
  })

  it('is left by a dismissed message as well as by one that timed out', () => {
    const t = setup()
    t.presenter.showRecovery(kept)

    t.presenter.dismissRecovery()

    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: true })
  })

  it('is not left by a message with no text behind it', () => {
    expect(afterMessage(plain('No speech heard')).sent.at(-1)).toEqual({
      kind: 'resting',
      waiting: false,
    })
  })

  it('goes when the text is copied or pasted', () => {
    const t = afterMessage(kept)

    t.presenter.textTaken()

    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: false })
  })

  it('is not left by a message whose text was pasted while it was still showing', () => {
    const t = setup()
    t.presenter.showRecovery(kept)
    t.advance(2_000)

    // Paste-last, while "Focus moved, so nothing was pasted" is on the pill.
    t.presenter.textTaken()

    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: false })
    expect(t.gone()).toBe(1)
    t.advance(60_000)
    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: false })
  })

  it('leaves an offer to try again standing when only the text beside it is fetched', () => {
    const t = setup()
    const failed: PillRecovery = {
      message: 'The recognizer took too long',
      messageKind: 'problem',
      canCopy: true,
      sound: true,
      redo: 'Retry',
    }
    t.presenter.showRecovery(failed)

    t.presenter.textTaken()

    expect(t.sent.at(-1)).toEqual({ kind: 'recovery', ...failed, canCopy: false })
    // The recording kept for Retry is still held.
    expect(t.gone()).toBe(0)
    t.advance(6_000)
    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: false })
    expect(t.gone()).toBe(1)
  })

  it('stays through a press of the key that turns out to be no dictation', () => {
    const t = afterMessage(kept)

    // A lone tap, or Fn with an arrow key: recording starts and is dropped without a trace.
    t.presenter.setGesture('holding')
    t.presenter.setGesture('idle')

    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: true })
  })

  it('takes the place of a message that such a press swept away', () => {
    const t = setup()
    t.presenter.showRecovery(kept)

    t.presenter.setGesture('holding')
    t.presenter.setGesture('idle')

    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: true })
  })

  it('takes the place of a message that another message put aside', () => {
    const t = setup()
    t.presenter.showRecovery(kept)

    // An older dictation is copied from the History page while the message is showing:
    // "Copied" takes its place, and the text the message offered has not been fetched.
    t.presenter.showRecovery(confirm('Copied'))
    t.advance(2_000)

    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: true })
  })

  it('does not appear when the text was fetched before the next message came', () => {
    const t = setup()
    t.presenter.showRecovery(kept)

    // The text itself is copied: said first, then "Copied" is shown.
    t.presenter.textTaken()
    t.presenter.showRecovery(confirm('Copied'))
    t.advance(2_000)

    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: false })
  })

  it('goes when the dictation that follows is pasted', () => {
    const t = afterMessage(kept)
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('processing')

    // Its paste went through: the newest text is where it was meant to be.
    t.presenter.textTaken()
    t.presenter.setGesture('idle')

    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: false })
  })

  it('goes with the Copy button, and is not there after the "Copied" that follows', () => {
    const t = setup()
    t.presenter.showRecovery(kept)

    // Copy on the message: the text is taken, and the pill says so.
    t.presenter.textTaken()
    t.presenter.showRecovery(confirm('Copied'))
    expect(t.sent.at(-1)).toMatchObject({ kind: 'recovery', message: 'Copied' })

    t.advance(2_000)
    expect(t.sent.at(-1)).toEqual({ kind: 'resting', waiting: false })
  })
})
