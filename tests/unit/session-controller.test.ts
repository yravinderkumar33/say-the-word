import { describe, expect, it } from 'vitest'
import type { PasteOutcome, PasteResult } from '@shared/helper-protocol'
import {
  RecordingGoneError,
  SessionController,
  type Notice,
  type ProducedText,
  type SessionHandle,
  type TargetInfo,
} from '../../src/main/dictation/session-controller'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets every pending promise callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const text = (value: string): ProducedText => ({ raw: `raw ${value}`, final: value })

function setup() {
  const productions: Array<{ session: SessionHandle; result: Deferred<ProducedText | null> }> = []
  const pastes: Array<{ text: string; targetId: number }> = []
  /** The session each destination was read for, and each paste was sent for, in order. */
  const targetsFor: Array<number | null> = []
  const pastesFor: Array<number | null> = []
  const notices: Notice[] = []
  const armed: boolean[] = []
  const started: number[] = []
  const clipboard: string[] = []
  const options = {
    target: (): Promise<TargetInfo> =>
      Promise.resolve({ targetId: 100 + pastes.length, secure: false }),
    /** An outcome alone, or with the helper's detail. */
    paste: (): Promise<PasteOutcome | PasteResult> => Promise.resolve('pasted'),
  }
  let clock = 0
  /** Timers the controller has set and not cleared. `elapse` runs them. */
  const timers: Array<{ run: () => void; ms: number }> = []
  const elapse = (): void => {
    for (const timer of timers.splice(0)) timer.run()
  }

  const controller = new SessionController({
    startRecording: (session) => started.push(session.id),
    produceText: (session) => {
      const result = deferred<ProducedText | null>()
      productions.push({ session, result })
      return result.promise
    },
    captureTarget: (sessionId) => {
      targetsFor.push(sessionId)
      return options.target()
    },
    paste: async ({ text, targetId, sessionId }) => {
      pastes.push({ text, targetId })
      pastesFor.push(sessionId)
      const result = await options.paste()
      return typeof result === 'string' ? { outcome: result } : result
    },
    armEscape: (value) => armed.push(value),
    writeClipboard: (value) => {
      clipboard.push(value)
      return Promise.resolve()
    },
    notify: (notice) => notices.push(notice),
    now: () => clock,
    setTimer: (run, ms) => {
      const timer = { run, ms }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as { run: () => void; ms: number })
      if (index !== -1) timers.splice(index, 1)
    },
  })

  /** Presses and releases Fn with a hold long enough to count as dictation. */
  const dictate = async (): Promise<void> => {
    controller.dispatch({ type: 'pttDown', t: clock })
    clock += 1_000
    controller.dispatch({ type: 'pttUp', t: clock })
    await settle()
  }

  return {
    controller,
    productions,
    pastes,
    targetsFor,
    pastesFor,
    notices,
    armed,
    started,
    clipboard,
    options,
    dictate,
    timers,
    elapse,
  }
}

describe('a normal dictation', () => {
  it('pastes the produced text into the destination captured at release', async () => {
    const t = setup()
    await t.dictate()
    expect(t.controller.stateName).toBe('processing')

    t.productions[0]!.result.resolve(text('Hello there.'))
    await settle()

    expect(t.pastes).toEqual([{ text: 'Hello there.', targetId: 100 }])
    expect(t.controller.stateName).toBe('idle')
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      sessionId: 1,
      outcome: 'pasted',
      rawText: 'raw Hello there.',
      finalText: 'Hello there.',
    })
  })

  it('gives each session its own id', async () => {
    const t = setup()
    await t.dictate()
    t.productions[0]!.result.resolve(text('one'))
    await settle()
    await t.dictate()

    expect(t.started).toEqual([1, 2])
    expect(t.productions.map((item) => item.session.id)).toEqual([1, 2])
  })

  it('arms Escape only while a session is active', async () => {
    const t = setup()
    await t.dictate()
    t.productions[0]!.result.resolve(text('done'))
    await settle()

    expect(t.armed).toEqual([true, false])
  })
})

describe('a quick tap', () => {
  it('keeps recording for the double-tap window, then leaves no trace', async () => {
    const t = setup()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'pttUp', t: 120 })
    expect(t.controller.stateName).toBe('tapPending')
    expect(t.timers.map((timer) => timer.ms)).toEqual([380])

    t.elapse()
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.productions).toEqual([])
    expect(t.notices).toEqual([])
    expect(t.controller.recovery.list()).toEqual([])
    expect(t.controller.stateName).toBe('idle')
    expect(t.armed).toEqual([true, false])
  })
})

