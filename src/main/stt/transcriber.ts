import { MAX_AUDIO_SAMPLES, SAMPLE_RATE } from '@shared/audio-format'
import type { TranscriptEvent } from '@shared/stt-protocol'
import { ChunkPlanner, splitAtQuietPoints, type SampleRange } from './chunk-planner'
import { SampleBuffer } from './sample-buffer'

/** Turns audio into text. */
export interface SpeechEngine {
  /** `samples` are 16 kHz mono in [-1, 1]. */
  transcribe(samples: Float32Array): Promise<{ text: string; decodeMs: number }>
}

/** Finds the stretches of speech in a stream of audio. */
export interface SpeechDetector {
  reset(): void
  accept(samples: Float32Array): SampleRange[]
  finish(): SampleRange[]
}

/** What a finished session reports: the worker's transcript event, without its tag. */
export type TranscriptResult = Omit<TranscriptEvent, 't'>

/** Anything quieter than this is reported as this: digital silence has no decibel value. */
const SILENCE_DB = -120

function toDb(amplitude: number): number {
  if (!(amplitude > 0)) return SILENCE_DB
  return Math.max(SILENCE_DB, Math.round(20 * Math.log10(amplitude) * 10) / 10)
}

export type TranscriberEvent =
  | ({ t: 'final' } & TranscriptResult)
  | { t: 'failed'; session: number; message: string }
  /** The whole recording, handed over only for a session `wantAudio` was called for. */
  | { t: 'audio'; session: number; samples: Float32Array }

export interface TranscriberOptions {
  /** The longest stretch handed to the recognizer in one go. */
  maxChunkSec: number
  padBeforeSec: number
  padAfterSec: number
}

/**
 * 30 s was measured on the development machine: a 57 s clip decodes in one piece in
 * 1.65 s with peak memory under 2.5 GB, so 30 s leaves a wide margin.
 */
const DEFAULT_TRANSCRIBER_OPTIONS: TranscriberOptions = {
  maxChunkSec: 30,
  padBeforeSec: 0.2,
  padAfterSec: 0.3,
}

interface Session {
  id: number
  buffer: SampleBuffer
  planner: ChunkPlanner
  /** Decodes run one at a time, in order; each appends its text to `texts`. */
  chain: Promise<void>
  texts: string[]
  chunks: number
  decodeMs: number
  received: number
  nextSeq: number
  lost: number
  /** The largest absolute sample so far, and the sum of squares, for the loudness figures. */
  peak: number
  energy: number
  ended: boolean
  cancelled: boolean
}

/**
 * Follows one recording at a time from its first frame to its transcript.
 *
 * Audio arrives in frames while the user is still speaking. Speech that can already
 * be decoded is decoded in the background, so that when the recording ends only its
 * tail is left. Every frame and every result is tied to a session id: frames for an
 * old session are dropped, and a cancelled session never produces a result.
 */
export class Transcriber {
  private current: Session | null = null
  private readonly maxChunkSamples: number
  /** Sessions whose recording is to be handed over when it ends (evaluation mode). */
  private readonly audioWanted = new Set<number>()
  /**
   * The session last stopped at the sample limit. It has had its answer, so whatever
   * else arrives for it is dropped.
   */
  private stoppedAtLimit: number | null = null

  constructor(
    private readonly engine: SpeechEngine,
    private readonly detector: SpeechDetector,
    private readonly emit: (event: TranscriberEvent) => void,
    private readonly options: TranscriberOptions = DEFAULT_TRANSCRIBER_OPTIONS,
  ) {
    this.maxChunkSamples = Math.round(options.maxChunkSec * SAMPLE_RATE)
  }

  /**
   * Asks for a session's whole recording when it ends, as an `audio` event. Nothing is
   * handed over for a session that is cancelled.
   */
  wantAudio(session: number): void {
    this.audioWanted.add(session)
    // Ids only grow, so anything far behind will never end now.
    for (const id of this.audioWanted) if (id < session - 8) this.audioWanted.delete(id)
  }

  /** Starts a session. A newer id replaces the session in progress. */
  begin(session: number): void {
    if (this.current && session <= this.current.id) return
    if (this.current) this.current.cancelled = true
    this.detector.reset()
    this.current = {
      id: session,
      buffer: new SampleBuffer(),
      planner: new ChunkPlanner({
        maxChunkSamples: this.maxChunkSamples,
        padBefore: Math.round(this.options.padBeforeSec * SAMPLE_RATE),
        padAfter: Math.round(this.options.padAfterSec * SAMPLE_RATE),
      }),
      chain: Promise.resolve(),
      texts: [],
      chunks: 0,
      decodeMs: 0,
      received: 0,
      nextSeq: 0,
      lost: 0,
      peak: 0,
      energy: 0,
      ended: false,
      cancelled: false,
    }
  }

