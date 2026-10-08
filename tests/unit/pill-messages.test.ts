import { describe, expect, it } from 'vitest'
import {
  clipboardMessage,
  describeNotice,
  noteMessage,
  pillMessage,
  recordingEndedMessage,
} from '../../src/main/dictation/pill-messages'
import type { Notice } from '../../src/main/dictation/session-controller'

const withText = (): boolean => true
const withoutText = (): boolean => false

describe('pillMessage', () => {
  it('offers Copy whenever the dictation left text behind but was not pasted', () => {
    const kept: Notice[] = [
      { kind: 'targetChanged', sessionId: 1 },
      { kind: 'secureField', sessionId: 1 },
      { kind: 'secureField', sessionId: 1, because: 'secureInput' },
      { kind: 'interrupted', sessionId: 1, hasText: true },
    ]
    for (const notice of kept) {
      expect(pillMessage(notice, withoutText), notice.kind).toMatchObject({
        canCopy: true,
        sound: true,
      })
    }
  })

  it('calls a field a password field only when the field itself says so', () => {
    const byRole = pillMessage({ kind: 'secureField', sessionId: 1 }, withText)
    const bySecureInput = pillMessage(
      { kind: 'secureField', sessionId: 1, because: 'secureInput' },
      withText,
    )

    expect(byRole?.message).toBe('Password field: nothing was pasted')
    expect(bySecureInput?.message).toBe('Secure Input is on: nothing was pasted')
  })

  it('offers Copy after a failure only if the text survived it', () => {
    const failed: Notice = { kind: 'failed', sessionId: 4, message: 'The recognizer took too long' }
    expect(pillMessage(failed, withText)).toEqual({
      message: 'The recognizer took too long',
      messageKind: 'problem',
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
      messageKind: 'plain',
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
      { kind: 'secureField', sessionId: 1, because: 'secureInput' },
      { kind: 'pasteFailed', sessionId: 1 },
      { kind: 'nothingToPaste' },
      { kind: 'copied' },
    ]
    for (const notice of notices) {
      expect(pillMessage(notice, withText)!.message.length, notice.kind).toBeLessThanOrEqual(40)
    }
  })
})

describe('the kind of each message', () => {
  const kindOf = (notice: Notice): string | undefined => pillMessage(notice, withText)?.messageKind

  it('is "protected" when the app refused on purpose and the text is safe', () => {
    expect(kindOf({ kind: 'targetChanged', sessionId: 1 })).toBe('protected')
    expect(kindOf({ kind: 'secureField', sessionId: 1 })).toBe('protected')
    expect(kindOf({ kind: 'secureField', sessionId: 1, because: 'secureInput' })).toBe('protected')
  })

  it('is "problem" when something failed', () => {
    expect(kindOf({ kind: 'pasteFailed', sessionId: 1 })).toBe('problem')
    expect(kindOf({ kind: 'interrupted', sessionId: 1, hasText: true })).toBe('problem')
    expect(kindOf({ kind: 'interrupted', sessionId: 1, hasText: false })).toBe('problem')
    expect(kindOf({ kind: 'failed', sessionId: 1, message: 'No microphone was found' })).toBe(
      'problem',
    )
    expect(recordingEndedMessage('limit')).toMatchObject({
      message: 'Stopped at the 20-minute limit',
      messageKind: 'problem',
      sound: true,
    })
    expect(recordingEndedMessage('microphoneLost')).toMatchObject({
      message: 'The microphone disconnected',
      messageKind: 'problem',
    })
  })

  it('marks a recording stopped at the limit as such, which the pill reads instead of the words', () => {
    expect(recordingEndedMessage('limit').stoppedAtLimit).toBe(true)
    expect(recordingEndedMessage('microphoneLost').stoppedAtLimit).toBeFalsy()
  })

  it('is "plain" for what the user did, or did not say', () => {
    expect(kindOf({ kind: 'cancelled', sessionId: 1, reason: 'escape' })).toBe('plain')
    expect(kindOf({ kind: 'noSpeech', sessionId: 1 })).toBe('plain')
  })

  it('is "confirm", with nothing to press, for what was done as asked', () => {
    for (const notice of [{ kind: 'copied' }, { kind: 'nothingToPaste' }] as Notice[]) {
      const pill = pillMessage(notice, withText)
      expect(pill, notice.kind).toMatchObject({ messageKind: 'confirm', canCopy: false })
      expect(pill, notice.kind).not.toHaveProperty('redo')
    }
  })

  it('is "note", with the sound, for a thing outside a dictation that did not happen', () => {
    expect(noteMessage('That setting could not be saved')).toEqual({
      message: 'That setting could not be saved',
      messageKind: 'note',
      canCopy: false,
      sound: true,
    })
    expect(clipboardMessage('failed')).toMatchObject({ messageKind: 'note' })
  })
})

describe('Undo and Retry', () => {
  it('offers Undo on a cancel that can be taken back, and nothing otherwise', () => {
    const undoable: Notice = { kind: 'cancelled', sessionId: 1, reason: 'escape', canUndo: true }
    expect(pillMessage(undoable, withoutText)).toEqual({
      message: 'Cancelled',
      messageKind: 'plain',
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

describe('clipboardMessage', () => {
  it('says so, quietly, when the clipboard could not be kept through a paste', () => {
    expect(clipboardMessage('notSaved')).toEqual({
      message: 'The clipboard now holds this dictation',
      messageKind: 'note',
      canCopy: false,
      sound: false,
    })
    expect(clipboardMessage('failed')).toMatchObject({ sound: false, canCopy: false })
  })

  it('says nothing when the user copied something after the paste, or nothing went wrong', () => {
    expect(clipboardMessage('copiedSince')).toBeNull()
    expect(clipboardMessage(undefined)).toBeNull()
  })

  it('keeps its messages short enough for the pill', () => {
    for (const reason of ['notSaved', 'failed']) {
      expect(clipboardMessage(reason)!.message.length, reason).toBeLessThanOrEqual(40)
    }
  })
})