describe('hands-free', () => {
  /** Two quick taps, as the helper reports them. */
  const doubleTap = (t: ReturnType<typeof setup>): void => {
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'pttUp', t: 100 })
    t.controller.dispatch({ type: 'pttDown', t: 250 })
    t.controller.dispatch({ type: 'pttUp', t: 350 })
  }

  it('a double tap locks one session on, and a later tap stops it and pastes', async () => {
    const t = setup()
    doubleTap(t)

    expect(t.controller.stateName).toBe('locked')
    expect(t.started).toEqual([1])
    // The double-tap timer is gone: it must not cancel the recording it led to.
    expect(t.timers).toEqual([])

    t.controller.dispatch({ type: 'pttDown', t: 30_000 })
    await settle()
    t.productions[0]!.result.resolve(text('said hands-free'))
    await settle()

    expect(t.pastes.map((paste) => paste.text)).toEqual(['said hands-free'])
    expect(t.controller.stateName).toBe('idle')
  })

  it('a third tap right after locking cancels, with a message', async () => {
    const t = setup()
    doubleTap(t)

    t.controller.dispatch({ type: 'pttDown', t: 500 })
    await settle()

    expect(t.productions).toEqual([])
    expect(t.notices).toEqual([{ kind: 'cancelled', sessionId: 1, reason: 'tripleTap' }])
    expect(t.controller.stateName).toBe('idle')
  })

  it('Space while the key is held locks it on; the release that follows does not stop it', async () => {
    const t = setup()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'handsFreeDown', t: 600 })
    t.controller.dispatch({ type: 'pttUp', t: 900 })
    await settle()

    expect(t.controller.stateName).toBe('locked')
    expect(t.productions).toEqual([])

    t.controller.dispatch({ type: 'stop' })
    await settle()
    expect(t.controller.stateName).toBe('processing')
    expect(t.productions).toHaveLength(1)
  })

  it('a microphone failure or the length limit ends a locked recording too', async () => {
    const failed = setup()
    failed.controller.dispatch({ type: 'handsFreeDown', t: 0 })
    failed.controller.failRecording(1, 'The microphone could not be opened')
    expect(failed.controller.stateName).toBe('idle')
    expect(failed.notices).toMatchObject([{ kind: 'failed' }])

    const limited = setup()
    limited.controller.dispatch({ type: 'handsFreeDown', t: 0 })
    limited.controller.endRecording(1)
    await settle()
    expect(limited.controller.stateName).toBe('processing')
  })
})

describe('cancel', () => {
  it('never pastes a result that arrives after Escape, and keeps the text for recovery', async () => {
    const t = setup()
    await t.dictate()

    t.controller.dispatch({ type: 'escape' })
    t.productions[0]!.result.resolve(text('too late'))
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.controller.stateName).toBe('idle')
    expect(t.notices).toEqual([{ kind: 'cancelled', sessionId: 1, reason: 'escape' }])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      sessionId: 1,
      outcome: 'cancelled',
      finalText: 'too late',
    })
  })

  it('aborts the session signal so in-flight work can stop', async () => {
    const t = setup()
    await t.dictate()
    const { session } = t.productions[0]!

    t.controller.dispatch({ type: 'escape' })

    expect(session.signal.aborted).toBe(true)
  })

  it('cancels during recording without producing text', async () => {
    const t = setup()
    t.controller.dispatch({ type: 'pttDown', t: 0 })

    t.controller.dispatch({ type: 'escape' })
    t.controller.dispatch({ type: 'pttUp', t: 2_000 })
    await settle()

    expect(t.productions).toEqual([])
    expect(t.pastes).toEqual([])
    expect(t.controller.recovery.list()).toMatchObject([{ sessionId: 1, outcome: 'cancelled' }])
  })

  it('does not report a failure when a cancelled session errors afterwards', async () => {
    const t = setup()
    await t.dictate()

    t.controller.dispatch({ type: 'escape' })
    t.productions[0]!.result.reject(new Error('aborted'))
    await settle()

    expect(t.notices.map((notice) => notice.kind)).toEqual(['cancelled'])
  })
})

describe('an interruption from outside (helper lost, key state lost, sleep)', () => {
  it('during processing: never pastes, and keeps the text for recovery', async () => {
    const t = setup()
    await t.dictate()
    const { session } = t.productions[0]!

    t.controller.dispatch({ type: 'abort' })
    expect(t.controller.stateName).toBe('idle')
    // The work goes on, so that what was said is not lost.
    expect(session.signal.aborted).toBe(false)

    t.productions[0]!.result.resolve(text('never pasted'))
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'interrupted', sessionId: 1, hasText: true }])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      sessionId: 1,
      outcome: 'cancelled',
      finalText: 'never pasted',
    })
    expect(t.controller.hasText(1)).toBe(true)
  })

  it('during recording: stops the recording and keeps what was said', async () => {
    const t = setup()
    t.controller.dispatch({ type: 'pttDown', t: 0 })

    t.controller.dispatch({ type: 'abort' })
    expect(t.productions).toHaveLength(1)
    t.productions[0]!.result.resolve(text('said before the interruption'))
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'interrupted', sessionId: 1, hasText: true }])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      finalText: 'said before the interruption',
    })
  })

  it('produces the text once, even when the interruption comes mid-processing', async () => {
    const t = setup()
    const target = deferred<TargetInfo>()
    t.options.target = () => target.promise
    await t.dictate()

    t.controller.dispatch({ type: 'abort' })
    target.resolve({ targetId: 7, secure: false })
    t.productions[0]!.result.resolve(text('once'))
    await settle()

    expect(t.productions).toHaveLength(1)
    expect(t.pastes).toEqual([])
  })

  it('says so when nothing could be recovered', async () => {
    const t = setup()
    await t.dictate()

    t.controller.dispatch({ type: 'abort' })
    t.productions[0]!.result.reject(new Error('speech worker crashed'))
    await settle()

    expect(t.notices).toEqual([{ kind: 'interrupted', sessionId: 1, hasText: false }])
    expect(t.controller.recovery.list()).toMatchObject([{ sessionId: 1, outcome: 'cancelled' }])
    expect(t.controller.hasText(1)).toBe(false)
  })

  it('gives way to a new recording, without a message on the new session', async () => {
    const t = setup()
    await t.dictate()
    const { session } = t.productions[0]!
    t.controller.dispatch({ type: 'abort' })

    t.controller.dispatch({ type: 'pttDown', t: 60_000 })
    expect(session.signal.aborted).toBe(true)
    t.productions[0]!.result.reject(new Error('cancelled'))
    await settle()

    expect(t.notices).toEqual([])
    expect(t.controller.stateName).toBe('holding')
    expect(t.started).toEqual([1, 2])
  })
})

