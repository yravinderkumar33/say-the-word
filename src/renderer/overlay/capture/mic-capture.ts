import { MAX_AUDIO_SAMPLES, PCM_PROCESSOR_NAME, SAMPLE_RATE } from '@shared/audio-format'
import type { CaptureEvent, Microphone } from '@shared/ipc'
import type { AudioMessage } from '@shared/stt-protocol'
import { meterLevel, rawMicrophoneConstraints } from '../../microphone'
import { loadPcmWorklet } from './load-worklet'

/** Audio kept after the key is released, because people let go a little early. */
const TAIL_MS = 150
/** How long to wait for the worklet to hand over its last partial frame. */
const FLUSH_TIMEOUT_MS = 120

interface ActiveCapture {
  session: number
  /** Every frame of the session, kept so it can be sent again after a worker restart. */
  samples: number
  frames: Float32Array[]
  stream: MediaStream | null
  source: MediaStreamAudioSourceNode | null
  node: AudioWorkletNode | null
  requestedAt: number
  live: boolean
  cancelled: boolean
  stopping: boolean
  /** Resolves when the worklet has handed over its last partial frame. */
  flushed: (() => void) | null
  /** Ends this capture's listeners on the microphone track when it is let go. */
  listeners: AbortController
  /** True once the main process has said the recording is not needed, while it is still being wound up. */
  released: boolean
}

/** Microphone streams that are open right now. Zero means the microphone is released. */
const openStreams = new Set<MediaStream>()

export function openMicrophoneCount(): number {
  return openStreams.size
}

export interface MicCaptureCallbacks {
  /** Loudness of the latest frame, 0 to 1, for the pill's bars. */
  onLevel(level: number): void
  onEvent(event: CaptureEvent): void
}

/**
 * Captures the microphone for one session at a time and sends it to the speech worker
 * as 16 kHz mono frames, over a MessagePort that does not pass through the main process.
 *
 * The microphone is opened when a session starts and closed when it ends, so the
 * system's recording indicator is on only while dictating.
 *
 * The audio of a session is kept until the main process says it is no longer needed
 * (`release`), or the next session starts. Until then it can be sent again: to a speech
 * worker that was restarted, or because the user asked for a cancelled or failed
 * dictation after all (Undo, Retry). After that nothing here refers to it any more:
 * a finished capture gives up its frames and its listeners, so the audio can be freed.
 *
 * The audio graph runs only while a session does. Between sessions the context is
 * suspended, which lets the output device, and the Mac, rest.
 */
export class MicCapture {
  private context: AudioContext | null = null
  private workletReady: Promise<void> | null = null
  private port: MessagePort | null = null
  private active: ActiveCapture | null = null
  /** The last session that finished or was cancelled, until it is released. */
  private finished: { session: number; frames: Float32Array[] } | null = null
  /** True when `finished` is waiting for its text, so a new worker must be sent it. */
  private awaitingText = false

  constructor(private readonly callbacks: MicCaptureCallbacks) {}

  /**
   * The line to the speech worker. A new port means a new worker, which has heard
   * nothing yet: the recording in progress, or the one still waiting for its text,
   * is sent again from its first frame.
   */
  attachPort(port: MessagePort): void {
    // The line to a worker that is gone leads nowhere.
    if (this.port !== port) this.port?.close()
    this.port = port
    const active = this.active
    if (active && !active.cancelled) {
      this.postFrames(active.session, active.frames)
      return
    }
    // A cancelled recording is only kept in case of Undo; nobody is waiting for its text.
    if (this.finished && this.awaitingText) this.sendFinished()
  }

  /** Undo or Retry: sends the held recording to the worker again, from its first frame. */
  resend(session: number): void {
    // Still being recorded or wound up: it reaches the worker when it finishes anyway.
    if (this.active?.session === session && !this.active.cancelled) return
    if (this.finished?.session !== session) {
      this.callbacks.onEvent({ kind: 'gone', session })
      return
    }
    this.awaitingText = true
    this.sendFinished()
  }

  private sendFinished(): void {
    const finished = this.finished
    if (!finished) return
    this.postFrames(finished.session, finished.frames)
    this.post({ t: 'end', session: finished.session, frames: finished.frames.length })
  }

  /** The microphone open for the session in hand, as the system names it; null when none is. */
  get microphoneLabel(): string | null {
    return this.active?.stream?.getAudioTracks()[0]?.label || null
  }

