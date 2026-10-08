import type { DictationMode, HistoryEntry, HistoryOutcome, HistoryTimings } from '@shared/ipc'
import { modeOf, type RecoveryEntry } from '../dictation/recovery-buffer'
import type { SessionTimings } from '../dictation/session-metrics'

export const NO_TIMINGS: HistoryTimings = { releaseToTextMs: null, tidyMs: null, pasteMs: null }

/** How a session ended, in the terms the History page uses. */
export function historyOutcome(entry: RecoveryEntry): HistoryOutcome {
  switch (entry.outcome) {
    case 'pasted':
      return 'pasted'
    case 'targetChanged':
      return 'focusMoved'
    case 'secureField':
      // Only the field's own role says "password"; Secure Input alone is named as what it is.
      return entry.secureInput ? 'secureInput' : 'passwordField'
    case 'cancelled':
      return entry.interrupted ? 'interrupted' : 'cancelled'
    case 'pasteFailed':
      return 'notPasted'
    case 'noSpeech':
      return 'noSpeech'
    case 'failed':
      return 'failed'
  }
}

/**
 * A session as the history keeps it. `id` is the session's number with the launch it
 * belongs to, because session numbers start again each time the app does.
 *
 * `modeNow` is the mode in force: a session that left no text also left no trace of
 * the mode it ran in.
 */
export function historyEntry(
  entry: RecoveryEntry,
  id: string,
  modeNow: DictationMode,
): HistoryEntry {
  return {
    id,
    endedAt: entry.endedAt,
    app: entry.appName ?? null,
    outcome: historyOutcome(entry),
    fetched: null,
    mode: modeOf(entry, modeNow),
    note: entry.cleanupNote ?? null,
    heard: entry.rawText ?? '',
    written: entry.finalText ?? '',
    failure: null,
    audioMs: null,
    timings: NO_TIMINGS,
  }
}

/** Where the time of a dictation went, from the moments the app noted. */
export function historyTimings(timings: SessionTimings): {
  audioMs: number | null
  timings: HistoryTimings
} {
  const { releaseToTextMs, releaseToPasteMs, pasteMs, cleanupMs } = timings
  // From the text being ready to the paste being done: reading the destination, then pasting.
  const pasting =
    releaseToTextMs !== null && releaseToPasteMs !== null && pasteMs !== null
      ? Math.max(0, releaseToPasteMs - releaseToTextMs) + pasteMs
      : null
  return {
    audioMs: timings.audioMs,
    timings: { releaseToTextMs, tidyMs: cleanupMs, pasteMs: pasting },
  }
}