describe('stale results', () => {
  it('drops a result from an old session and pastes only the current one', async () => {
    const t = setup()
    await t.dictate()
    t.controller.dispatch({ type: 'escape' })
    await t.dictate()

    t.productions[0]!.result.resolve(text('from session one'))
    await settle()
    expect(t.pastes).toEqual([])
    expect(t.controller.stateName).toBe('processing')

    t.productions[1]!.result.resolve(text('from session two'))
    await settle()
    expect(t.pastes.map((paste) => paste.text)).toEqual(['from session two'])
  })

  it('does not paste if the session was cancelled while the destination was being captured', async () => {
    const t = setup()
    const target = deferred<TargetInfo>()
    t.options.target = () => target.promise
    await t.dictate()

    t.controller.dispatch({ type: 'escape' })
    target.resolve({ targetId: 7, secure: false })
    t.productions[0]!.result.resolve(text('cancelled before the destination was known'))
    await settle()

    expect(t.pastes).toEqual([])
  })
})

describe('at release', () => {
  it('stops the recording and captures the destination at the same moment', async () => {
    const t = setup()
    const target = deferred<TargetInfo>()
    t.options.target = () => target.promise

    await t.dictate()

    // The recording is already being turned into text while the destination is read.
    expect(t.productions).toHaveLength(1)
    t.productions[0]!.result.resolve(text('ready before the destination'))
    await settle()
    expect(t.pastes).toEqual([])

    target.resolve({ targetId: 42, secure: false })
    await settle()
    expect(t.pastes).toEqual([{ text: 'ready before the destination', targetId: 42 }])
  })

  it('keeps the text when the destination could not be captured', async () => {
    const t = setup()
    t.options.target = () => Promise.reject(new Error('helper did not answer'))
    await t.dictate()
    t.productions[0]!.result.resolve(text('still recoverable'))
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'failed', sessionId: 1, message: 'helper did not answer' }])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      outcome: 'failed',
      finalText: 'still recoverable',
    })
    expect(t.controller.stateName).toBe('idle')
  })
})

describe('the point of no return', () => {
  it('ignores a cancel that arrives after the paste was sent', async () => {
    const t = setup()
    const paste = deferred<PasteOutcome>()
    t.options.paste = () => paste.promise
    await t.dictate()
    t.productions[0]!.result.resolve(text('already on its way'))
    await settle()
    expect(t.pastes).toHaveLength(1)

    t.controller.dispatch({ type: 'escape' })
    paste.resolve('pasted')
    await settle()

    expect(t.notices).toEqual([])
    expect(t.controller.recovery.lastWithText()).toMatchObject({ sessionId: 1, outcome: 'pasted' })
    expect(t.controller.stateName).toBe('idle')
  })

  it('a paste that finishes late does not disturb a new recording', async () => {
    const t = setup()
    const paste = deferred<PasteOutcome>()
    t.options.paste = () => paste.promise
    await t.dictate()
    t.productions[0]!.result.resolve(text('first'))
    await settle()
    t.controller.dispatch({ type: 'escape' })

    t.controller.dispatch({ type: 'pttDown', t: 50_000 })
    paste.resolve('pasted')
    await settle()

    expect(t.controller.stateName).toBe('holding')
    expect(t.started).toEqual([1, 2])
  })
})