  async start(session: number, deviceId: string | null): Promise<void> {
    this.cancelActive()
    this.finished = null
    const capture: ActiveCapture = {
      session,
      frames: [],
      samples: 0,
      stream: null,
      source: null,
      node: null,
      requestedAt: performance.now(),
      live: false,
      cancelled: false,
      stopping: false,
      flushed: null,
      listeners: new AbortController(),
      released: false,
    }
    this.active = capture

    try {
      const context = await this.ensureContext()
      // The session may be over before the audio setup has loaded (a quick cancel on
      // the first dictation). The microphone is then never asked for.
      if (capture.cancelled || this.active !== capture) return
      // Started now, so that it overlaps with the microphone opening. Asked for every
      // time: a suspend from the session before may still be on its way.
      const awake = context.resume()
      const stream = await openMicrophone(deviceId)
      // The session may have been cancelled, or replaced, while the microphone opened.
      if (capture.cancelled || this.active !== capture) {
        stopTracks(stream)
        return
      }
      capture.stream = stream
      stream.getAudioTracks()[0]?.addEventListener('ended', () => this.onTrackEnded(capture), {
        signal: capture.listeners.signal,
      })

      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, PCM_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        // A stereo microphone is mixed down rather than read from one side only.
        channelCount: 1,
        channelCountMode: 'explicit',
      })
      node.port.onmessage = (event: MessageEvent<Float32Array | string>) => {
        if (event.data === 'started') this.markLive(capture)
        else if (event.data === 'flushed') capture.flushed?.()
        else if (typeof event.data !== 'string') this.onFrame(capture, event.data)
      }
      // The graph only pulls audio through nodes that lead to the output, so the
      // worklet is connected through a silent gain.
      const silent = context.createGain()
      silent.gain.value = 0
      source.connect(node).connect(silent).connect(context.destination)
      capture.source = source
      capture.node = node
      await awake
    } catch (error) {
      if (capture.cancelled || this.active !== capture) return
      this.release(capture)
      this.active = null
      this.rest()
      this.callbacks.onEvent({ kind: 'failed', session, message: describeMicError(error) })
    }
  }

  /** Stops after a short tail, sends what is left, and tells the worker the session is over. */
  async stop(session: number): Promise<void> {
    const capture = this.active
    if (!capture || capture.session !== session || capture.stopping) return
    capture.stopping = true
    await sleep(TAIL_MS)
    await this.finish(capture, false)
  }

  /**
   * Stops at once. Nothing more is sent for this session. What was recorded is held
   * until it is released, in case the user takes the cancel back.
   */
  cancel(session: number): void {
    const capture = this.active
    if (capture?.session === session) {
      // Held even when nothing was captured yet: an Undo then finds an empty recording
      // ("no speech") rather than none at all.
      const frames = capture.frames
      this.cancelActive()
      this.finished = { session, frames }
    }
    if (this.finished?.session === session) this.awaitingText = false
  }

  /** True while a finished or cancelled recording is still held in memory. */
  get holdsRecording(): boolean {
    return this.finished !== null
  }

  /**
   * The session is over: its audio is no longer needed. That can be said while the
   * recording is still being wound up (a session that failed the moment the key was let
   * go, for one): it is then let go as soon as the winding up is done, not held until
   * the next dictation.
   */
  forget(session: number): void {
    if (this.finished?.session === session) this.finished = null
    else if (this.active?.session === session) this.active.released = true
  }

  /** Tests only: behaves as if the microphone had been unplugged. */
  loseMicrophone(session: number): void {
    const capture = this.active
    if (capture?.session === session) this.onTrackEnded(capture)
  }

  /** The microphones the system offers. Labels are empty until permission is granted. */
  async listMicrophones(): Promise<Microphone[]> {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices
      .filter((device) => device.kind === 'audioinput' && device.deviceId !== '')
      .filter((device) => device.deviceId !== 'default' && device.deviceId !== 'communications')
      .map((device) => ({ deviceId: device.deviceId, label: device.label }))
  }

  private async ensureContext(): Promise<AudioContext> {
    if (!this.context) {
      // Chromium resamples the microphone to the context's rate.
      this.context = new AudioContext({ sampleRate: SAMPLE_RATE })
      this.workletReady = loadPcmWorklet(this.context)
    }
    const context = this.context
    try {
      await this.workletReady
    } catch (error) {
      // A load that failed is not kept: the next session tries again from scratch, and
      // this context, which holds on to the audio device, is closed.
      if (this.context === context) {
        this.context = null
        this.workletReady = null
        void context.close()
      }
      throw error
    }
    return context
  }

  /** Nothing is being recorded: the audio graph is put to sleep until the next session. */
  private rest(): void {
    if (!this.active) void this.context?.suspend()
  }

  /** Audio has started to flow: from here on, what is said is being captured. */
  private markLive(capture: ActiveCapture): void {
    if (capture.live || capture.cancelled || this.active !== capture) return
    capture.live = true
    this.callbacks.onEvent({
      kind: 'live',
      session: capture.session,
      openMs: performance.now() - capture.requestedAt,
    })
  }

  private onFrame(capture: ActiveCapture, pcm: Float32Array): void {
    if (capture.cancelled || this.active !== capture) return
    this.markLive(capture)
    if (capture.samples + pcm.length > MAX_AUDIO_SAMPLES) {
      if (!capture.stopping) {
        capture.stopping = true
        void this.finish(capture, false)
      }
      return
    }
    capture.samples += pcm.length
    const seq = capture.frames.length
    capture.frames.push(pcm)
    this.post({ t: 'pcm', session: capture.session, seq, pcm })
    this.callbacks.onLevel(meterLevel(pcm))
  }

  /** The microphone went away on its own (unplugged, or taken by the system). */
  private onTrackEnded(capture: ActiveCapture): void {
    if (capture.cancelled || capture.stopping || this.active !== capture) return
    capture.stopping = true
    void this.finish(capture, true)
  }

  private async finish(capture: ActiveCapture, micLost: boolean): Promise<void> {
    if (capture.cancelled || this.active !== capture) return
    if (capture.node) {
      const flushed = new Promise<void>((resolve) => (capture.flushed = resolve))
      capture.node.port.postMessage('flush')
      await Promise.race([flushed, sleep(FLUSH_TIMEOUT_MS)])
    }
    if (capture.cancelled || this.active !== capture) return
    const frames = capture.frames
    this.release(capture)
    this.active = null
    this.rest()
    this.finished = capture.released ? null : { session: capture.session, frames }
    this.awaitingText = true
    this.post({ t: 'end', session: capture.session, frames: frames.length })
    this.callbacks.onLevel(0)
    this.callbacks.onEvent({
      kind: 'ended',
      session: capture.session,
      frames: frames.length,
      micLost,
    })
  }

  private cancelActive(): void {
    const capture = this.active
    if (!capture) return
    capture.cancelled = true
    this.release(capture)
    this.active = null
    this.rest()
    this.callbacks.onLevel(0)
  }

  /**
   * Lets go of everything a capture holds: the microphone, its place in the audio
   * graph, its listeners and its frames. The frames live on only in whoever took them
   * first (the held recording).
   */
  private release(capture: ActiveCapture): void {
    capture.listeners.abort()
    capture.source?.disconnect()
    capture.node?.disconnect()
    if (capture.node) {
      // Tells the processor it is finished. One that is never told goes on being run
      // by the audio thread for as long as the page lives, and they add up.
      capture.node.port.postMessage('close')
      capture.node.port.onmessage = null
    }
    if (capture.stream) stopTracks(capture.stream)
    capture.stream = null
    capture.source = null
    capture.node = null
    capture.frames = []
  }

  private postFrames(session: number, frames: Float32Array[]): void {
    frames.forEach((pcm, seq) => this.post({ t: 'pcm', session, seq, pcm }))
  }

  private post(message: AudioMessage): void {
    // No transfer list: across processes the data is copied either way, and the
    // frames are kept here for a possible replay.
    this.port?.postMessage(message)
  }
}

async function openMicrophone(deviceId: string | null): Promise<MediaStream> {
  const stream = await requestMicrophone(deviceId)
  openStreams.add(stream)
  return stream
}

async function requestMicrophone(deviceId: string | null): Promise<MediaStream> {
  if (!deviceId) return navigator.mediaDevices.getUserMedia(rawMicrophoneConstraints(null))
  try {
    return await navigator.mediaDevices.getUserMedia(rawMicrophoneConstraints(deviceId))
  } catch (error) {
    // The chosen microphone is gone (unplugged, out of range): dictation carries on
    // with the system default instead of failing.
    if (!isMissingDevice(error)) throw error
    return navigator.mediaDevices.getUserMedia(rawMicrophoneConstraints(null))
  }
}

function isMissingDevice(error: unknown): boolean {
  const name = error instanceof DOMException ? error.name : ''
  return name === 'NotFoundError' || name === 'OverconstrainedError'
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
  openStreams.delete(stream)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describeMicError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError') return 'Microphone access was not allowed'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found'
  if (name === 'NotReadableError') return 'The microphone is in use or could not be opened'
  return error instanceof Error ? error.message : 'The microphone could not be opened'
}
