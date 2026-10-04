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