describe('when the paste does not happen', () => {
  it.each(['targetChanged', 'secureField'] as const)(
    'reports %s, keeps the text, and does not retry',
    async (outcome) => {
      const t = setup()
      t.options.paste = () => Promise.resolve(outcome)
      await t.dictate()
      t.productions[0]!.result.resolve(text('kept for later'))
      await settle()

      expect(t.pastes).toHaveLength(1)
      expect(t.notices).toEqual([{ kind: outcome, sessionId: 1 }])
      expect(t.controller.recovery.lastWithText()).toMatchObject({
        outcome,
        finalText: 'kept for later',
      })
      expect(t.controller.stateName).toBe('idle')
    },
  )

  it('never sends a paste when a password field was focused at release', async () => {
    const t = setup()
    t.options.target = () => Promise.resolve({ targetId: 1, secure: true })
    await t.dictate()
    t.productions[0]!.result.resolve(text('not for a password field'))
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'secureField', sessionId: 1 }])
  })

  it('says so when Secure Input is all that marks the field', async () => {
    const t = setup()
    t.options.target = () =>
      Promise.resolve({ targetId: 1, secure: true, secureReason: 'secureInput' })
    await t.dictate()
    t.productions[0]!.result.resolve(text('kept for copying'))
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'secureField', sessionId: 1, because: 'secureInput' }])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      outcome: 'secureField',
      finalText: 'kept for copying',
    })
  })

  it('says Secure Input when that is why the helper itself refused the paste', async () => {
    const t = setup()
    // The field was not secure at release; the helper's own look before pasting found it so.
    t.options.paste = () => Promise.resolve({ outcome: 'secureField', detail: 'secureInput' })
    await t.dictate()
    t.productions[0]!.result.resolve(text('kept for copying'))
    await settle()

    expect(t.notices).toEqual([{ kind: 'secureField', sessionId: 1, because: 'secureInput' }])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      outcome: 'secureField',
      secureInput: true,
    })
  })

  it('reports no speech and pastes nothing', async () => {
    const t = setup()
    await t.dictate()
    t.productions[0]!.result.resolve(null)
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'noSpeech', sessionId: 1 }])
    expect(t.controller.stateName).toBe('idle')
  })

  it('reports a failure and returns to idle when producing the text fails', async () => {
    const t = setup()
    await t.dictate()
    t.productions[0]!.result.reject(new Error('speech worker crashed'))
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'failed', sessionId: 1, message: 'speech worker crashed' }])
    expect(t.controller.recovery.list()).toMatchObject([{ sessionId: 1, outcome: 'failed' }])
    expect(t.controller.stateName).toBe('idle')
  })

  it('treats missing permission to post keys as a failed paste', async () => {
    const t = setup()
    t.options.paste = () => Promise.resolve('noPostAccess')
    await t.dictate()
    t.productions[0]!.result.resolve(text('kept'))
    await settle()

    expect(t.notices).toEqual([{ kind: 'pasteFailed', sessionId: 1 }])
    expect(t.controller.recovery.lastWithText()).toMatchObject({ outcome: 'pasteFailed' })
  })

  it('treats a paste the helper was too late for as a failed paste, with the text kept', async () => {
    const t = setup()
    t.options.paste = () => Promise.resolve('expired')
    await t.dictate()
    t.productions[0]!.result.resolve(text('kept'))
    await settle()

    expect(t.notices).toEqual([{ kind: 'pasteFailed', sessionId: 1 }])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      outcome: 'pasteFailed',
      finalText: 'kept',
    })
    expect(t.controller.stateName).toBe('idle')
  })
})

describe('pressing the shortcut during processing', () => {
  it('shows a cue and starts nothing', async () => {
    const t = setup()
    await t.dictate()

    t.controller.dispatch({ type: 'pttDown', t: 9_000 })
    t.controller.dispatch({ type: 'pttUp', t: 12_000 })
    await settle()

    expect(t.started).toEqual([1])
    expect(t.notices).toEqual([{ kind: 'stillProcessing' }])
    expect(t.controller.stateName).toBe('processing')
  })
})

describe('paste-last and copy-last', () => {
  async function withOneTranscript() {
    const t = setup()
    await t.dictate()
    t.productions[0]!.result.resolve(text('the previous transcript'))
    await settle()
    t.pastes.length = 0
    return t
  }

  it('paste-last pastes the previous text into a freshly captured destination', async () => {
    const t = await withOneTranscript()
    t.options.target = () => Promise.resolve({ targetId: 555, secure: false })

    t.controller.dispatch({ type: 'pasteLast' })
    await settle()

    expect(t.pastes).toEqual([{ text: 'the previous transcript', targetId: 555 }])
  })

  it('paste-last says so when there is nothing to paste', async () => {
    const t = setup()

    t.controller.dispatch({ type: 'pasteLast' })
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'nothingToPaste' }])
  })

  it('paste-last refuses a password field', async () => {
    const t = await withOneTranscript()
    t.options.target = () => Promise.resolve({ targetId: 9, secure: true })

    t.controller.dispatch({ type: 'pasteLast' })
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'secureField', sessionId: 1 }])
  })

  it('paste-last says so when Secure Input is all that marks the field', async () => {
    const t = await withOneTranscript()
    t.options.target = () =>
      Promise.resolve({ targetId: 9, secure: true, secureReason: 'secureInput' })

    t.controller.dispatch({ type: 'pasteLast' })
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([{ kind: 'secureField', sessionId: 1, because: 'secureInput' }])
  })

  it('paste-last says Secure Input when that is why the helper itself refused the paste', async () => {
    const t = await withOneTranscript()
    t.options.paste = () => Promise.resolve({ outcome: 'secureField', detail: 'secureInput' })

    t.controller.dispatch({ type: 'pasteLast' })
    await settle()

    expect(t.notices).toEqual([{ kind: 'secureField', sessionId: 1, because: 'secureInput' }])
  })

  it('paste-last during processing cancels that session and pastes the previous text', async () => {
    const t = await withOneTranscript()
    await t.dictate()

    t.controller.dispatch({ type: 'pasteLast' })
    t.productions[1]!.result.resolve(text('the cancelled one'))
    await settle()

    expect(t.pastes.map((paste) => paste.text)).toEqual(['the previous transcript'])
    expect(t.controller.stateName).toBe('idle')
  })

  it('copy-last puts the previous text on the clipboard', async () => {
    const t = await withOneTranscript()

    t.controller.dispatch({ type: 'copyLast' })
    await settle()

    expect(t.clipboard).toEqual(['the previous transcript'])
    expect(t.notices).toEqual([{ kind: 'copied' }])
    expect(t.pastes).toEqual([])
  })

  it('names the session whose text those two would fetch: the last one that left any', async () => {
    const t = setup()
    expect(t.controller.lastTextSession).toBeNull()

    await t.dictate()
    t.productions[0]!.result.resolve(text('the first'))
    await settle()
    expect(t.controller.lastTextSession).toBe(1)

    // A dictation that leaves nothing does not take its place.
    await t.dictate()
    t.productions[1]!.result.resolve(null)
    await settle()
    expect(t.controller.lastTextSession).toBe(1)
  })
})

