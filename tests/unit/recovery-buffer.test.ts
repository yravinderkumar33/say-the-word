import { describe, expect, it } from 'vitest'
import { RecoveryBuffer, type RecoveryEntry } from '../../src/main/dictation/recovery-buffer'

function entry(sessionId: number, overrides: Partial<RecoveryEntry> = {}): RecoveryEntry {
  return {
    sessionId,
    endedAt: sessionId * 1_000,
    outcome: 'pasted',
    rawText: `raw ${sessionId}`,
    finalText: `final ${sessionId}`,
    ...overrides,
  }
}

describe('RecoveryBuffer', () => {
  it('returns nothing before any session has produced text', () => {
    const buffer = new RecoveryBuffer()

    expect(buffer.lastWithText()).toBeNull()
    expect(buffer.list()).toEqual([])
  })

  it('returns the most recent session that produced text', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1))
    buffer.record(entry(2))

    expect(buffer.lastWithText()?.finalText).toBe('final 2')
  })

  it('skips sessions that produced no text', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1))
    buffer.record(entry(2, { outcome: 'cancelled', rawText: null, finalText: null }))
    buffer.record(entry(3, { outcome: 'noSpeech', rawText: '', finalText: '' }))

    expect(buffer.lastWithText()?.sessionId).toBe(1)
  })

  it('keeps the text of a session that did not end in a paste', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1, { outcome: 'targetChanged' }))

    expect(buffer.lastWithText()).toMatchObject({ outcome: 'targetChanged', finalText: 'final 1' })
  })

  it('replaces the entry when the same session is recorded again', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1, { outcome: 'cancelled', rawText: null, finalText: null }))
    buffer.record(entry(1, { outcome: 'cancelled' }))

    expect(buffer.list()).toHaveLength(1)
    expect(buffer.lastWithText()?.finalText).toBe('final 1')
  })

  it('keeps the text of an earlier attempt when a later one ends with none', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1, { outcome: 'cancelled', cleanupNote: 'rules' }))
    buffer.record(entry(1, { outcome: 'failed', endedAt: 9_000, rawText: null, finalText: null }))

    expect(buffer.list()).toEqual([
      {
        sessionId: 1,
        endedAt: 9_000,
        outcome: 'failed',
        rawText: 'raw 1',
        finalText: 'final 1',
        cleanupNote: 'rules',
      },
    ])
  })

  it('takes everything but the text from a later attempt that ends with none', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1, { outcome: 'cancelled', cleanupNote: 'rules' }))

    // An Undo that the Mac interrupted, and that left no text of its own.
    const none = { rawText: null, finalText: null }
    buffer.record(entry(1, { ...none, endedAt: 9_000, outcome: 'cancelled', interrupted: true }))
    expect(buffer.list()[0]).toMatchObject({ interrupted: true, finalText: 'final 1' })

    // A Retry that read where its text was to go, and then failed.
    buffer.record(entry(1, { ...none, endedAt: 10_000, outcome: 'failed', appName: 'Mail' }))
    expect(buffer.list()).toEqual([
      {
        sessionId: 1,
        endedAt: 10_000,
        outcome: 'failed',
        rawText: 'raw 1',
        finalText: 'final 1',
        cleanupNote: 'rules',
        appName: 'Mail',
      },
    ])
  })

  it('takes the text of a later attempt over that of an earlier one', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1, { outcome: 'cancelled' }))
    buffer.record(entry(1, { outcome: 'pasted', rawText: 'raw again', finalText: 'final again' }))

    expect(buffer.lastWithText()).toMatchObject({ outcome: 'pasted', finalText: 'final again' })
  })

  it('fills in text that arrives late, for a session that has none', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1, { outcome: 'cancelled', rawText: null, finalText: null }))

    buffer.fill(1, { rawText: 'raw late', finalText: 'final late' })

    expect(buffer.lastWithText()).toMatchObject({
      sessionId: 1,
      outcome: 'cancelled',
      rawText: 'raw late',
      finalText: 'final late',
    })
  })

  it('does not let late text replace text the session already has, or invent a session', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1))

    buffer.fill(1, { rawText: 'raw late', finalText: 'final late' })
    buffer.fill(2, { rawText: 'raw late', finalText: 'final late' })

    expect(buffer.list()).toHaveLength(1)
    expect(buffer.lastWithText()?.finalText).toBe('final 1')
  })

  it('drops the oldest session once it is full', () => {
    const buffer = new RecoveryBuffer(3)
    for (const id of [1, 2, 3, 4]) buffer.record(entry(id))

    expect(buffer.list().map((item) => item.sessionId)).toEqual([4, 3, 2])
  })

  it('lists newest first', () => {
    const buffer = new RecoveryBuffer()
    buffer.record(entry(1))
    buffer.record(entry(2))

    expect(buffer.list().map((item) => item.sessionId)).toEqual([2, 1])
  })
})
