/**
 * Messages between main, the overlay renderer and the speech worker.
 *
 * Every audio frame and every result carries the session id, so anything that
 * belongs to an old or cancelled session can be recognised and dropped.
 */

/** main → worker, over the utility process's parent port. */
export type WorkerControl =
  /** Carries the MessagePort the overlay sends audio through. */
  | { t: 'port' }
  | { t: 'load'; modelDir: string; numThreads: number }
  | { t: 'begin'; session: number }
  | { t: 'cancel'; session: number }
  /** Evaluation mode: when this session's recording ends, write it to `path` as a WAV file. */
  | { t: 'saveAudio'; session: number; path: string }
  | { t: 'releaseEvaluation'; session: number }
  | { t: 'commitEvaluation'; session: number; request: number }
  | { t: 'discardEvaluation'; sessions: number[]; request: number }

/** overlay renderer → worker, over the audio MessagePort. Sent by structured clone. */
export type AudioMessage =
  | { t: 'pcm'; session: number; seq: number; pcm: Float32Array }
  /** All of the session's frames have been sent; `frames` is how many there were. */
  | { t: 'end'; session: number; frames: number }
  /** Smoke check only: asks the worker to confirm a frame arrives intact. */
  | { t: 'probe'; pcm: Float32Array }

export interface TranscriptEvent {
  t: 'final'
  session: number
  text: string
  /** True when the recording contained no speech; nothing was decoded. */
  noSpeech: boolean
  audioMs: number
  decodeMs: number
  chunks: number
  /** Frames that never arrived. Above zero, words may be missing. */
  lostFrames: number
  /** The loudest sample of the recording, in decibels below full scale (0 is the loudest possible). */
  peakDb: number
  /** The recording's average loudness, in decibels below full scale. */
  levelDb: number
}

/** worker → main. */
export type WorkerEvent =
  | { t: 'ready' }
  | { t: 'loaded'; loadMs: number; engine: string }
  | { t: 'loadFailed'; message: string }
  | { t: 'probe-ack'; samples: number; isFloat32: boolean }
  | TranscriptEvent
  | { t: 'failed'; session: number; message: string }
  | { t: 'evaluationDone'; request: number; failed: number }