describe('which session a destination and a paste are for', () => {
  it('names the session for its own, and none for paste-last', async () => {
    const t = setup()
    await t.dictate()
    t.productions[0]!.result.resolve(text('the first'))
    await settle()

    t.controller.dispatch({ type: 'pasteLast' })
    await settle()

    expect(t.targetsFor).toEqual([1, null])
    expect(t.pastesFor).toEqual([1, null])
  })

  it('does not give paste-last to a dictation begun while its destination was read', async () => {
    const t = setup()
    await t.dictate()
    t.productions[0]!.result.resolve(text('the first'))
    await settle()
    const target = deferred<TargetInfo>()
    t.options.target = () => target.promise

    t.controller.dispatch({ type: 'pasteLast' })
    // The dictation key, while paste-last is still reading where the cursor is.
    t.controller.dispatch({ type: 'pttDown', t: 50_000 })
    target.resolve({ targetId: 7, secure: false })
    await settle()

    expect(t.controller.currentSessionId).toBe(2)
    expect(t.pastesFor).toEqual([1, null])
  })
})

describe('the end of a session, for the figures kept of it', () => {
  /** Notes each time a session is over, and what its record said at that moment. */
  function setupWithEnds() {
    const t = setup()
    const ends: Array<{ sessionId: number; outcome: string | null; text: boolean }> = []
    const deps = (t.controller as unknown as { deps: Record<string, unknown> }).deps
    deps['onSessionOver'] = (sessionId: number) => {
      const entry = t.controller.recovery.list().find((item) => item.sessionId === sessionId)
      ends.push({ sessionId, outcome: entry?.outcome ?? null, text: Boolean(entry?.finalText) })
    }
    return { ...t, ends }
  }

  it('comes after the record of a paste', async () => {
    const t = setupWithEnds()
    await t.dictate()
    t.productions[0]!.result.resolve(text('pasted'))
    await settle()

    expect(t.ends).toEqual([{ sessionId: 1, outcome: 'pasted', text: true }])
  })

  it('comes with the paste when Escape was pressed while it was on its way', async () => {
    const t = setupWithEnds()
    const paste = deferred<PasteOutcome>()
    t.options.paste = () => paste.promise
    await t.dictate()
    t.productions[0]!.result.resolve(text('already on its way'))
    await settle()

    t.controller.dispatch({ type: 'escape' })
    // The gesture is over; the session is not.
    expect(t.controller.stateName).toBe('idle')
    expect(t.ends).toEqual([])
    paste.resolve('pasted')
    await settle()

    expect(t.ends).toEqual([{ sessionId: 1, outcome: 'pasted', text: true }])
  })

  it('comes for an interrupted session once its text has been worked out', async () => {
    const t = setupWithEnds()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'abort' })
    expect(t.controller.stateName).toBe('idle')
    expect(t.ends).toEqual([])

    t.productions[0]!.result.resolve(text('kept for recovery'))
    await settle()

    expect(t.ends).toEqual([{ sessionId: 1, outcome: 'cancelled', text: true }])
  })

  it('comes for a recording that failed and for a cancel with a message, not for a tap', async () => {
    const t = setupWithEnds()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.failRecording(1, 'No microphone was found')
    t.controller.dispatch({ type: 'pttDown', t: 10_000 })
    t.controller.dispatch({ type: 'escape' })
    t.controller.dispatch({ type: 'pttDown', t: 20_000 })
    t.controller.dispatch({ type: 'pttUp', t: 20_100 })
    t.elapse()
    await settle()

    expect(t.ends).toEqual([
      { sessionId: 1, outcome: 'failed', text: false },
      { sessionId: 2, outcome: 'cancelled', text: false },
    ])
  })
})

