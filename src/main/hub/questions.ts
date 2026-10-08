import type { HistoryKeep, StoredKind } from '@shared/ipc'
import { PRODUCT_NAME } from '@shared/product'
import type { KeepChange } from '../history/history-store'
import type { Question } from '../system/confirm'

/** How long dictations are kept, as it is said in the middle of a sentence. */
const KEEP_WORDS: Record<Exclude<HistoryKeep, 'session'>, string> = {
  week: '7 days',
  month: '30 days',
  forever: 'until you delete them',
}

const dictations = (count: number): string => (count === 1 ? '1 dictation' : `${count} dictations`)

/**
 * The question a change of "Keep" is put as. Writing what was said to disk is the one
 * thing the history does that a person has to have said yes to, and so is deleting it.
 *
 * `unlisted` is how many files going back to memory deletes that the list does not show:
 * a database that cannot be read, or the files a history held in memory left on disk.
 */
export function keepQuestion(
  keep: HistoryKeep,
  change: KeepChange,
  listed: number,
  unlisted = 0,
): Question {
  if (keep === 'session') {
    const including =
      unlisted > 0
        ? `, including ${unlisted === 1 ? 'the file' : `the ${unlisted} files`} of dictations ` +
          'saved earlier that the list does not show'
        : ''
    return {
      kind: 'keepHistory:session',
      message: 'Keep dictations only until you quit?',
      detail:
        `The dictations saved on disk are deleted now${including}. The list stays as it is ` +
        `until ${PRODUCT_NAME} quits, and nothing more is written to disk.`,
      confirm: 'Stop Saving to Disk',
    }
  }
  const time = KEEP_WORDS[keep]
  const forTime = keep === 'forever' ? time : `for ${time}`
  const confirm = keep === 'forever' ? 'Keep Until I Delete Them' : `Keep for ${titleCase(time)}`
  const expiring =
    change.expiring > 0
      ? ` ${dictations(change.expiring)} older than that ${change.expiring === 1 ? 'is' : 'are'} deleted now.`
      : ''
  // Saved earlier and not listed: the settings had stopped saying how long to keep them.
  const relisted =
    change.relisted > 0
      ? `The ${dictations(change.relisted)} saved earlier and still on this Mac ${change.relisted === 1 ? 'is' : 'are'} listed again. `
      : ''
  if (change.startsWriting) {
    return {
      kind: `keepHistory:${keep}`,
      message: `Keep dictations on this Mac ${forTime}?`,
      detail:
        'Each dictation, with the text of what you said, will be written to a folder on ' +
        `this Mac${keep === 'forever' ? '' : ` and deleted after ${time}`}. ` +
        (listed > 0
          ? `The ${dictations(listed)} in the list now ${listed === 1 ? 'is' : 'are'} written too. `
          : '') +
        relisted +
        `Nothing is sent anywhere.${expiring}`,
      confirm,
    }
  }
  return {
    kind: `keepHistory:${keep}`,
    message: `Keep dictations ${forTime}?`,
    detail:
      (keep === 'forever'
        ? 'Dictations stay on this Mac until you delete them.'
        : `Each dictation is deleted ${time} after it was made.`) + expiring,
    confirm,
  }
}

/**
 * What deleting the history leaves: the last dictations' text, held in memory for Paste
 * Last and Copy Last, which are not the history. Said, so that nobody takes it for gone.
 */
const RECOVERY_STAYS =
  ' Paste Last and Copy Last can still give back the last dictations until you quit; ' +
  'Delete Everything, on the Privacy page, deletes them too.'

/**
 * `left` is how many files are on disk without being listed: days' files while the
 * history is held in memory only, or files that cannot be read while it is kept on disk.
 * They go with the rest, and the question says so.
 */
export function deleteAllHistoryQuestion(count: number, onDisk: boolean, left = 0): Question {
  const files = left === 1 ? 'The file' : `The ${left} files`
  const leftToo =
    left > 0
      ? ` ${files} of dictations saved earlier, still on disk, ${left === 1 ? 'is' : 'are'} deleted too.`
      : ''
  if (count === 0 && left > 0) {
    return {
      kind: 'deleteHistory',
      message: 'Delete the dictations saved earlier?',
      detail: `${files} still on disk ${left === 1 ? 'is' : 'are'} deleted. This cannot be undone.`,
      confirm: 'Delete All',
    }
  }
  if (count === 0) {
    // Nothing listed and no file counted: the folder itself could not be looked into.
    return {
      kind: 'deleteHistory',
      message: 'Delete what the history left on disk?',
      detail:
        'The history’s folder could not be read. Whatever dictations are in it are deleted. ' +
        'This cannot be undone.',
      confirm: 'Delete All',
    }
  }
  return {
    kind: 'deleteHistory',
    message: `Delete ${count === 1 ? 'the dictation' : `all ${count} dictations`} in the history?`,
    detail:
      `${count === 1 ? 'It is' : 'They are'} removed from the list${onDisk ? ' and from disk' : ''}.` +
      `${leftToo} This cannot be undone.` +
      RECOVERY_STAYS,
    confirm: 'Delete All',
  }
}

/** What a Delete on the Privacy page asks, by what is to be deleted. */
export function deleteStoredQuestion(
  kind: StoredKind | 'everything',
  counts: { history: number; recordings: number; historyOnDisk: boolean; historyLeft: number },
): Question {
  switch (kind) {
    case 'history':
      return {
        ...deleteAllHistoryQuestion(counts.history, counts.historyOnDisk, counts.historyLeft),
        kind: 'deleteStored:history',
      }
    case 'recordings':
      return {
        kind: 'deleteStored:recordings',
        message: `Delete ${counts.recordings === 1 ? 'the saved recording and its text' : `the ${counts.recordings} saved recordings and their text`}?`,
        detail:
          'They were saved by “Save every dictation”, to score the recognizer on your ' +
          'voice. This cannot be undone.',
        confirm: 'Delete',
      }
    case 'log':
      return {
        kind: 'deleteStored:log',
        message: 'Delete the log?',
        detail:
          'The log says what the app did and why a paste was refused. It never contains ' +
          'what you said. A new one is started at once.',
        confirm: 'Delete',
      }
    case 'counts':
      return {
        kind: 'deleteStored:counts',
        message: 'Delete the word counts?',
        detail: 'The figures on Home start again from zero. They are numbers only.',
        confirm: 'Delete',
      }
    case 'everything': {
      // Files on disk that are not listed go with the history, and are counted with it.
      const left = counts.historyLeft
      const history =
        left === 0
          ? dictations(counts.history)
          : `${counts.history > 0 ? `${dictations(counts.history)}, and ` : ''}` +
            `${left === 1 ? '1 file' : `${left} files`} of dictations saved earlier, still on disk`
      return {
        kind: 'deleteStored:everything',
        message: `Delete everything ${PRODUCT_NAME} has stored?`,
        detail:
          `The history (${history}), the saved recordings ` +
          `(${counts.recordings}), the log and the word counts are deleted, and so is the ` +
          'text of the last dictations that Paste Last, Copy Last and Undo would give back. ' +
          'A dictation under way is cancelled. Your settings and the speech model are kept. ' +
          'This cannot be undone.',
        confirm: 'Delete Everything',
      }
    }
  }
}

function titleCase(text: string): string {
  return text.replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
}
