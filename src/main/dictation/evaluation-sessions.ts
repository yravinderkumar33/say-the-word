import { rmSync } from 'node:fs'
import type { SttHost } from '../stt/stt-host'
import type { EvaluationRecorder } from './evaluation-recorder'
import type { RecoveryEntry } from './recovery-buffer'

interface Lease {
  eligible: boolean
  complete: boolean
  /** How the session last ended, and what was heard then. Undo and Retry end it again. */
  ended: { outcome: RecoveryEntry['outcome']; text: string | null; interrupted: boolean } | null
}

/**
 * Which dictations "Save every dictation" saves. Authorization belongs to the recording,
 * never to a later global settings value: a session is saved only if saving was on when
 * it began and it was not dictated into one of the app's own windows.
 *
 * What is saved is decided when the session is over, when its recording is let go, from
 * how it ended last: a dictation is saved with what was heard (nothing, when no speech
 * was heard, which is worth correcting too); a cancel that was not taken back is not.
 */
export class EvaluationSessions {
  private readonly leases = new Map<number, Lease>()
  constructor(
    private readonly recorder: EvaluationRecorder,
    private readonly stt: SttHost,
  ) {}
  begin(session: number, enabled: boolean, internal: boolean): void {
    this.leases.set(session, { eligible: enabled && !internal, complete: false, ended: null })
    // Sessions are let go, and with them their lease; this is for any that never were.
    for (const [id, lease] of this.leases)
      if (id < session - 20 && (lease.complete || !lease.eligible)) this.leases.delete(id)
  }
  forSession(session: number): EvaluationRecorder | null {
    return this.leases.get(session)?.eligible ? this.recorder : null
  }
  /** A session ended, or ended again after Undo or Retry. */
  note(entry: RecoveryEntry): void {
    const lease = this.leases.get(entry.sessionId)
    if (!lease) return
    lease.ended = {
      outcome: entry.outcome,
      text: entry.rawText,
      interrupted: entry.interrupted === true,
    }
  }
  /** The session is over and its recording let go: it is saved now, or not at all. */
  async release(session: number): Promise<void> {
    const lease = this.leases.get(session)
    if (!lease) return
    const ended = lease.ended
    const kept = ended !== null && (ended.outcome !== 'cancelled' || ended.interrupted)
    if (!lease.eligible || lease.complete || !kept) {
      this.leases.delete(session)
      return
    }
    try {
      if (await this.stt.commitEvaluation(session)) throw new Error('Evaluation audio unavailable')
      // Saving was stopped, or everything deleted, while the recording was being written:
      // that took the recording away again, and the text is not written after it.
      if (!lease.eligible) return
      this.recorder.saveText(session, ended.text ?? '')
      lease.complete = true
    } catch {
      console.error('[evaluation] recording could not be saved')
    } finally {
      // Kept until here, so that Stop Saving during the write can still take it back; a
      // saved one is kept longer, for Delete Everything, and goes with the old ones.
      if (this.leases.get(session) === lease && !lease.complete) this.leases.delete(session)
    }
  }
  exclude(session: number): Promise<number> {
    return this.revoke([session])
  }
  stop(): Promise<number> {
    return this.revoke([...this.leases].filter(([, lease]) => !lease.complete).map(([id]) => id))
  }
  async purge(): Promise<number> {
    const result = await this.revoke([...this.leases.keys()])
    this.leases.clear()
    return result
  }
  /** Sessions whose saving is to stop. They are marked at once, before anything is awaited. */
  private async revoke(sessions: number[]): Promise<number> {
    for (const session of sessions) {
      const lease = this.leases.get(session)
      if (lease) lease.eligible = false
    }
    let failed = await this.stt.discardEvaluation(sessions)
    // Each of them, also one whose lease has gone in the meantime: a save that was under
    // way lets its lease go when its answer comes, which is before this one, and the
    // worker has by then written its recording and forgotten where.
    for (const session of sessions)
      for (const path of this.recorder.paths(session))
        try {
          rmSync(path, { force: true })
        } catch {
          failed++
        }
    return failed
  }
}
