import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvaluationRecorder } from '../../src/main/dictation/evaluation-recorder'
import { EvaluationSessions } from '../../src/main/dictation/evaluation-sessions'
import type { RecoveryEntry } from '../../src/main/dictation/recovery-buffer'
import type { SttHost } from '../../src/main/stt/stt-host'
const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-evaluation-'))
  made.push(dir)
  const recorder = new EvaluationRecorder(dir)
  const worker = {
    commitEvaluation: vi.fn(async (session: number) => {
      writeFileSync(recorder.audioPath(session), 'synthetic')
      return 0
    }),
    discardEvaluation: vi.fn(async (_sessions: number[]) => 0),
  }
  const sessions = new EvaluationSessions(recorder, worker as unknown as SttHost)
  return { sessions, dir, recorder, worker }
}

/**
 * The speech process, as far as saving goes, handled as `stt-worker.ts` handles it: one
 * message at a time, in the order sent, each answered in that order. It writes the
 * recording where it was asked to keep it, and forgets where once it is let go.
 */
function setupInOrder() {
  const dir = mkdtempSync(join(tmpdir(), 'flow-evaluation-'))
  made.push(dir)
  const recorder = new EvaluationRecorder(dir)
  const paths = new Map<number, string>()
  const held = new Set<number>()
  const revoked = new Set<number>()
  let queue = Promise.resolve()
  const post = (handle: () => void): void => {
    queue = queue.then(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            handle()
            resolve()
          }, 0),
        ),
    )
  }
  const worker = {
    /** The session began with saving on; its recording ended and is held. */
    keep: (session: number) =>
      post(() => {
        paths.set(session, recorder.audioPath(session))
        held.add(session)
      }),
    releaseEvaluation: (session: number) =>
      post(() => {
        paths.delete(session)
        held.delete(session)
      }),
    commitEvaluation: (session: number) =>
      new Promise<number>((resolve) =>
        post(() => {
          const path = paths.get(session)
          if (revoked.has(session) || !path || !held.has(session)) return resolve(1)
          writeFileSync(path, 'synthetic')
          held.delete(session)
          resolve(0)
        }),
      ),
    discardEvaluation: (ids: number[]) =>
      new Promise<number>((resolve) =>
        post(() => {
          for (const session of ids) {
            revoked.add(session)
            held.delete(session)
            const path = paths.get(session)
            if (path) rmSync(path, { force: true })
            paths.delete(session)
          }
          resolve(0)
        }),
      ),
  }
  const sessions = new EvaluationSessions(recorder, worker as unknown as SttHost)
  return { sessions, dir, worker }
}
/** How a session ended, as the session controller records it. */
const ended = (
  sessionId: number,
  outcome: RecoveryEntry['outcome'],
  rawText: string | null,
  interrupted = false,
): RecoveryEntry => ({
  sessionId,
  endedAt: 0,
  outcome,
  rawText,
  finalText: rawText,
  ...(interrupted ? { interrupted: true as const } : {}),
})
const heardFile = (t: ReturnType<typeof setup>): string => {
  const name = readdirSync(t.dir).find((file) => file.endsWith('.heard.txt'))
  return name ? readFileSync(join(t.dir, name), 'utf8') : ''
}

