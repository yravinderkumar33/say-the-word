import { describe, expect, it } from 'vitest'
import { describeNotice, pillMessage } from '../../src/main/dictation/pill-messages'
import type { Notice } from '../../src/main/dictation/session-controller'

const withText = (): boolean => true
const withoutText = (): boolean => false

describe('pillMessage', () => {
  it('offers Copy whenever the dictation left text behind but was not pasted', () => {
    const kept: Notice[] = [
      { kind: 'targetChanged', sessionId: 1 },
      { kind: 'secureField', sessionId: 1 },
      { kind: 'interrupted', sessionId: 1, hasText: true },
    ]
    for (const notice of kept) {
      expect(pillMessage(notice, withoutText), notice.kind).toMatchObject({
        canCopy: true,
        sound: true,
      })
    }
  })

  it('offers Copy after a failure only if the text survived it', () => {
    const failed: Notice = { kind: 'failed', sessionId: 4, message: 'The recognizer took too long' }
    expect(pillMessage(failed, withText)).toEqual({
      message: 'The recognizer took too long',
      canCopy: true,
      sound: true,
    })
    expect(pillMessage(failed, withoutText)).toMatchObject({ canCopy: false })
    expect(pillMessage({ kind: 'pasteFailed', sessionId: 4 }, withText)).toMatchObject({
      message: 'Could not paste',
      canCopy: true,
    })
  })

  it('asks which session it is about', () => {
    const asked: number[] = []
    pillMessage({ kind: 'failed', sessionId: 9, message: 'x' }, (sessionId) => {
      asked.push(sessionId)
      return false
    })
    expect(asked).toEqual([9])
  })

  it('never offers Copy when there is nothing to copy', () => {
    const empty: Notice[] = [
      { kind: 'cancelled', sessionId: 1, reason: 'escape' },
      { kind: 'interrupted', sessionId: 1, hasText: false },
      { kind: 'noSpeech', sessionId: 1 },
      { kind: 'nothingToPaste' },
      { kind: 'copied' },
    ]
    for (const notice of empty) {
      expect(pillMessage(notice, withText)?.canCopy, notice.kind).toBe(false)
    }
  })

  it('stays silent for things the user did on purpose', () => {
    expect(pillMessage({ kind: 'cancelled', sessionId: 1, reason: 'escape' }, withText)).toEqual({
      message: 'Cancelled',
      canCopy: false,
      sound: false,
    })
    expect(pillMessage({ kind: 'copied' }, withText)?.sound).toBe(false)
    // Paste-last replacing a session, and the "still processing" cue, show no message at all.
    expect(
      pillMessage({ kind: 'cancelled', sessionId: 1, reason: 'superseded' }, withText),
    ).toBeNull()
    expect(pillMessage({ kind: 'stillProcessing' }, withText)).toBeNull()
  })

  it('puts helper errors into plain words', () => {
    const notice: Notice = {
      kind: 'failed',
      sessionId: 2,
      message: 'helper did not answer "captureTarget" within 3000 ms',
    }
    expect(pillMessage(notice, withoutText)?.message).toBe('The shortcut helper did not respond')
  })

  it('keeps every message short enough for the pill', () => {
    const notices: Notice[] = [
      { kind: 'cancelled', sessionId: 1, reason: 'escape' },
      { kind: 'interrupted', sessionId: 1, hasText: true },
      { kind: 'interrupted', sessionId: 1, hasText: false },
      { kind: 'noSpeech', sessionId: 1 },
      { kind: 'targetChanged', sessionId: 1 },
      { kind: 'secureField', sessionId: 1 },
      { kind: 'pasteFailed', sessionId: 1 },
      { kind: 'nothingToPaste' },
      { kind: 'copied' },
    ]
    for (const notice of notices) {
      expect(pillMessage(notice, withText)!.message.length, notice.kind).toBeLessThanOrEqual(40)
    }
  })
})

describe('Undo and Retry', () => {
  it('offers Undo on a cancel that can be taken back, and nothing otherwise', () => {
    const undoable: Notice = { kind: 'cancelled', sessionId: 1, reason: 'escape', canUndo: true }
    expect(pillMessage(undoable, withoutText)).toEqual({
      message: 'Cancelled',
      canCopy: false,
      sound: false,
      redo: 'Undo',
    })
    expect(
      pillMessage({ kind: 'cancelled', sessionId: 1, reason: 'escape' }, withoutText),
    ).not.toHaveProperty('redo')
  })

  it('offers Retry on a decode that can be tried again', () => {
    const retryable: Notice = {
      kind: 'failed',
      sessionId: 1,
      message: 'The recognizer took too long',
      canRetry: true,
    }
    expect(pillMessage(retryable, withoutText)).toMatchObject({ redo: 'Retry', canCopy: false })
    expect(
      pillMessage(
        { kind: 'failed', sessionId: 1, message: 'No microphone was found' },
        withoutText,
      ),
    ).not.toHaveProperty('redo')
  })
})

describe('describeNotice', () => {
  it('names the session and the reason, for the log', () => {
    expect(describeNotice({ kind: 'cancelled', sessionId: 3, reason: 'escape' })).toBe(
      'cancelled (session 3): escape',
    )
    expect(describeNotice({ kind: 'interrupted', sessionId: 3, hasText: true })).toBe(
      'interrupted (session 3): text kept',
    )
    expect(
      describeNotice({ kind: 'failed', sessionId: 3, message: 'No microphone was found' }),
    ).toBe('failed (session 3): No microphone was found')
    expect(describeNotice({ kind: 'noSpeech', sessionId: 3 })).toBe('noSpeech (session 3)')
    expect(describeNotice({ kind: 'copied' })).toBe('copied')
  })
})
