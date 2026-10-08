// What the speech tools share: the speech model on disk, loaded as the app loads it, and a
// recording fed through the path the app feeds it through (voice detection, cutting at
// pauses, the recognizer), with no Electron, microphone or permissions involved.
import { join } from 'node:path'
import { FRAME_SAMPLES } from '../../src/shared/audio-format'
import { loadParakeet, type SttEngine } from '../../src/main/stt/engines/sherpa-parakeet'
import { DEFAULT_MODEL } from '../../src/main/stt/model-catalog'
import { adoptModel, modelDir } from '../../src/main/stt/model-store'
import { modelsRoot } from '../../src/main/stt/models-dir'
import { Transcriber, type TranscriberEvent } from '../../src/main/stt/transcriber'
import { VoiceDetector } from '../../src/main/stt/vad'

/** The folder of the speech model. Stops, saying what to run, when it is not on disk. */
export async function downloadedModel(): Promise<string> {
  const root = modelsRoot()
  if (!(await adoptModel(root, DEFAULT_MODEL)).ready) {
    throw new Error('The speech model is not downloaded. Run: npm run models:download')
  }
  return modelDir(root, DEFAULT_MODEL)
}

export interface Speech {
  engine: SttEngine
  detector: VoiceDetector
  /** How long the recognizer took to load. */
  loadMs: number
}

/** The recognizer and the voice detector, from the downloaded model. */
export async function loadSpeech(threads = 4): Promise<Speech> {
  const dir = await downloadedModel()
  const { engine, loadMs } = await loadParakeet(dir, threads)
  return { engine, loadMs, detector: new VoiceDetector(join(dir, 'silero_vad.onnx')) }
}

export interface Transcribed {
  /** What the recording came to: its final text, or why it failed; undefined if neither came. */
  result: Extract<TranscriberEvent, { t: 'final' | 'failed' }> | undefined
  /** How long handing over the frames took. */
  feedingMs: number
  /** How long the end of the recording took to be answered, once the frames were in. */
  afterEndMs: number
}

let sessions = 0

/** Hands a recording to a Transcriber frame by frame, as the capture does, and ends it. */
export async function transcribe(speech: Speech, samples: Float32Array): Promise<Transcribed> {
  const session = ++sessions
  const events: TranscriberEvent[] = []
  const transcriber = new Transcriber(speech.engine, speech.detector, (event) => events.push(event))
  const started = performance.now()
  transcriber.begin(session)
  let frames = 0
  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    transcriber.acceptFrame(session, frames++, samples.slice(offset, offset + FRAME_SAMPLES))
  }
  const endCalled = performance.now()
  await transcriber.end(session, frames)
  const result = events.find(
    (event): event is Extract<TranscriberEvent, { t: 'final' | 'failed' }> =>
      event.t === 'final' || event.t === 'failed',
  )
  return { result, feedingMs: endCalled - started, afterEndMs: performance.now() - endCalled }
}
