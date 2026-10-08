import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptEvent } from '@shared/stt-protocol'
const mock = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }))
vi.mock('../../src/main/stt/stt-worker?modulePath', () => ({ default: 'fake-worker' }))
import { SttHost, WorkerLostError } from '../../src/main/stt/stt-host'

/** The speech process, as far as the host can see it: messages in and out. */
class Child extends EventEmitter {
  readonly stdout = null
  readonly stderr = null
  readonly pid = 1
  postMessage(): void {}
  kill(): void {
    this.emit('exit', 0)
  }
}
const final = (session: number): TranscriptEvent => ({
  t: 'final',
  session,
  text: 'synthetic',
  noSpeech: false,
  audioMs: 1000,
  decodeMs: 10,
  chunks: 1,
  lostFrames: 0,
  peakDb: -20,
  levelDb: -30,
})

describe('the speech host after Delete Everything (QA-05)', () => {
  it('keeps no result that arrives late for a session that was deleted', async () => {
    const child = new Child()
    mock.fork.mockReturnValue(child)
    const host = new SttHost()
    const started = host.start()
    child.emit('message', { t: 'ready' })
    await started

    // Arrived before anyone asked: held, until Delete Everything says otherwise.
    child.emit('message', final(2))
    host.discardThrough(3)
    child.emit('message', final(3))
    const signal = new AbortController().signal
    await expect(host.transcript(2, signal, 20)).rejects.toThrow()
    await expect(host.transcript(3, signal, 20)).rejects.toThrow()

    // A session after the deletion is answered as before.
    child.emit('message', final(4))
    await expect(host.transcript(4, signal, 20)).resolves.toMatchObject({ session: 4 })
    host.stop()
  })
})

describe('stopping the speech worker (Sp-F8)', () => {
  it('tells whatever is waiting on it at once, though it reports no exit', async () => {
    const child = new Child()
    mock.fork.mockReturnValue(child)
    const host = new SttHost()
    const started = host.start()
    child.emit('message', { t: 'ready' })
    await started
    const loading = host.load('model', 4, 1_000).catch((error: unknown) => error)
    const saving = host.commitEvaluation(3)
    const later = (): Promise<string> =>
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200))

    host.stop()

    expect(await Promise.race([loading, later()])).toBeInstanceOf(WorkerLostError)
    // Not saved: the worker that held the recording is gone.
    expect(await Promise.race([saving, later()])).toBe(1)
  })
})