describe('recordings that end on their own', () => {
  it('fails the session when the recording cannot start, and pastes nothing', async () => {
    const t = setup()
    t.controller.dispatch({ type: 'pttDown', t: 0 })

    t.controller.failRecording(1, 'The microphone could not be opened')
    t.controller.dispatch({ type: 'pttUp', t: 3_000 })
    await settle()

    expect(t.controller.stateName).toBe('idle')
    expect(t.productions).toEqual([])
    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([
      { kind: 'failed', sessionId: 1, message: 'The microphone could not be opened' },
    ])
    expect(t.controller.recovery.list()).toMatchObject([{ sessionId: 1, outcome: 'failed' }])
  })

  it('a recording that breaks just after the release ends the session at once', async () => {
    const t = setup()
    await t.dictate()

    // The microphone failed while the recording was being wound up: no text will come.
    t.controller.failRecording(1, 'The microphone is in use or could not be opened')
    await settle()

    expect(t.controller.stateName).toBe('idle')
    expect(t.pastes).toEqual([])
    expect(t.notices).toEqual([
      {
        kind: 'failed',
        sessionId: 1,
        message: 'The microphone is in use or could not be opened',
      },
    ])
  })

  it('ignores a failure report for another session, or once the paste has been sent', async () => {
    const t = setup()
    await t.dictate()

    t.controller.failRecording(99, 'unknown session')
    expect(t.controller.stateName).toBe('processing')

    t.productions[0]!.result.resolve(text('already on its way'))
    await settle()
    t.controller.failRecording(1, 'too late')

    expect(t.pastes.map((paste) => paste.text)).toEqual(['already on its way'])
    expect(t.notices).toEqual([])
  })

  it('processes what was captured when the recording ends by itself', async () => {
    const t = setup()
    t.controller.dispatch({ type: 'pttDown', t: 0 })

    t.controller.endRecording(1)
    await settle()
    t.productions[0]!.result.resolve(text('captured before the microphone went away'))
    await settle()

    expect(t.pastes.map((paste) => paste.text)).toEqual([
      'captured before the microphone went away',
    ])
  })

  it('ignores the key release that follows a recording that already ended', async () => {
    const t = setup()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.endRecording(1)
    await settle()

    t.controller.dispatch({ type: 'pttUp', t: 9_000 })
    await settle()

    expect(t.productions).toHaveLength(1)
  })
})

