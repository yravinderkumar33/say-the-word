import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { EventEmitter } from 'node:events'
import { IPC } from '@shared/ipc'
import { PRODUCT_NAME } from '@shared/product'
import type { TranscriptEvent, WorkerControl, WorkerEvent } from '@shared/stt-protocol'
import workerPath from './stt-worker?modulePath'

interface SttHostEvents {
  event: [WorkerEvent]
  /** The worker process died on its own. Not emitted when `stop()` ended it. */
  exit: [code: number]
}

type SessionResult = Extract<WorkerEvent, { t: 'final' | 'failed' }>

/** The worker process died while something was waiting on it. */
export class WorkerLostError extends Error {
  constructor(message = 'The speech worker stopped unexpectedly') {
    super(message)
    this.name = 'WorkerLostError'
  }
}

/** How many finished sessions' results are held for a caller that asks late. */
const KEPT_RESULTS = 4

/**
 * Owns the speech worker: an Electron utility process, so recognition never blocks
 * the main process and a native crash cannot take the app down.
 */
export class SttHost extends EventEmitter<SttHostEvents> {
  private child: UtilityProcess | null = null
  private whenReady: Promise<void> | null = null
  private loadedEngine: string | null = null
  /** Workers ended on purpose; their exit is not a failure. */
  private readonly stopped = new WeakSet<UtilityProcess>()
  /**
   * Fired when the worker in hand is stopped on purpose. Such a worker reports no exit,
   * so whatever still waits on it listens for this too, and is told at once rather than
   * at the end of its timeout.
   */
  private stopping = new AbortController()
  /**
   * Results that arrived before anyone asked for them. A recording can end on its own
   * (the microphone goes away), and its transcript may then beat the request for it.
   */
  private readonly results = new Map<number, SessionResult>()
  /** Sessions up to this one were deleted (Delete Everything): a result for one is not kept. */
  private discardedThrough = 0
  /** Numbers the evaluation requests, so that each answer is matched to its request. */
  private evaluationRequest = 0

  get running(): boolean {
    return this.child !== null
  }

  /** The worker's process id, or null while it is not running. */
  get pid(): number | null {
    return this.child?.pid ?? null
  }

  /** The loaded engine's id, or null while no model is loaded. */
  get engine(): string | null {
    return this.loadedEngine
  }

