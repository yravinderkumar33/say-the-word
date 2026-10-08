import { describe, expect, it } from 'vitest'
import {
  deleteAllHistoryQuestion,
  deleteStoredQuestion,
  keepQuestion,
} from '../../src/main/hub/questions'

const nothing = { startsWriting: false, expiring: 0, relisted: 0 }
const RECOVERY =
  ' Paste Last and Copy Last can still give back the last dictations until you quit; ' +
  'Delete Everything, on the Privacy page, deletes them too.'

describe('what a change of "Keep" asks', () => {
  it('says that what was said will be written to disk, for how long, and that it goes nowhere', () => {
    const question = keepQuestion('week', { ...nothing, startsWriting: true }, 23)

    expect(question).toMatchObject({
      kind: 'keepHistory:week',
      message: 'Keep dictations on this Mac for 7 days?',
      confirm: 'Keep for 7 Days',
    })
    expect(question.detail).toContain('the text of what you said')
    expect(question.detail).toContain('deleted after 7 days')
    expect(question.detail).toContain('The 23 dictations in the list now are written too.')
    expect(question.detail).toContain('Nothing is sent anywhere.')
  })

  it('does not speak of dictations that are not there, and gets one right', () => {
    expect(keepQuestion('month', { ...nothing, startsWriting: true }, 0).detail).not.toContain(
      'in the list now',
    )
    expect(keepQuestion('month', { ...nothing, startsWriting: true }, 1).detail).toContain(
      'The 1 dictation in the list now is written too.',
    )
  })

  it('says that keeping until deleted has no end', () => {
    const question = keepQuestion('forever', { ...nothing, startsWriting: true }, 2)

    expect(question.message).toBe('Keep dictations on this Mac until you delete them?')
    expect(question.confirm).toBe('Keep Until I Delete Them')
    expect(question.detail).not.toContain('deleted after')
  })

  it('says that going back to memory deletes what is on disk now', () => {
    expect(keepQuestion('session', nothing, 5)).toMatchObject({
      kind: 'keepHistory:session',
      message: 'Keep dictations only until you quit?',
      detail:
        'The dictations saved on disk are deleted now. The list stays as it is until ' +
        'Whisper Flow quits, and nothing more is written to disk.',
      confirm: 'Stop Saving to Disk',
    })
  })

  it('says that going back to memory deletes files the list does not show, when there are any', () => {
    // A database that cannot be read (damaged, or written by a newer build) is on disk too.
    expect(keepQuestion('session', nothing, 2, 1).detail).toBe(
      'The dictations saved on disk are deleted now, including the file of dictations saved ' +
        'earlier that the list does not show. The list stays as it is until Whisper Flow ' +
        'quits, and nothing more is written to disk.',
    )
    expect(keepQuestion('session', nothing, 0, 3).detail).toContain(
      'including the 3 files of dictations saved earlier that the list does not show.',
    )
  })

  it('counts the dictations saved earlier that a time lists again, and those it deletes at once', () => {
    // The settings had stopped saying how long to keep them: they were on disk, not listed.
    const question = keepQuestion(
      'week',
      { ...nothing, startsWriting: true, relisted: 120, expiring: 40 },
      2,
    )

    expect(question.detail).toContain('The 2 dictations in the list now are written too.')
    expect(question.detail).toContain(
      'The 120 dictations saved earlier and still on this Mac are listed again.',
    )
    expect(question.detail).toContain('40 dictations older than that are deleted now.')
    expect(
      keepQuestion('month', { ...nothing, startsWriting: true, relisted: 1 }, 0).detail,
    ).toContain('The 1 dictation saved earlier and still on this Mac is listed again.')
  })

  it('says how many dictations a shorter time deletes at once', () => {
    const question = keepQuestion('week', { ...nothing, expiring: 12 }, 40)

    expect(question.message).toBe('Keep dictations for 7 days?')
    expect(question.detail).toBe(
      'Each dictation is deleted 7 days after it was made. 12 dictations older than that are deleted now.',
    )
    expect(keepQuestion('week', { ...nothing, expiring: 1 }, 40).detail).toContain(
      '1 dictation older than that is deleted now.',
    )
  })
})