describe('Undo and Retry', () => {
  /** A controller that can turn a held recording into text again. */
  function setupWithRedo() {
    const t = setup()
    const redone: Array<{ session: SessionHandle; result: Deferred<ProducedText | null> }> = []
    const forgotten: number[] = []
    const deps = (t.controller as unknown as { deps: Record<string, unknown> }).deps
    deps['reproduceText'] = (session: SessionHandle) => {
      const result = deferred<ProducedText | null>()
      redone.push({ session, result })
      return result.promise
    }
    deps['forgetRecording'] = (sessionId: number) => forgotten.push(sessionId)
    return { ...t, redone, forgotten }
  }

  it('offers Undo after Escape, and pastes the recording after all', async () => {
    const t = setupWithRedo()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'escape' })
    expect(t.notices).toEqual([
      { kind: 'cancelled', sessionId: 1, reason: 'escape', canUndo: true },
    ])

    t.controller.redo()
    expect(t.controller.stateName).toBe('processing')
    expect(t.redone.map((item) => item.session.id)).toEqual([1])
    // A fresh signal: the one the cancel aborted would stop the work at once.
    expect(t.redone[0]!.session.signal.aborted).toBe(false)

    t.redone[0]!.result.resolve(text('said before the cancel'))
    await settle()

    expect(t.pastes.map((paste) => paste.text)).toEqual(['said before the cancel'])
    expect(t.controller.recovery.lastWithText()).toMatchObject({ sessionId: 1, outcome: 'pasted' })
    expect(t.controller.stateName).toBe('idle')
  })

  it('offers Retry when the decode failed, and not when the microphone did', async () => {
    const t = setupWithRedo()
    await t.dictate()
    t.productions[0]!.result.reject(new Error('The recognizer took too long'))
    await settle()
    expect(t.notices).toEqual([
      { kind: 'failed', sessionId: 1, message: 'The recognizer took too long', canRetry: true },
    ])

    t.controller.redo()
    t.redone[0]!.result.resolve(text('second time lucky'))
    await settle()
    expect(t.pastes.map((paste) => paste.text)).toEqual(['second time lucky'])

    t.controller.dispatch({ type: 'pttDown', t: 90_000 })
    t.controller.failRecording(2, 'No microphone was found')
    expect(t.notices.at(-1)).toEqual({
      kind: 'failed',
      sessionId: 2,
      message: 'No microphone was found',
    })
  })

  it('offers neither for a quick tap, an interruption or a superseded session', async () => {
    const t = setupWithRedo()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'interrupted' })
    t.controller.redo()

    expect(t.redone).toEqual([])
    // What cannot be brought back is let go of at once.
    expect(t.forgotten).toEqual([1])
  })

  it('lets the recording go when the offer lapses, or when a new session starts', async () => {
    const lapsed = setupWithRedo()
    lapsed.controller.dispatch({ type: 'pttDown', t: 0 })
    lapsed.controller.dispatch({ type: 'escape' })
    lapsed.controller.forgetRedo()
    lapsed.controller.redo()
    expect(lapsed.forgotten).toEqual([1])
    expect(lapsed.redone).toEqual([])

    const replaced = setupWithRedo()
    replaced.controller.dispatch({ type: 'pttDown', t: 0 })
    replaced.controller.dispatch({ type: 'escape' })
    replaced.controller.dispatch({ type: 'pttDown', t: 5_000 })
    expect(replaced.forgotten).toEqual([1])
    replaced.controller.redo()
    expect(replaced.redone).toEqual([])
  })

  it('does nothing while another session is active, and only works once', async () => {
    const t = setupWithRedo()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'escape' })
    t.controller.redo()
    t.controller.redo()

    expect(t.redone).toHaveLength(1)
  })

  it('can itself be cancelled, and undone again', async () => {
    const t = setupWithRedo()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'escape' })
    t.controller.redo()

    t.controller.dispatch({ type: 'escape' })
    t.redone[0]!.result.reject(new Error('cancelled'))
    await settle()
    expect(t.pastes).toEqual([])
    expect(t.notices.at(-1)).toMatchObject({ kind: 'cancelled', canUndo: true })

    t.controller.redo()
    t.redone[1]!.result.resolve(text('third time'))
    await settle()
    expect(t.pastes.map((paste) => paste.text)).toEqual(['third time'])
  })

  it('stops offering Retry once the recording is gone', async () => {
    const t = setupWithRedo()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'escape' })
    t.controller.redo()
    t.redone[0]!.result.reject(new RecordingGoneError())
    await settle()

    expect(t.notices.at(-1)).toEqual({
      kind: 'failed',
      sessionId: 1,
      message: 'The recording is no longer held',
    })
  })

  it('still has the recording when the cancel came after the text was heard', async () => {
    const t = setupWithRedo()
    await t.dictate()
    // Recognition is done and the text is being cleaned when Escape arrives.
    t.controller.dispatch({ type: 'escape' })
    expect(t.notices).toEqual([
      { kind: 'cancelled', sessionId: 1, reason: 'escape', canUndo: true },
    ])
    expect(t.forgotten).toEqual([])
    t.productions[0]!.result.resolve(text('heard before the cancel'))
    await settle()
    expect(t.pastes).toEqual([])
    expect(t.forgotten).toEqual([])

    t.controller.redo()
    t.redone[0]!.result.resolve(text('Heard before the cancel.'))
    await settle()

    expect(t.pastes.map((paste) => paste.text)).toEqual(['Heard before the cancel.'])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      sessionId: 1,
      outcome: 'pasted',
      finalText: 'Heard before the cancel.',
    })
    expect(t.forgotten).toEqual([1])
  })

  it('keeps the text already recovered when the Undo itself fails', async () => {
    const t = setupWithRedo()
    await t.dictate()
    t.controller.dispatch({ type: 'escape' })
    t.productions[0]!.result.resolve(text('heard before the cancel'))
    await settle()

    t.controller.redo()
    t.redone[0]!.result.reject(new RecordingGoneError())
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.controller.hasText(1)).toBe(true)
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      sessionId: 1,
      outcome: 'failed',
      rawText: 'raw heard before the cancel',
      finalText: 'heard before the cancel',
    })
    expect(t.notices.at(-1)).toEqual({
      kind: 'failed',
      sessionId: 1,
      message: 'The recording is no longer held',
    })
  })

  it('keeps the text already recovered when the Undo is cancelled in turn', async () => {
    const t = setupWithRedo()
    await t.dictate()
    t.controller.dispatch({ type: 'escape' })
    t.productions[0]!.result.resolve(text('heard before the cancel'))
    await settle()

    t.controller.redo()
    t.controller.dispatch({ type: 'escape' })
    t.redone[0]!.result.reject(new Error('cancelled'))
    await settle()

    expect(t.controller.recovery.lastWithText()).toMatchObject({
      sessionId: 1,
      outcome: 'cancelled',
      finalText: 'heard before the cancel',
    })
  })

  it('says the text is kept when an Undo that left none of its own is interrupted', async () => {
    const t = setupWithRedo()
    await t.dictate()
    t.controller.dispatch({ type: 'escape' })
    t.productions[0]!.result.resolve(text('heard before the cancel'))
    await settle()

    t.controller.redo()
    // The Mac sleeps during the Undo, whose own attempt then leaves nothing.
    t.controller.dispatch({ type: 'abort' })
    t.redone[0]!.result.resolve(null)
    await settle()

    expect(t.notices.at(-1)).toEqual({ kind: 'interrupted', sessionId: 1, hasText: true })
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      sessionId: 1,
      outcome: 'cancelled',
      interrupted: true,
      finalText: 'heard before the cancel',
    })
  })

  it('does not let text from the cancelled attempt replace what the Undo pasted', async () => {
    const t = setupWithRedo()
    await t.dictate()
    t.controller.dispatch({ type: 'escape' })

    t.controller.redo()
    t.redone[0]!.result.resolve(text('the newer text'))
    await settle()
    // Only now does the attempt that was cancelled finish working out its text.
    t.productions[0]!.result.resolve(text('the older text'))
    await settle()

    expect(t.pastes.map((paste) => paste.text)).toEqual(['the newer text'])
    expect(t.controller.recovery.lastWithText()).toMatchObject({
      outcome: 'pasted',
      finalText: 'the newer text',
    })
  })

  it('holds the recording until the session is over, and then lets it go', async () => {
    const pasted = setupWithRedo()
    await pasted.dictate()
    expect(pasted.forgotten).toEqual([])
    pasted.productions[0]!.result.resolve(text('done'))
    await settle()
    expect(pasted.forgotten).toEqual([1])

    const silent = setupWithRedo()
    await silent.dictate()
    silent.productions[0]!.result.resolve(null)
    await settle()
    expect(silent.forgotten).toEqual([1])

    const refused = setupWithRedo()
    refused.options.paste = () => Promise.resolve('targetChanged')
    await refused.dictate()
    refused.productions[0]!.result.resolve(text('kept for copying'))
    await settle()
    expect(refused.forgotten).toEqual([1])
  })

  it('holds the recording for Retry, and lets it go when Retry is no longer offered', async () => {
    const t = setupWithRedo()
    await t.dictate()
    t.productions[0]!.result.reject(new Error('The recognizer took too long'))
    await settle()
    expect(t.forgotten).toEqual([])

    t.controller.forgetRedo()

    expect(t.forgotten).toEqual([1])
  })

  it('lets the recording go when the session is interrupted or cannot record', async () => {
    const interrupted = setupWithRedo()
    interrupted.controller.dispatch({ type: 'pttDown', t: 0 })
    interrupted.controller.dispatch({ type: 'abort' })
    expect(interrupted.forgotten).toEqual([])
    interrupted.productions[0]!.result.resolve(text('kept for recovery'))
    await settle()
    expect(interrupted.forgotten).toEqual([1])

    const noMicrophone = setupWithRedo()
    noMicrophone.controller.dispatch({ type: 'pttDown', t: 0 })
    noMicrophone.controller.failRecording(1, 'No microphone was found')
    expect(noMicrophone.forgotten).toEqual([1])
  })

  it('lets the recording go when Escape arrives after the paste was sent', async () => {
    const t = setupWithRedo()
    const pasting = deferred<PasteOutcome>()
    t.options.paste = () => pasting.promise
    await t.dictate()
    t.productions[0]!.result.resolve(text('already on its way'))
    await settle()

    t.controller.dispatch({ type: 'escape' })
    pasting.resolve('pasted')
    await settle()

    expect(t.forgotten).toEqual([1])
    expect(t.controller.recovery.lastWithText()).toMatchObject({ outcome: 'pasted' })
  })

  it('refuses a password field like any other paste', async () => {
    const t = setupWithRedo()
    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'escape' })
    t.options.target = () => Promise.resolve({ targetId: 3, secure: true })

    t.controller.redo()
    t.redone[0]!.result.resolve(text('not for a password field'))
    await settle()

    expect(t.pastes).toEqual([])
    expect(t.notices.at(-1)).toEqual({ kind: 'secureField', sessionId: 1 })
  })
})

