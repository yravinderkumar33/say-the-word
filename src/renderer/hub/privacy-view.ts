import type { Contact, DeleteProblem, PrivacyFacts, StoredKind } from '@shared/ipc'
import { bytes, counted } from './format'
import { KEEP_LABELS } from './history-view'

/**
 * What the Privacy page says. Each statement stands beside a fact read from the app
 * as it runs, so the wording is kept apart from the window and tested.
 */

/** Said while the facts cannot be read. They are asked for again by themselves. */
export const FACTS_UNREAD = 'The facts could not be read.'

/** What has been reached over the network since the app was started. One line for each address. */
export function contactedLines(contacts: readonly Contact[]): string[] {
  if (contacts.length === 0) return ['Nothing']
  return contacts.map((contact) => {
    if (contact.what === 'ollama') {
      if (!contact.local) return `${contact.host}, an Ollama server that is not this Mac`
      return contact.answered
        ? `${contact.host}, Ollama on this Mac`
        : `${contact.host}, this Mac: nothing answered`
    }
    if (contact.what === 'speechModel')
      return `${contact.host}, for the speech model you downloaded`
    // Nothing was sent: the request was stopped before it left.
    if (contact.what === 'refused') return `${contact.host}: asked for by a page, and refused`
    return contact.local ? `${contact.host}, this Mac` : contact.host
  })
}

export interface StoredRow {
  kind: StoredKind
  label: string
  value: string
  /** What you say is being saved: the row says so with the amber chip. */
  saving: boolean
  /** There is something on disk to show in Finder. */
  canShow: boolean
  canDelete: boolean
}

/** What is stored on this Mac, row by row. */
export function storedRows(facts: PrivacyFacts): StoredRow[] {
  const { history, recordings, log, counts } = facts
  const recorded = `${counted(recordings.count, 'recording')} and ${recordings.count === 1 ? 'its' : 'their'} text`
  return [
    {
      kind: 'history',
      label: 'History',
      value: history.onDisk
        ? `On disk ${history.keep === 'forever' ? 'until you delete it' : `for ${KEEP_LABELS[history.keep]}`}: ` +
          `${counted(history.count, 'dictation')}, ${bytes(history.bytes)}`
        : (history.count === 0
            ? history.left > 0
              ? 'Nothing listed'
              : 'Nothing kept yet'
            : `In memory only: ${counted(history.count, 'dictation')}, gone when the app quits`) +
          // Files the settings no longer account for, or that would not be deleted: said, not hidden.
          (history.left > 0
            ? `. ${counted(history.left, 'file')} saved earlier ${history.left === 1 ? 'is' : 'are'} still on disk, ${bytes(history.bytes)}`
            : ''),
      saving: false,
      canShow: history.onDisk || history.left > 0 || (history.disk?.files ?? 0) > 0,
      canDelete:
        history.count > 0 ||
        history.left > 0 ||
        (history.disk?.files ?? 0) > 0 ||
        history.disk?.scanFailed === true,
    },
    {
      kind: 'recordings',
      label: 'Evaluation recordings',
      // A folder that could not be read may still hold recordings: never "nothing saved".
      value: recordings.scanFailed
        ? `${recordings.saving ? 'On' : 'Off'}. The folder could not be checked`
        : recordings.saving
          ? recordings.count === 0
            ? 'On. Nothing saved yet'
            : `On: ${recorded}, ${bytes(recordings.bytes)}`
          : recordings.count === 0
            ? 'Off. Nothing saved'
            : `Off. ${recorded} ${recordings.count === 1 ? 'is' : 'are'} still on this Mac, ${bytes(recordings.bytes)}`,
      saving: recordings.saving,
      canShow: recordings.count > 0 || recordings.scanFailed === true,
      canDelete: recordings.count > 0 || recordings.scanFailed === true,
    },
    {
      kind: 'log',
      label: 'Log',
      value: `${bytes(log.bytes)}. It never contains what you said`,
      saving: false,
      canShow: log.bytes > 0,
      canDelete: log.bytes > 0,
    },
    {
      kind: 'counts',
      label: 'Word counts',
      value:
        counts.bytes > 0
          ? `${bytes(counts.bytes)}. Words per day and timings: numbers only`
          : 'Nothing counted yet',
      saving: false,
      canShow: counts.bytes > 0,
      canDelete: counts.bytes > 0,
    },
  ]
}

/** What is said beside "Delete Everything…", and whether there is anything for it to do. */
export function everythingNote(rows: readonly StoredRow[]): { text: string; enabled: boolean } {
  const deletable = rows.filter((row) => row.canDelete).map((row) => row.kind)
  if (deletable.length === 0) return { text: 'There is nothing to delete.', enabled: false }
  if (deletable.length === 1 && deletable[0] === 'log') {
    return { text: 'There is nothing to delete except the log.', enabled: true }
  }
  return {
    text: 'Deletes the history, the recordings, the log and the word counts. Confirmed in a dialog.',
    enabled: true,
  }
}

/** A Delete that left something behind: how much, why it may be, and what to do. */
export function problemWords(problem: DeleteProblem): { title: string; body: string } {
  if (problem.kind === 'history' && problem.failedFiles !== undefined) {
    const parts = [
      problem.failedRows ? counted(problem.failedRows, 'dictation') : '',
      problem.failedFiles ? counted(problem.failedFiles, 'file') : '',
      problem.scanFailed ? 'The folder could not be checked' : '',
    ].filter(Boolean)
    return {
      title: `${parts.join(' and ')} could not be deleted`,
      body: 'Some history remains. Check file permissions and try Delete Everything again.',
    }
  }
  if (problem.kind === 'recordings' && problem.scanFailed) {
    return {
      title: 'The folder of recordings could not be checked',
      body: 'Recordings may still be in it. Check its permissions, then try again.',
    }
  }
  const what =
    problem.kind === 'history'
      ? counted(problem.failed, 'dictation')
      : problem.kind === 'recordings'
        ? counted(problem.failed, 'recording')
        : problem.kind === 'log'
          ? 'The log'
          : 'The word counts'
  const others =
    problem.deleted > 0
      ? ` The other ${problem.deleted} ${problem.deleted === 1 ? 'was' : 'were'} deleted.`
      : ''
  return {
    title: `${what} could not be deleted`,
    body: `The files may be open in another app, or protected. Close them there, then try again.${others}`,
  }
}
