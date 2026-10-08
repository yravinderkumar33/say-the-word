import { describe, expect, it } from 'vitest'
import type { RecoveryEntry } from '../../src/main/dictation/recovery-buffer'
import type { SessionTimings } from '../../src/main/dictation/session-metrics'
import {
  NO_TIMINGS,
  historyEntry,
  historyOutcome,
  historyTimings,
} from '../../src/main/history/from-session'

const recorded = (change: Partial<RecoveryEntry> = {}): RecoveryEntry => ({
  sessionId: 7,
  endedAt: 1_000,
  outcome: 'pasted',
  rawText: 'um hello there',
  finalText: 'Hello there.',
  ...change,
})

describe('a session as the history keeps it', () => {
  it('says how it ended in the History page’s terms', () => {
    const outcome = (change: Partial<RecoveryEntry>) => historyOutcome(recorded(change))

    expect(outcome({ outcome: 'pasted' })).toBe('pasted')
    expect(outcome({ outcome: 'targetChanged' })).toBe('focusMoved')
    expect(outcome({ outcome: 'secureField' })).toBe('passwordField')
    // Only Secure Input says so: it is named as what it is, not as a password field.
    expect(outcome({ outcome: 'secureField', secureInput: true })).toBe('secureInput')
    expect(outcome({ outcome: 'cancelled' })).toBe('cancelled')
    expect(outcome({ outcome: 'cancelled', interrupted: true })).toBe('interrupted')
    expect(outcome({ outcome: 'pasteFailed' })).toBe('notPasted')
    expect(outcome({ outcome: 'noSpeech' })).toBe('noSpeech')
    expect(outcome({ outcome: 'failed' })).toBe('failed')
  })

  it('keeps what was heard and what was written, the app, and how the text was tidied', () => {
    const entry = historyEntry(
      recorded({ appName: 'Notes', cleanupNote: 'unreachable' }),
      'launch-7',
      'verbatim',
    )

    expect(entry).toEqual({
      id: 'launch-7',
      endedAt: 1_000,
      app: 'Notes',
      outcome: 'pasted',
      fetched: null,
      // The note says it went through Cleaned mode, whatever the mode is now.
      mode: 'cleaned',
      note: 'unreachable',
      heard: 'um hello there',
      written: 'Hello there.',
      failure: null,
      audioMs: null,
      timings: NO_TIMINGS,
    })
  })

  it('takes a text without a note for Verbatim, and a session without text for the mode in force', () => {
    expect(historyEntry(recorded(), 'a', 'cleaned').mode).toBe('verbatim')
    const silent = recorded({ outcome: 'noSpeech', rawText: null, finalText: null })
    expect(historyEntry(silent, 'a', 'cleaned')).toMatchObject({
      mode: 'cleaned',
      heard: '',
      written: '',
      app: null,
    })
  })
})

describe('where a dictation’s time went', () => {
  const timings = (change: Partial<SessionTimings> = {}): SessionTimings => ({
    session: 7,
    outcome: 'pasted',
    micLiveMs: 110,
    micOpenMs: 100,
    heldMs: 6_000,
    audioMs: 6_150,
    decodeMs: 380,
    chunks: 1,
    peakDb: -12,
    levelDb: -30,
    releaseToTextMs: 390,
    releaseToPasteMs: 400,
    pasteMs: 30,
    cleanup: null,
    cleanupMs: null,
    ...change,
  })

  it('counts the reading of the destination with the paste', () => {
    expect(historyTimings(timings())).toEqual({
      audioMs: 6_150,
      timings: { releaseToTextMs: 390, tidyMs: null, pasteMs: 40 },
    })
  })

  it('has no time for a paste that was not made', () => {
    const refused = timings({ outcome: 'targetChanged', releaseToPasteMs: null, pasteMs: null })
    expect(historyTimings(refused).timings).toEqual({
      releaseToTextMs: 390,
      tidyMs: null,
      pasteMs: null,
    })
  })

  it('gives the time the tidying took in Cleaned mode', () => {
    expect(historyTimings(timings({ cleanup: 'cleaned', cleanupMs: 840 })).timings.tidyMs).toBe(840)
  })
})