describe('what a Delete asks', () => {
  it('names how many dictations go, and from where', () => {
    expect(deleteAllHistoryQuestion(23, false)).toMatchObject({
      kind: 'deleteHistory',
      message: 'Delete all 23 dictations in the history?',
      detail: 'They are removed from the list. This cannot be undone.' + RECOVERY,
      confirm: 'Delete All',
    })
    expect(deleteAllHistoryQuestion(1, true)).toMatchObject({
      message: 'Delete the dictation in the history?',
      detail: 'It is removed from the list and from disk. This cannot be undone.' + RECOVERY,
    })
  })

  it('says so when files that are not listed go as well, and when they are all there is', () => {
    // Held in memory, with files an earlier setting left on disk.
    expect(deleteAllHistoryQuestion(5, false, 3).detail).toBe(
      'They are removed from the list. The 3 files of dictations saved earlier, still on ' +
        'disk, are deleted too. This cannot be undone.' +
        RECOVERY,
    )
    expect(deleteAllHistoryQuestion(0, false, 1)).toMatchObject({
      message: 'Delete the dictations saved earlier?',
      detail: 'The file still on disk is deleted. This cannot be undone.',
      confirm: 'Delete All',
    })
  })

  it('says so when a file that cannot be read goes with the dictations kept on disk', () => {
    expect(deleteAllHistoryQuestion(1, true, 1)).toMatchObject({
      message: 'Delete the dictation in the history?',
      detail:
        'It is removed from the list and from disk. The file of dictations saved earlier, ' +
        'still on disk, is deleted too. This cannot be undone.' +
        RECOVERY,
    })
  })

  it('says what each kind of stored thing is, so that nothing is deleted unawares', () => {
    const counts = { history: 4, recordings: 12, historyOnDisk: false, historyLeft: 0 }

    expect(deleteStoredQuestion('recordings', counts).message).toBe(
      'Delete the 12 saved recordings and their text?',
    )
    expect(
      deleteStoredQuestion('recordings', { ...counts, history: 0, recordings: 1 }).message,
    ).toBe('Delete the saved recording and its text?')
    expect(deleteStoredQuestion('log', counts).detail).toContain('never contains what you said')
    expect(deleteStoredQuestion('counts', counts).detail).toContain('numbers only')
    expect(deleteStoredQuestion('history', counts).kind).toBe('deleteStored:history')
  })

  it('does not speak of the disk for a history that is held in memory only', () => {
    const inMemory = { history: 4, recordings: 0, historyOnDisk: false, historyLeft: 0 }

    expect(deleteStoredQuestion('history', inMemory).detail).toBe(
      'They are removed from the list. This cannot be undone.' + RECOVERY,
    )
    expect(deleteStoredQuestion('history', { ...inMemory, historyOnDisk: true }).detail).toBe(
      'They are removed from the list and from disk. This cannot be undone.' + RECOVERY,
    )
  })

  it('lists everything that "Delete Everything" deletes, and what it keeps', () => {
    const question = deleteStoredQuestion('everything', {
      history: 4,
      recordings: 12,
      historyOnDisk: true,
      historyLeft: 0,
    })

    expect(question.kind).toBe('deleteStored:everything')
    expect(question.confirm).toBe('Delete Everything')
    expect(question.detail).toContain('The history (4 dictations)')
    expect(question.detail).toContain('the saved recordings (12)')
    expect(question.detail).toContain('Your settings and the speech model are kept.')
    // It goes further than the stores on disk, and says so (QA-05).
    expect(question.detail).toContain('Paste Last, Copy Last and Undo')
    expect(question.detail).toContain('A dictation under way is cancelled.')
  })

  it('counts in "Delete Everything" the files of dictations saved earlier that go with the history', () => {
    // Kept on disk, then the settings stopped saying for how long: on disk, and not listed.
    const preserved = { history: 0, recordings: 0, historyOnDisk: false, historyLeft: 1 }

    expect(deleteStoredQuestion('everything', preserved).detail).toContain(
      'The history (1 file of dictations saved earlier, still on disk), the saved recordings (0)',
    )
    expect(
      deleteStoredQuestion('everything', { ...preserved, history: 4, historyLeft: 2 }).detail,
    ).toContain(
      'The history (4 dictations, and 2 files of dictations saved earlier, still on disk)',
    )
  })
})