describe('which dictations "Save every dictation" saves (QA-03/04)', () => {
  it('never saves a dictation into one of the app’s own windows, even with saving on', async () => {
    const t = setup()
    t.sessions.begin(1, true, true)
    t.sessions.note(ended(1, 'pasted', 'synthetic'))
    await t.sessions.release(1)
    expect(readdirSync(t.dir).length).toBe(0)
    expect(t.worker.commitEvaluation).not.toHaveBeenCalled()
  })
  it('does not save a session that began before saving was switched on', async () => {
    const t = setup()
    t.sessions.begin(1, false, false)
    t.sessions.begin(2, true, false)
    t.sessions.note(ended(1, 'pasted', 'synthetic'))
    await t.sessions.release(1)
    expect(t.worker.commitEvaluation).not.toHaveBeenCalled()
  })
  it('Stop Saving takes back the sessions under way, and their partial files', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    writeFileSync(t.recorder.audioPath(1), 'synthetic')
    await t.sessions.stop()
    t.sessions.note(ended(1, 'pasted', 'synthetic'))
    await t.sessions.release(1)
    expect(readdirSync(t.dir).length).toBe(0)
    expect(t.worker.discardEvaluation).toHaveBeenCalledWith([1])
  })
  it('keeps the recordings already saved when saving stops', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    t.sessions.note(ended(1, 'pasted', 'synthetic'))
    await t.sessions.release(1)
    await t.sessions.stop()
    expect(readdirSync(t.dir).length).toBe(3)
  })
  it('Stop Saving while a recording is being written takes it back, and writes no text after it', async () => {
    const t = setupInOrder()
    t.sessions.begin(1, true, false)
    t.worker.keep(1)
    t.sessions.note(ended(1, 'pasted', 'synthetic'))

    // The session is over: saved, and let go, in the same moment (`forgetRecording`).
    const release = t.sessions.release(1)
    t.worker.releaseEvaluation(1)
    // Stop Saving, before the save has been answered.
    const stop = t.sessions.stop()
    await release

    expect(await stop).toBe(0)
    expect(readdirSync(t.dir)).toEqual([])
  })

  it('Delete Everything while a recording is being written takes that one too', async () => {
    const t = setupInOrder()
    t.sessions.begin(1, true, false)
    t.worker.keep(1)
    t.sessions.note(ended(1, 'pasted', 'synthetic'))

    const release = t.sessions.release(1)
    t.worker.releaseEvaluation(1)
    const purge = t.sessions.purge()
    await release

    expect(await purge).toBe(0)
    expect(readdirSync(t.dir)).toEqual([])
  })
  it('a session left out once stays left out', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    await t.sessions.exclude(1)
    t.sessions.note(ended(1, 'pasted', 'synthetic'))
    await t.sessions.release(1)
    expect(t.sessions.forSession(1)).toBe(null)
    expect(t.worker.commitEvaluation).not.toHaveBeenCalled()
  })
  it('Delete Everything also removes recordings already saved', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    t.sessions.note(ended(1, 'pasted', 'synthetic'))
    await t.sessions.release(1)
    await t.sessions.purge()
    expect(readdirSync(t.dir).length).toBe(0)
  })
})

describe('what is saved of a session, decided when it is over', () => {
  it('saves the text of a dictation that Undo brought back after a cancel', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    t.sessions.note(ended(1, 'cancelled', null))
    t.sessions.note(ended(1, 'pasted', 'brought back'))
    await t.sessions.release(1)
    expect(readdirSync(t.dir).length).toBe(3)
    expect(heardFile(t)).toBe('brought back\n')
  })
  it('saves the text of a dictation that Retry brought back after a failed decode', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    t.sessions.note(ended(1, 'failed', null))
    t.sessions.note(ended(1, 'targetChanged', 'tried again'))
    await t.sessions.release(1)
    expect(heardFile(t)).toBe('tried again\n')
  })
  it('saves nothing of a cancel that was not taken back, and keeps no lease for it', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    t.sessions.note(ended(1, 'cancelled', 'heard before the cancel'))
    await t.sessions.release(1)
    expect(t.worker.commitEvaluation).not.toHaveBeenCalled()
    expect(t.sessions.forSession(1)).toBe(null)
  })
  it('saves a recording in which no speech was heard, with nothing beside it to correct', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    t.sessions.note(ended(1, 'noSpeech', null))
    await t.sessions.release(1)
    expect(readdirSync(t.dir).length).toBe(3)
    expect(heardFile(t)).toBe('\n')
  })
  it('saves a dictation the Mac interrupted, with the text that was kept of it', async () => {
    const t = setup()
    t.sessions.begin(1, true, false)
    t.sessions.note(ended(1, 'cancelled', 'kept for recovery', true))
    await t.sessions.release(1)
    expect(heardFile(t)).toBe('kept for recovery\n')
  })
  it('says so, once, when the recording is not there to save, and keeps no lease for it', async () => {
    const t = setup()
    t.worker.commitEvaluation.mockResolvedValue(1)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.sessions.begin(1, true, false)
    t.sessions.note(ended(1, 'pasted', 'synthetic'))
    await t.sessions.release(1)
    expect(logged).toHaveBeenCalledTimes(1)
    expect(t.sessions.forSession(1)).toBe(null)
    logged.mockRestore()
  })
})
