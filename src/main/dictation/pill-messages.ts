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
  const quiet = (message: string): PillRecovery => ({ message, canCopy: false, sound: false })
  const alert = (message: string, canCopy: boolean): PillRecovery => ({
    message,
    canCopy,
    sound: true,
  })

  switch (notice.kind) {
    case 'stillProcessing':
      return null
    case 'cancelled':
      // Paste-last replaced the session on purpose; there is nothing to explain.
      if (notice.reason === 'superseded') return null
      return { ...quiet('Cancelled'), ...(notice.canUndo ? { redo: 'Undo' as const } : {}) }
    case 'interrupted':
      return notice.hasText
        ? alert('Interrupted. Your text was kept', true)
        : alert('Dictation was interrupted', false)
    case 'noSpeech':
      return quiet('No speech heard')
    case 'targetChanged':
      return alert('Focus moved, so nothing was pasted', true)
    case 'secureField':
      // With only Secure Input to go on, the field may or may not be a password field.
      // The message says what is known, and names the thing the user can look up.
      return notice.because === 'secureInput'
        ? alert('Secure Input is on: nothing was pasted', true)
        : alert('Password field: nothing was pasted', true)
    case 'pasteFailed':
      return alert('Could not paste', hasText(notice.sessionId))
    case 'failed':
      return {
        ...alert(plainWords(notice.message), hasText(notice.sessionId)),
        ...(notice.canRetry ? { redo: 'Retry' as const } : {}),
      }
    case 'nothingToPaste':
      return quiet('Nothing to paste yet')
    case 'copied':
      return quiet('Copied')
  }
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
  if (reason === 'notSaved') {
    // Too large, too slow, or with a format that could not be read: it was not copied,
    // and the text that was pasted is what the clipboard holds now.
    return { message: 'The clipboard now holds this dictation', canCopy: false, sound: false }
  }
  if (reason === 'failed') {
    return { message: 'The clipboard could not be put back', canCopy: false, sound: false }
  }
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
