import type { BrowserWindow } from 'electron'
import { IPC, captureEventSchema, type CaptureCommand, type SpeechState } from '@shared/ipc'
import type { TranscriptEvent } from '@shared/stt-protocol'
import { listenFromOwnPages } from '../security'
import { DEFAULT_MODEL, type ModelSpec } from '../stt/model-catalog'
import { downloadModel, isModelReady, modelDir } from '../stt/model-store'
import { WorkerLostError, type SttHost } from '../stt/stt-host'
import type { EvaluationRecorder } from './evaluation-recorder'
import { RecordingGoneError, type ProducedText, type SessionHandle } from './session-controller'

/** Four threads matched the machine's four performance cores in the benchmark. */
const DECODE_THREADS = 4
/** Generous: a 30 s chunk decodes in well under a second. This only catches a hang. */
const TRANSCRIPT_TIMEOUT_MS = 30_000
/**
 * Extra waiting time per millisecond recorded. Normally only the tail of a recording is
 * left to decode when it stops, but a worker that was lost on the way has to be given
 * the whole of it again: about 1.7 s per minute on the development machine, so a
 * tenth of the recording's length leaves a wide margin.
 */
const TRANSCRIPT_TIMEOUT_PER_RECORDED_MS = 0.1
/** A recording is stopped here, and what was said up to then is used. */
export const MAX_RECORDING_MS = 20 * 60_000
/** The user is told this long before the limit. */
export const LIMIT_WARNING_MS = 60_000
/** The model holds about 1.9 GB of memory, so it is let go after a while without dictation. */
const IDLE_UNLOAD_MS = 10 * 60_000
const WORKER_RESTART_MS = 1_000
/** After this many crashes in a row the worker is left alone until the next dictation. */
const MAX_CRASHES = 3

export const MODEL_MISSING_MESSAGE = 'The speech model is not downloaded yet'
const NOT_STARTED_MESSAGE = 'Speech recognition could not start'

export interface SpeechServiceDeps {
  stt: SttHost
  overlay: BrowserWindow
  modelsRoot: string
  model?: ModelSpec
  microphoneId(): string | null
  /** How long a recording may run before it is stopped. */
  maxRecordingMs?(): number
  /** Evaluation mode: where dictations are saved, or null while the mode is off. */
  evaluation?(): EvaluationRecorder | null
  /** Tests only: return true to make the next transcript fail, with the recording kept. */
  failNextTranscript?(): boolean
  /** Audio has started to flow for a session. `openMs` is how long the microphone took. */
  onLive(session: number, openMs: number): void
  onRecordingFailed(session: number, message: string): void
  /** The recording ended by itself. */
  onRecordingEnded(session: number, reason: 'microphoneLost' | 'limit'): void
  /** The recording will be stopped in a minute. */
  onLimitSoon?(session: number): void
  /** Timings of a finished transcript, for the latency log. */
  onTranscript?(session: number, result: TranscriptEvent): void
  onStateChange?(state: SpeechState): void
  idleUnloadMs?: number
}

/**
 * Everything between "a session started" and "here is its text": the microphone in
 * the overlay, the speech worker, and the model on disk.
 */
export class SpeechService {
  readonly model: ModelSpec
  private current: SpeechState = 'stopped'
  private loading: Promise<SpeechState> | null = null
  private download: { progress: number; error: string | null } | null = null
  private crashes = 0
  private quitting = false
  private idleTimer: NodeJS.Timeout | null = null
  /** Sessions being recorded or turned into text. The model is not unloaded under them. */
  private readonly inHand = new Set<number>()
  /** Undo and Retry waiting for a recording, to be told if the overlay no longer has it. */
  private readonly whenGone = new Map<number, () => void>()
  private limitTimer: NodeJS.Timeout | null = null
  private warningTimer: NodeJS.Timeout | null = null
  /** When each recent session began, and once it has stopped, how long it ran. */
  private readonly startedAt = new Map<number, number>()
  private readonly recordedMs = new Map<number, number>()

  constructor(private readonly deps: SpeechServiceDeps) {
    this.model = deps.model ?? DEFAULT_MODEL

    listenFromOwnPages(IPC.captureEvent, (payload) => {
      const parsed = captureEventSchema.safeParse(payload)
      if (!parsed.success) return
      const capture = parsed.data
      if (capture.kind === 'live') deps.onLive(capture.session, capture.openMs)
      else if (capture.kind === 'failed') deps.onRecordingFailed(capture.session, capture.message)
      else if (capture.kind === 'gone') this.whenGone.get(capture.session)?.()
      else if (capture.micLost) deps.onRecordingEnded(capture.session, 'microphoneLost')
    })

    // A worker that dies is started again. The overlay still holds the audio of the
    // session in progress and sends it to the new worker when its port arrives.
    deps.stt.on('event', (event) => {
      if (event.t === 'audioSaveFailed') {
        console.error(`[speech] could not save the evaluation recording: ${event.message}`)
      }
    })

    deps.stt.on('exit', () => {
      this.setState('stopped')
      if (this.quitting) return
      this.crashes += 1
      if (this.crashes >= MAX_CRASHES) {
        console.error('[speech] the worker keeps stopping; waiting for the next dictation')
        this.setState('failed')
        return
      }
      console.error('[speech] the worker stopped unexpectedly; restarting it')
      setTimeout(() => void this.prepare(), WORKER_RESTART_MS)
    })

    // A reloaded page has lost its port; give it a new one.
    deps.overlay.webContents.on('did-finish-load', () => {
      if (this.current === 'ready') deps.stt.connectRenderer(deps.overlay.webContents)
    })
  }

