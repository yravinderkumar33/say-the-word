/** How a session ended. Only `pasted` means text was sent to the destination. */
export type SessionOutcome =
  'pasted' | 'cancelled' | 'targetChanged' | 'secureField' | 'pasteFailed' | 'noSpeech' | 'failed'

export interface RecoveryEntry {
  sessionId: number
  /** Milliseconds since the epoch, when the session ended. */
  endedAt: number
  outcome: SessionOutcome
  /** The recognizer's text, untouched. Null when the session produced none. */
  rawText: string | null
  /** The text that was pasted or offered. Null when the session produced none. */
  finalText: string | null
  /** Cleaned mode: the text after the rules, before the model. */
  rulesText?: string | null
  /** Cleaned mode: the model's text, when the guard accepted it. */
  cleanedText?: string | null
  /** Cleaned mode: why the final text is what it is (`cleaned`, `timeout`, `guard:invented`…). */
  cleanupNote?: string | null
}

/**
 * The last few sessions, held in memory only. It is what paste-last, copy-last and the
 * Recovery pill read from. Nothing here is written to disk, and it is gone on quit.
 *
 * A session is recorded whatever its outcome: a paste that looked successful cannot be
 * proven to have reached the editor, so its text stays recoverable too.
 */
export class RecoveryBuffer {
  private readonly entries: RecoveryEntry[] = []

  constructor(private readonly capacity = 20) {}

  /**
   * Adds a session, or replaces the entry of the same session.
   *
   * Undo and Retry run a session again under its id. An attempt that ends with no text
   * (it failed, or was cancelled in turn) says how the session ended, but does not take
   * away the text an earlier attempt left: that text is still the user's words.
   */
  record(entry: RecoveryEntry): void {
    const existing = this.entries.findIndex((item) => item.sessionId === entry.sessionId)
    if (existing === -1) {
      this.entries.push(entry)
      if (this.entries.length > this.capacity) this.entries.shift()
      return
    }
    const before = this.entries[existing]
    this.entries[existing] =
      !entry.finalText && before?.finalText
        ? { ...before, endedAt: entry.endedAt, outcome: entry.outcome }
        : entry
  }

  /**
   * Text that arrived after its session was over (it was cancelled while the text was
   * still being worked out). Kept only if the session has none: by now an Undo may
   * have produced, and pasted, a newer one.
   */
  fill(sessionId: number, text: Omit<RecoveryEntry, 'sessionId' | 'endedAt' | 'outcome'>): void {
    const existing = this.entries.findIndex((item) => item.sessionId === sessionId)
    const before = this.entries[existing]
    if (!before || before.finalText) return
    this.entries[existing] = { ...before, ...text }
  }

  /** The most recent session that produced text, whatever its outcome. */
  lastWithText(): RecoveryEntry | null {
    for (let index = this.entries.length - 1; index >= 0; index--) {
      const entry = this.entries[index]
      if (entry?.finalText) return entry
    }
    return null
  }

  /** Newest first. */
  list(): readonly RecoveryEntry[] {
    return [...this.entries].reverse()
  }
}
