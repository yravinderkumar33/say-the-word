import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC, type CaptureCommand } from '@shared/ipc'
import type { TranscriptEvent } from '@shared/stt-protocol'

/** The pages' messages, as the main process would pass them on. */
const fromPages = vi.hoisted(() => new Map<string, (payload: unknown) => void>())
/** Reading every file of the model again, which takes a while for 1.9 GB. */
const verifyModel = vi.hoisted(() =>
  vi.fn(() => Promise.resolve({ ok: true, missing: [] as string[], damaged: [] as string[] })),
)
vi.mock('../../src/main/security', () => ({
  listenFromOwnPages: (channel: string, listener: (payload: unknown) => void) =>
    fromPages.set(channel, listener),
}))
vi.mock('../../src/main/stt/stt-host', () => ({ WorkerLostError: class extends Error {} }))
vi.mock('../../src/main/stt/model-store', () => ({
  adoptModel: () => Promise.resolve({ ready: true }),
  modelDir: () => 'model',
  verifyModel,
}))
import { RecordingGoneError } from '../../src/main/dictation/session-controller'
import { SpeechService } from '../../src/main/dictation/speech-service'
import { WorkerLostError, type SttHost } from '../../src/main/stt/stt-host'

afterEach(() => {
  vi.restoreAllMocks()
  verifyModel.mockClear()
})

/** The speech worker as the service sees it: each wait for a transcript is kept, unanswered. */
class Worker extends EventEmitter {
  readonly waits: Array<{ session: number; signal: AbortSignal }> = []
  readonly cancel = vi.fn()
  /** The model's load, which a test may hold or fail. */
  load = (): Promise<{ loadMs: number }> => Promise.resolve({ loadMs: 1 })
  /** What stopping the worker does to a load still under way. */
  onStop = (): void => {}
  start = (): Promise<void> => Promise.resolve()
  stop(): void {
    this.onStop()
  }
  connectRenderer(): void {}
  forgetResult(): void {}
  transcript(session: number, signal: AbortSignal): Promise<TranscriptEvent> {
    this.waits.push({ session, signal })
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    })
  }
}

function setup() {
  const worker = new Worker()
  const sent: CaptureCommand[] = []
  const overlay = {
    isDestroyed: () => false,
    webContents: {
      on: () => {},
      send: (_channel: string, command: CaptureCommand) => sent.push(command),
    },
  }
  const speech = new SpeechService({
    stt: worker as unknown as SttHost,
    overlay: overlay as never,
    modelsRoot: 'models',
    microphoneId: () => null,
    maxRecordingMs: () => 60_000,
    idleUnloadMs: () => null,
    onLive: () => {},
    onRecordingFailed: () => {},
    onRecordingEnded: () => {},
  })
  return { speech, worker, sent }
}

describe('Undo and Retry in the speech service', () => {
  it('stop the decode, in the worker and in the overlay, when they are cancelled in turn', async () => {
    const t = setup()
    await t.speech.prepare()
    const cancel = new AbortController()
    const text = t.speech.reproduceText({ id: 3, signal: cancel.signal })

    // Escape during the Undo.
    cancel.abort()

    await expect(text).rejects.toThrow()
    expect(t.worker.cancel).toHaveBeenCalledWith(3)
    expect(t.sent).toContainEqual({ kind: 'cancel', session: 3 })
    // The recording itself stays held, for another Undo.
    expect(t.sent).not.toContainEqual({ kind: 'release', session: 3 })
  })

  it('stop waiting for a text when the recording turns out to be gone', async () => {
    const t = setup()
    await t.speech.prepare()
    const text = t.speech.reproduceText({ id: 4, signal: new AbortController().signal })

    // The overlay no longer holds it: nothing will be decoded.
    fromPages.get(IPC.captureEvent)?.({ kind: 'gone', session: 4 })

    await expect(text).rejects.toBeInstanceOf(RecordingGoneError)
    expect(t.worker.waits).toHaveLength(1)
    expect(t.worker.waits[0]?.signal.aborted).toBe(true)
  })
})

describe('a load of the model that does not finish', () => {
  it('is no failure when the app quits under it: nothing is read or said', async () => {
    const t = setup()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    let loading!: (reason: Error) => void
    t.worker.load = () => new Promise((_resolve, reject) => (loading = reject))
    // Stopping the worker on purpose answers its load at once.
    t.worker.onStop = () => loading(new WorkerLostError('stopped while loading'))
    const prepared = t.speech.prepare()
    await vi.waitFor(() => expect(loading).toBeTypeOf('function'))

    t.speech.stop()
    await prepared

    expect(verifyModel).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
  })

  it('does not read the model again for a worker that was lost on the way', async () => {
    const t = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    t.worker.load = () => Promise.reject(new WorkerLostError('stopped while loading'))

    await t.speech.prepare()

    expect(verifyModel).not.toHaveBeenCalled()
  })

  it('reads the model again when the load itself failed, which damaged files can cause', async () => {
    const t = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    t.worker.load = () => Promise.reject(new Error('the model could not be read'))

    expect(await t.speech.prepare()).toBe('failed')
    expect(verifyModel).toHaveBeenCalledTimes(1)
  })
})