  /** Starts the worker process. Resolves once it reports `ready`. */
  start(timeoutMs = 10_000): Promise<void> {
    if (this.child && this.whenReady) return this.whenReady
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: `${PRODUCT_NAME} Speech`,
      stdio: 'pipe',
    })
    this.child = child
    this.stopping = new AbortController()

    this.whenReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`speech worker was not ready within ${timeoutMs} ms`))
        // A worker that never reported ready is not kept. Left in place, every later
        // start would be handed this same failure until the app was restarted.
        if (this.child !== child) return
        this.stopped.add(child)
        this.child = null
        this.whenReady = null
        child.kill()
      }, timeoutMs)
      child.stdout?.on('data', (text: Buffer) => console.log(`[stt] ${text.toString().trimEnd()}`))
      child.stderr?.on('data', (text: Buffer) =>
        console.error(`[stt] ${text.toString().trimEnd()}`),
      )
      child.on('message', (event: WorkerEvent) => {
        if (this.child !== child) return
        if (event.t === 'ready') {
          clearTimeout(timer)
          resolve()
        } else if (event.t === 'loaded') {
          this.loadedEngine = event.engine
        } else if (event.t === 'final' || event.t === 'failed') {
          this.remember(event)
        }
        this.emit('event', event)
      })
      child.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`speech worker exited with code ${code}`))
        // A worker that was stopped on purpose may be outlived by its replacement.
        if (this.child !== child) return
        this.child = null
        this.whenReady = null
        this.loadedEngine = null
        this.results.clear()
        if (!this.stopped.has(child)) this.emit('exit', code)
      })
    })
    // The caller that started it sees the failure; later callers share the promise.
    this.whenReady.catch(() => {})
    return this.whenReady
  }

  /** Loads the speech model. Takes about a second and roughly 1.9 GB of memory. */
  load(modelDir: string, numThreads: number, timeoutMs = 60_000): Promise<{ loadMs: number }> {
    return new Promise((resolve, reject) => {
      const stopping = this.stopping.signal
      const done = (event: WorkerEvent): void => {
        if (event.t === 'loaded') {
          cleanup()
          resolve({ loadMs: event.loadMs })
        } else if (event.t === 'loadFailed') {
          cleanup()
          reject(new Error(event.message))
        }
      }
      const onExit = (): void => {
        cleanup()
        reject(new WorkerLostError('The speech worker stopped while loading the model'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`the speech model did not load within ${timeoutMs} ms`))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('event', done)
        this.off('exit', onExit)
        stopping.removeEventListener('abort', onExit)
      }
      this.on('event', done)
      this.on('exit', onExit)
      stopping.addEventListener('abort', onExit)
      try {
        this.post({ t: 'load', modelDir, numThreads })
      } catch (error) {
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  begin(session: number): void {
    if (this.child) this.post({ t: 'begin', session })
  }

  cancel(session: number): void {
    this.results.delete(session)
    if (this.child) this.post({ t: 'cancel', session })
  }

  /**
   * Everything said up to this session has been deleted. Results already held go, and one
   * still on its way for such a session is not kept when it arrives.
   */
  discardThrough(session: number): void {
    this.discardedThrough = Math.max(this.discardedThrough, session)
    for (const id of [...this.results.keys()]) if (id <= session) this.results.delete(id)
  }

  /**
   * Drops a result kept for this session. Undo and Retry decode a session again under
   * the same id, and must not be handed what was left from the first attempt.
   */
  forgetResult(session: number): void {
    this.results.delete(session)
  }

  /** Evaluation mode: has the worker write the session's recording to `path` when it ends. */
  saveAudio(session: number, path: string): void {
    if (this.child) this.post({ t: 'saveAudio', session, path })
  }

  releaseEvaluation(session: number): void {
    if (this.child) this.post({ t: 'releaseEvaluation', session })
  }

  commitEvaluation(session: number): Promise<number> {
    return this.evaluationOperation({
      t: 'commitEvaluation',
      session,
      request: ++this.evaluationRequest,
    })
  }
  discardEvaluation(sessions: number[]): Promise<number> {
    return this.evaluationOperation({
      t: 'discardEvaluation',
      sessions,
      request: ++this.evaluationRequest,
    })
  }
  private evaluationOperation(
    control: Extract<WorkerControl, { t: 'commitEvaluation' | 'discardEvaluation' }>,
  ): Promise<number> {
    if (!this.child) return Promise.resolve(control.t === 'commitEvaluation' ? 1 : 0)
    return new Promise((resolve) => {
      const stopping = this.stopping.signal
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('event', done)
        this.off('exit', gone)
        stopping.removeEventListener('abort', gone)
      }
      const done = (event: WorkerEvent): void => {
        if (event.t === 'evaluationDone' && event.request === control.request) {
          cleanup()
          resolve(event.failed)
        }
      }
      const gone = (): void => {
        cleanup()
        resolve(control.t === 'commitEvaluation' ? 1 : 0)
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(1)
      }, 5_000)
      this.on('event', done)
      this.on('exit', gone)
      stopping.addEventListener('abort', gone)
      this.post(control)
    })
  }

  /**
   * Resolves with the session's transcript. Rejects if the worker reports a failure,
   * dies (`WorkerLostError`), takes too long, or the signal aborts (the session was
   * cancelled).
   */
  transcript(session: number, signal: AbortSignal, timeoutMs: number): Promise<TranscriptEvent> {
    return new Promise((resolve, reject) => {
      const settle = (event: SessionResult): void => {
        this.results.delete(session)
        if (event.t === 'final') resolve(event)
        else reject(new Error(event.message))
      }
      if (signal.aborted) {
        reject(new Error('cancelled'))
        return
      }
      const early = this.results.get(session)
      if (early) {
        settle(early)
        return
      }

      const stopping = this.stopping.signal
      const onEvent = (event: WorkerEvent): void => {
        if ((event.t !== 'final' && event.t !== 'failed') || event.session !== session) return
        cleanup()
        settle(event)
      }
      const onExit = (): void => {
        cleanup()
        reject(new WorkerLostError())
      }
      const onAbort = (): void => {
        cleanup()
        reject(new Error('cancelled'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('The recognizer took too long'))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('event', onEvent)
        this.off('exit', onExit)
        stopping.removeEventListener('abort', onExit)
        signal.removeEventListener('abort', onAbort)
      }
      this.on('event', onEvent)
      this.on('exit', onExit)
      stopping.addEventListener('abort', onExit)
      signal.addEventListener('abort', onAbort)
    })
  }

  /**
   * Gives the renderer a direct line to the worker, so audio frames do not pass
   * through the main process.
   */
  connectRenderer(webContents: WebContents): void {
    const child = this.child
    if (!child) throw new Error('speech worker is not running')
    const { port1, port2 } = new MessageChannelMain()
    const control: WorkerControl = { t: 'port' }
    child.postMessage(control, [port2])
    webContents.postMessage(IPC.sttPort, null, [port1])
  }

  /** Stops the worker, which also frees the model's memory. */
  stop(): void {
    const child = this.child
    if (!child) return
    this.stopped.add(child)
    this.child = null
    this.whenReady = null
    this.loadedEngine = null
    this.results.clear()
    child.kill()
    // A worker stopped on purpose reports no exit, so anything still waiting on it (a
    // transcript, the model's load, a recording to save) is told here instead.
    this.stopping.abort()
  }

  private remember(result: SessionResult): void {
    if (result.session <= this.discardedThrough) return
    this.results.set(result.session, result)
    while (this.results.size > KEPT_RESULTS) {
      const oldest = this.results.keys().next().value
      if (oldest === undefined) break
      this.results.delete(oldest)
    }
  }

  private post(control: WorkerControl): void {
    if (!this.child) throw new Error('speech worker is not running')
    this.child.postMessage(control)
  }
}