  acceptFrame(session: number, seq: number, pcm: Float32Array): void {
    if (session === this.stoppedAtLimit) {
      // The rest of that recording is dropped. Sent again from its first frame (Retry,
      // Undo), it is a new attempt.
      if (seq > 0) return
      this.stoppedAtLimit = null
    }
    // Frames can arrive just before the `begin` that announces them.
    if (!this.current || session > this.current.id) this.begin(session)
    let active = this.current
    if (!active || active.id !== session || active.ended) return

    if (seq === 0 && active.received > 0) {
      // The sender is replaying the recording from its start (it does this after the
      // worker was restarted). Start the session over with the same id.
      this.current = null
      this.begin(session)
      active = this.current
      if (!active) return
    }

    if (active.buffer.length + pcm.length > MAX_AUDIO_SAMPLES) {
      this.cancel(session)
      this.stoppedAtLimit = session
      this.emit({ t: 'failed', session, message: 'Recording sample limit reached' })
      return
    }
    if (seq > active.nextSeq) active.lost += seq - active.nextSeq
    active.nextSeq = seq + 1
    active.received += 1
    for (const sample of pcm) {
      const size = Math.abs(sample)
      if (size > active.peak) active.peak = size
      active.energy += sample * sample
    }
    active.buffer.append(pcm)
    for (const speech of this.detector.accept(pcm)) {
      for (const chunk of active.planner.addSpeech(speech)) this.decodeLater(active, chunk)
    }
  }

  /** The recording is over: `frames` is how many the sender sent. Emits `final` or `failed`. */
  async end(session: number, frames: number): Promise<void> {
    // Answered already, with the failure at the limit.
    if (session === this.stoppedAtLimit) return
    // A recording can end before its first frame (the key was let go while the
    // microphone was still opening), and the `begin` that announces a session is only
    // sent when the model was already loaded. Such a session is begun here, so that it
    // is answered ("no speech") instead of leaving the app waiting for a result.
    if (!this.current || session > this.current.id) this.begin(session)
    const active = this.current
    if (!active || active.id !== session || active.ended) return
    active.ended = true
    active.lost = Math.max(active.lost, frames - active.received)
    if (this.audioWanted.delete(session)) {
      this.emit({ t: 'audio', session, samples: active.buffer.slice(0, active.buffer.length) })
    }

    try {
      for (const speech of this.detector.finish()) {
        for (const chunk of active.planner.addSpeech(speech)) this.decodeLater(active, chunk)
      }
      for (const chunk of active.planner.finish(active.buffer.length)) {
        this.decodeLater(active, chunk)
      }
      await active.chain
      if (active.cancelled) return
      this.emit({
        t: 'final',
        session: active.id,
        text: active.texts.join(' '),
        noSpeech: !active.planner.hadSpeech,
        audioMs: (active.buffer.length / SAMPLE_RATE) * 1_000,
        decodeMs: active.decodeMs,
        chunks: active.chunks,
        lostFrames: active.lost,
        peakDb: toDb(active.peak),
        levelDb: toDb(Math.sqrt(active.energy / Math.max(1, active.buffer.length))),
      })
    } catch (error) {
      if (active.cancelled) return
      this.emit({
        t: 'failed',
        session: active.id,
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (this.current === active) this.current = null
    }
  }

  /** Ends a session without a result. Work already under way is discarded when it finishes. */
  cancel(session: number): void {
    this.audioWanted.delete(session)
    if (this.current?.id !== session) return
    this.current.cancelled = true
    this.current = null
  }

  private decodeLater(session: Session, range: SampleRange): void {
    session.chain = session.chain.then(async () => {
      if (session.cancelled) return
      const audio = session.buffer.slice(range.start, range.end)
      // The voice detector normally ends a stretch of speech well before this limit.
      // Someone who never pauses is cut at the quietest moments instead.
      const pieces =
        audio.length > this.maxChunkSamples
          ? splitAtQuietPoints(audio, this.maxChunkSamples, {
              frame: Math.round(0.02 * SAMPLE_RATE),
              searchBack: 2 * SAMPLE_RATE,
            })
          : [{ start: 0, end: audio.length }]
      for (const piece of pieces) {
        if (session.cancelled) return
        const result = await this.engine.transcribe(audio.subarray(piece.start, piece.end))
        session.decodeMs += result.decodeMs
        session.chunks += 1
        if (result.text) session.texts.push(result.text)
      }
    })
  }
}
