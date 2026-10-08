import type { PillRecovery } from '@shared/ipc'
import type { Notice } from './session-controller'

/**
 * What the pill says for each thing the session controller reports, or null when the
 * pill should say nothing. The wording is short: it has to fit a small capsule.
 *
 * A sound goes with the messages the user would otherwise miss, because their eyes
 * are on the document: the dictation they expected did not arrive.
 */
export function pillMessage(
  notice: Notice,
  hasText: (sessionId: number) => boolean,
): PillRecovery | null {
  const plain = (message: string): PillRecovery => ({
    message,
    messageKind: 'plain',
    canCopy: false,
    sound: false,
  })
  // Done as asked: said briefly, and with nothing to press.
  const confirm = (message: string): PillRecovery => ({
    message,
    messageKind: 'confirm',
    canCopy: false,
    sound: false,
  })
  // The app refused to paste on purpose. The text is safe, and Copy fetches it.
  const kept = (message: string): PillRecovery => ({
    message,
    messageKind: 'protected',
    canCopy: true,
    sound: true,
  })
  const problem = (message: string, canCopy: boolean): PillRecovery => ({
    message,
    messageKind: 'problem',
    canCopy,
    sound: true,
  })

  switch (notice.kind) {
    case 'stillProcessing':
      return null
    case 'cancelled':
      // Paste-last replaced the session on purpose; there is nothing to explain.
      if (notice.reason === 'superseded') return null
      return { ...plain('Cancelled'), ...(notice.canUndo ? { redo: 'Undo' as const } : {}) }
    case 'interrupted':
      return notice.hasText
        ? problem('Interrupted. Your text was kept', true)
        : problem('Dictation was interrupted', false)
    case 'noSpeech':
      return plain('No speech heard')
    case 'targetChanged':
      return kept('Focus moved, so nothing was pasted')
    case 'secureField':
      // With only Secure Input to go on, the field may or may not be a password field.
      // The message says what is known, and names the thing the user can look up.
      return notice.because === 'secureInput'
        ? kept('Secure Input is on: nothing was pasted')
        : kept('Password field: nothing was pasted')
    case 'pasteFailed':
      return problem('Could not paste', hasText(notice.sessionId))
    case 'failed':
      return {
        ...problem(plainWords(notice.message), hasText(notice.sessionId)),
        ...(notice.canRetry ? { redo: 'Retry' as const } : {}),
      }
    case 'nothingToPaste':
      return confirm('Nothing to paste yet')
    case 'copied':
      return confirm('Copied')
  }
}

/** Said when a recording ends by itself. What was captured is used as if the key had been released. */
export function recordingEndedMessage(reason: 'limit' | 'microphoneLost'): PillRecovery {
  return {
    message: reason === 'limit' ? 'Stopped at the 20-minute limit' : 'The microphone disconnected',
    messageKind: 'problem',
    canCopy: false,
    sound: true,
    stoppedAtLimit: reason === 'limit',
  }
}

/**
 * Something outside a dictation that the user asked for and did not get, such as a
 * setting that would not save. Nothing is lost by it, so it is a note; the sound says
 * that what was asked for did not happen.
 */
export function noteMessage(message: string): PillRecovery {
  return { message, messageKind: 'note', canCopy: false, sound: true }
}

/**
 * What the pill says when the clipboard was not put back after a paste, or null when
 * there is nothing to say. The paste itself went through, so this is said quietly.
 *
 * When the user copied something after the paste, they have what they copied and need
 * no telling. Otherwise what they had on the clipboard is gone, and until now only the
 * log said so.
 */
export function clipboardMessage(reason: string | undefined): PillRecovery | null {
  const note = (message: string): PillRecovery => ({
    message,
    messageKind: 'note',
    canCopy: false,
    sound: false,
  })
  // Too large, too slow, or with a format that could not be read: it was not copied,
  // and the text that was pasted is what the clipboard holds now.
  if (reason === 'notSaved') return note('The clipboard now holds this dictation')
  if (reason === 'failed') return note('The clipboard could not be put back')
  return null
}

/** Errors from the helper bridge are written for the log, not for the pill. */
function plainWords(message: string): string {
  if (/^helper\b/i.test(message)) return 'The shortcut helper did not respond'
  return message
}

/** A log line for a notice. It never includes transcript text. */
export function describeNotice(notice: Notice): string {
  const session = 'sessionId' in notice ? ` (session ${notice.sessionId})` : ''
  if (notice.kind === 'failed') return `failed${session}: ${notice.message}`
  if (notice.kind === 'cancelled') return `cancelled${session}: ${notice.reason}`
  if (notice.kind === 'interrupted') {
    return `interrupted${session}: ${notice.hasText ? 'text kept' : 'no text'}`
  }
  return `${notice.kind}${session}`
}