describe('Delete Everything discard (QA-05)', () => {
  it('rejects delayed transcription and clears Undo/Retry without salvage', async () => {
    const t = setup()
    await t.dictate()
    const generation = t.controller.privacyGeneration
    await t.controller.discardAll()
    t.productions[0]!.result.resolve(text('synthetic'))
    await settle()
    expect(t.pastes.length).toBe(0)
    expect(t.controller.recovery.list().length).toBe(0)
    expect(t.controller.privacyGeneration).toBeGreaterThan(generation)
    t.controller.dispatch({ type: 'pttDown', t: 2000 })
    expect(t.controller.stateName).toBe('idle')
    t.controller.resumeAfterDiscard()
    await t.dictate()
    expect(t.controller.stateName).toBe('processing')
  })
  it('a second deletion under way keeps dictation off after the first is over', async () => {
    const t = setup()
    await t.controller.discardAll()
    await t.controller.discardAll()
    // The first one finishes: the second is still deleting.
    t.controller.resumeAfterDiscard()
    expect(t.controller.privacyBlocked).toBe(true)
    t.controller.dispatch({ type: 'pttDown', t: 2000 })
    expect(t.controller.stateName).toBe('idle')
    t.controller.resumeAfterDiscard()
    expect(t.controller.privacyBlocked).toBe(false)
    // Ended more often than begun: still not below nothing.
    t.controller.resumeAfterDiscard()
    await t.dictate()
    expect(t.controller.stateName).toBe('processing')
  })
  it('rejects Paste Last whose destination lookup finishes after deletion', async () => {
    const t = setup()
    await t.dictate()
    t.productions[0]!.result.resolve(text('synthetic'))
    await settle()
    const target = deferred<TargetInfo>()
    t.options.target = () => target.promise
    const paste = t.controller['pasteLast']()
    await settle()
    await t.controller.discardAll()
    target.resolve({ targetId: 900, secure: false })
    await paste
    expect(t.pastes.length).toBe(1)
    expect(t.controller.recovery.list().length).toBe(0)
  })
  it('waits for an already submitted paste callback and ignores its result', async () => {
    const t = setup()
    const pasted = deferred<PasteOutcome>()
    t.options.paste = () => pasted.promise
    await t.dictate()
    t.productions[0]!.result.resolve(text('synthetic'))
    await settle()
    let finished = false
    const discard = t.controller.discardAll().then(() => {
      finished = true
    })
    await settle()
    expect(finished).toBe(false)
    pasted.resolve('pasted')
    await discard
    await settle()
    expect(t.controller.recovery.list().length).toBe(0)
    expect(t.controller.stateName).toBe('idle')
  })
})