  get state(): SpeechState {
    return this.current
  }

  get downloadProgress(): number | null {
    return this.download && !this.download.error ? this.download.progress : null
  }

  get downloadError(): string | null {
    return this.download?.error ?? null
  }

  modelDownloaded(): Promise<boolean> {
    return isModelReady(this.deps.modelsRoot, this.model)
  }

  /** Starts the worker, loads the model, and connects the overlay to it. */
  prepare(): Promise<SpeechState> {
    if (this.current === 'ready') return Promise.resolve(this.current)
    this.loading ??= this.load().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  /** Downloads the model, then loads it. Progress is visible through `downloadProgress`. */
  async downloadModel(): Promise<void> {
    if (this.download && !this.download.error) return
    const download = { progress: 0, error: null as string | null }
    this.download = download
    try {
      await downloadModel(this.deps.modelsRoot, this.model, {
        onProgress: ({ overallBytes, overallTotal }) => {
          download.progress = overallBytes / overallTotal
        },
      })
      this.download = null
      await this.prepare()
    } catch (error) {
      download.error = error instanceof Error ? error.message : String(error)
      console.error('[speech] model download failed:', download.error)
    }
  }

  startRecording(session: SessionHandle): void {
    if (this.current === 'modelMissing') {
      // The files may have arrived by another route since this was last looked at
      // (the download command, another build that shares the folder): looked at again
      // now, so that the next dictation works without restarting the app.
      void this.prepare()
      // Reported on the next tick, after the controller has finished starting the session.
      queueMicrotask(() => this.deps.onRecordingFailed(session.id, MODEL_MISSING_MESSAGE))
      return
    }
    this.startedAt.set(session.id, Date.now())
    for (const id of this.startedAt.keys()) if (id < session.id - 8) this.startedAt.delete(id)
    for (const id of this.recordedMs.keys()) if (id < session.id - 8) this.recordedMs.delete(id)
    // If the model is not loaded (it is unloaded when idle), recording starts anyway:
    // the overlay keeps the audio and sends it once the worker is listening.
    if (this.current === 'ready') this.deps.stt.begin(session.id)
    else void this.prepare()
    this.inHand.add(session.id)
    this.keepLoaded()
    this.askForAudio(session.id)

    this.send({ kind: 'start', session: session.id, deviceId: this.deps.microphoneId() })
    const limit = this.deps.maxRecordingMs?.() ?? MAX_RECORDING_MS
    this.clearLimit()
    this.limitTimer = setTimeout(() => this.deps.onRecordingEnded(session.id, 'limit'), limit)
    if (limit > LIMIT_WARNING_MS) {
      this.warningTimer = setTimeout(
        () => this.deps.onLimitSoon?.(session.id),
        limit - LIMIT_WARNING_MS,
      )
    }
    session.signal.addEventListener(
      'abort',
      () => {
        this.inHand.delete(session.id)
        this.clearLimit()
        this.send({ kind: 'cancel', session: session.id })
        this.deps.stt.cancel(session.id)
      },
      { once: true },
    )
  }

  /** Stops the recording and resolves with its text, or null when there was no speech. */
  async produceText(session: SessionHandle): Promise<ProducedText | null> {
    this.clearLimit()
    const started = this.startedAt.get(session.id)
    if (started !== undefined) this.recordedMs.set(session.id, Date.now() - started)
    // Asked again here: a worker restarted since the session began has forgotten.
    const recorder = this.askForAudio(session.id)
    // The microphone is let go at once, whatever state the recognizer is in.
    this.send({ kind: 'stop', session: session.id })
    return this.textOf(session, recorder)
  }

  /**
   * Undo or Retry: transcribes the recording the overlay still holds for this session.
   * Resolves null when there was no speech; rejects if the recording is gone.
   */
  async reproduceText(session: SessionHandle): Promise<ProducedText | null> {
    this.keepLoaded()
    const gone = new Promise<never>((_resolve, reject) => {
      this.whenGone.set(session.id, () => reject(new RecordingGoneError()))
    })
    try {
      // The session is decoded again under the same id: whatever the first attempt
      // left behind must not be taken for the new result.
      this.deps.stt.forgetResult(session.id)
      const text = this.textOf(session, null)
      // If the recording turns out to be gone, nobody is left waiting for this one.
      text.catch(() => {})
      this.send({ kind: 'resend', session: session.id })
      return await Promise.race([text, gone])
    } finally {
      this.whenGone.delete(session.id)
    }
  }

  /** The recording of this session will not be asked for again. */
  forget(sessionId: number): void {
    this.send({ kind: 'release', session: sessionId })
  }

  private async textOf(
    session: SessionHandle,
    recorder: EvaluationRecorder | null,
  ): Promise<ProducedText | null> {
    this.inHand.add(session.id)
    try {
      if (this.deps.failNextTranscript?.()) throw new Error('The recognizer took too long')
      const result = await this.transcript(session)
      this.crashes = 0
      this.deps.onTranscript?.(session.id, result)
      if (result.lostFrames > 0) {
        console.error(`[speech] session ${session.id}: ${result.lostFrames} audio frames were lost`)
      }
      // The text has arrived: the overlay need not hold the recording any longer.
      this.forget(session.id)
      if (result.noSpeech || result.text.length === 0) return null
      try {
        recorder?.saveText(session.id, result.text)
      } catch (error) {
        // Evaluation mode is a side job: a full disk must not cost the dictation.
        console.error(
          '[speech] could not save the evaluation text:',
          error instanceof Error ? error.message : error,
        )
      }
      return { raw: result.text, final: result.text }
    } finally {
      this.inHand.delete(session.id)
      // After a failure or a cancel the recording stays held, for Retry or Undo.
      this.keepLoaded()
    }
  }

  /** Frees the model's memory. The next dictation loads it again. */
  unload(): void {
    if (this.current !== 'ready') return
    if (this.inHand.size > 0) {
      // A recording can run longer than the idle time. Stopping the worker now would
      // throw away what it has heard so far, so the countdown starts over instead.
      this.keepLoaded()
      return
    }
    this.deps.stt.stop()
    this.setState('stopped')
    console.log('[speech] model unloaded')
  }

  stop(): void {
    this.quitting = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.clearLimit()
    this.deps.stt.stop()
  }

  private async load(): Promise<SpeechState> {
    this.setState('loading')
    try {
      if (!(await this.modelDownloaded())) return this.setState('modelMissing')
      await this.deps.stt.start()
      const { loadMs } = await this.deps.stt.load(
        modelDir(this.deps.modelsRoot, this.model),
        DECODE_THREADS,
      )
      // Only now can the worker take audio, so only now does the overlay get its port.
      this.deps.stt.connectRenderer(this.deps.overlay.webContents)
      console.log(`[speech] model loaded in ${loadMs.toFixed(0)} ms`)
      this.keepLoaded()
      return this.setState('ready')
    } catch (error) {
      console.error('[speech] could not start:', error instanceof Error ? error.message : error)
      // A worker lost mid-load has already been reported, and is being restarted.
      return error instanceof WorkerLostError ? this.current : this.setState('failed')
    }
  }

  private async transcript(session: SessionHandle): Promise<TranscriptEvent> {
    for (let attempt = 0; ; attempt++) {
      if (this.current !== 'ready' && (await this.prepare()) !== 'ready') {
        // `stopped` here means the worker went away while the model was loading. That
        // is the same loss as one during the decode, and gets the same single retry.
        const lostWhileLoading = this.current === 'stopped' && !session.signal.aborted
        if (lostWhileLoading && attempt === 0) continue
        throw new Error(
          this.current === 'modelMissing' ? MODEL_MISSING_MESSAGE : NOT_STARTED_MESSAGE,
        )
      }
      try {
        return await this.deps.stt.transcript(
          session.id,
          session.signal,
          this.transcriptTimeout(session.id),
        )
      } catch (error) {
        // If the worker died, it is started again and the overlay sends the session's
        // audio to the new one. That is tried once.
        const retry = error instanceof WorkerLostError && attempt === 0 && !session.signal.aborted
        if (!retry) throw error
      }
    }
  }

  /** How long to wait for a session's text: longer for a longer recording. */
  private transcriptTimeout(session: number): number {
    const recorded = this.recordedMs.get(session) ?? 0
    return TRANSCRIPT_TIMEOUT_MS + Math.round(recorded * TRANSCRIPT_TIMEOUT_PER_RECORDED_MS)
  }

  /** In evaluation mode, has the worker save this session's recording when it ends. */
  private askForAudio(session: number): EvaluationRecorder | null {
    const recorder = this.deps.evaluation?.() ?? null
    if (recorder) this.deps.stt.saveAudio(session, recorder.audioPath(session))
    return recorder
  }

  private setState(state: SpeechState): SpeechState {
    if (this.current !== state) {
      this.current = state
      this.deps.onStateChange?.(state)
    }
    return state
  }

  /** Restarts the countdown to unloading the model. */
  private keepLoaded(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => this.unload(), this.deps.idleUnloadMs ?? IDLE_UNLOAD_MS)
    this.idleTimer.unref()
  }

  private clearLimit(): void {
    if (this.limitTimer) clearTimeout(this.limitTimer)
    if (this.warningTimer) clearTimeout(this.warningTimer)
    this.limitTimer = null
    this.warningTimer = null
  }

  private send(command: CaptureCommand): void {
    if (!this.deps.overlay.isDestroyed()) {
      this.deps.overlay.webContents.send(IPC.captureCommand, command)
    }
  }
}
