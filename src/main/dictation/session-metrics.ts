/**
 * Timings of one dictation, for the latency gates in `docs/benchmarks.md`.
 * Numbers and outcome names only: nothing here ever holds what was said.
 */
export interface SessionTimings {
  session: number
  outcome: string
  /** Shortcut pressed → audio flowing, as seen by the main process. */
  micLiveMs: number | null
  /** Microphone requested → audio flowing, as measured in the overlay. */
  micOpenMs: number | null
  /** Shortcut pressed → released. */
  heldMs: number | null
  audioMs: number | null
  decodeMs: number | null
  chunks: number | null
  /** Loudest sample and average loudness of the recording, in decibels below full scale. */
  peakDb: number | null
  levelDb: number | null
  /** Shortcut released → text ready. */
  releaseToTextMs: number | null
  /** Shortcut released → paste request sent to the helper. */
  releaseToPasteMs: number | null
  /** Paste request sent → the helper answered. */
  pasteMs: number | null
  /** Cleaned mode: why the final text is what it is (`cleaned`, `timeout`, `guard:invented`…). */
  cleanup: string | null
  /** Cleaned mode: time spent on rules, the model and the guard. */
  cleanupMs: number | null
}

interface Marks {
  startedAt: number
  liveAt: number | null
  micOpenMs: number | null
  releasedAt: number | null
  textAt: number | null
  pasteSentAt: number | null
  pasteDoneAt: number | null
  audioMs: number | null
  decodeMs: number | null
  chunks: number | null
  peakDb: number | null
  levelDb: number | null
  cleanup: string | null
  cleanupMs: number | null
}

const KEPT_SESSIONS = 8

/** Collects the moments of each session as they happen, and turns them into durations. */
export class SessionMetrics {
  private readonly sessions = new Map<number, Marks>()

  started(session: number, now: number): void {
    this.sessions.set(session, {
      startedAt: now,
      liveAt: null,
      micOpenMs: null,
      releasedAt: null,
      textAt: null,
      pasteSentAt: null,
      pasteDoneAt: null,
      audioMs: null,
      decodeMs: null,
      chunks: null,
      peakDb: null,
      levelDb: null,
      cleanup: null,
      cleanupMs: null,
    })
    while (this.sessions.size > KEPT_SESSIONS) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
  }

  live(session: number, now: number, micOpenMs: number): void {
    const marks = this.sessions.get(session)
    if (!marks || marks.liveAt !== null) return
    marks.liveAt = now
    marks.micOpenMs = micOpenMs
  }

  released(session: number, now: number): void {
    const marks = this.sessions.get(session)
    if (marks) marks.releasedAt ??= now
  }

  decoded(
    session: number,
    result: {
      audioMs: number
      decodeMs: number
      chunks: number
      peakDb?: number
      levelDb?: number
    },
  ): void {
    const marks = this.sessions.get(session)
    if (!marks) return
    marks.audioMs = result.audioMs
    marks.decodeMs = result.decodeMs
    marks.chunks = result.chunks
    marks.peakDb = result.peakDb ?? null
    marks.levelDb = result.levelDb ?? null
  }

  cleaned(session: number, note: string, cleanupMs: number): void {
    const marks = this.sessions.get(session)
    if (!marks) return
    marks.cleanup = note
    marks.cleanupMs = cleanupMs
  }

  textReady(session: number, now: number): void {
    const marks = this.sessions.get(session)
    if (marks) marks.textAt ??= now
  }

  pasteSent(session: number, now: number): void {
    const marks = this.sessions.get(session)
    if (marks) marks.pasteSentAt ??= now
  }

  pasteDone(session: number, now: number): void {
    const marks = this.sessions.get(session)
    if (marks) marks.pasteDoneAt ??= now
  }

  /** The session is over: returns its timings and forgets it. */
  finish(session: number, outcome: string): SessionTimings | null {
    const marks = this.sessions.get(session)
    if (!marks) return null
    this.sessions.delete(session)
    const since = (from: number | null, to: number | null): number | null =>
      from === null || to === null ? null : Math.round(to - from)
    return {
      session,
      outcome,
      micLiveMs: since(marks.startedAt, marks.liveAt),
      micOpenMs: marks.micOpenMs === null ? null : Math.round(marks.micOpenMs),
      heldMs: since(marks.startedAt, marks.releasedAt),
      audioMs: marks.audioMs === null ? null : Math.round(marks.audioMs),
      decodeMs: marks.decodeMs === null ? null : Math.round(marks.decodeMs),
      chunks: marks.chunks,
      peakDb: marks.peakDb,
      levelDb: marks.levelDb,
      releaseToTextMs: since(marks.releasedAt, marks.textAt),
      releaseToPasteMs: since(marks.releasedAt, marks.pasteSentAt),
      pasteMs: since(marks.pasteSentAt, marks.pasteDoneAt),
      cleanup: marks.cleanup,
      cleanupMs: marks.cleanupMs,
    }
  }
}

/** One log line: `[metrics] session=3 outcome=pasted micLiveMs=142 …`. Unknown values are left out. */
export function formatTimings(timings: SessionTimings): string {
  const fields = Object.entries(timings)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}=${value}`)
  return `[metrics] ${fields.join(' ')}`
}
