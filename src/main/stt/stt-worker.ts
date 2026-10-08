/**
 * Speech worker entry point. Runs in an Electron utility process, so recognition
 * never blocks the main process and a crash in native code cannot take the app down.
 *
 * It is a thin adapter: messages in, messages out. The logic lives in `Transcriber`.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { FRAME_SAMPLES, SAMPLE_RATE } from '@shared/audio-format'
import type { AudioMessage, WorkerControl, WorkerEvent } from '@shared/stt-protocol'
import { encodeWav } from '@shared/wav'
import { loadParakeet } from './engines/sherpa-parakeet'
import { Transcriber, type TranscriberEvent } from './transcriber'
import { VoiceDetector } from './vad'

const parent = process.parentPort
let transcriber: Transcriber | null = null
/**
 * The model's load, once it has been asked for. The worker holds one recognizer: a load
 * asked for again, while this one is under way (main stopped waiting for it) or after it,
 * gets the same answer, rather than a second 1.9 GB recognizer that would take the first
 * one's place in the middle of a dictation. A load that failed can be asked for again.
 */
let loading: Promise<WorkerEvent> | null = null
/** Evaluation mode: where to write a session's recording when it ends. */
const audioPaths = new Map<number, string>()
const heldAudio = new Map<number, Uint8Array>()
const revoked = new Set<number>()
let forgottenThrough = 0

function send(event: WorkerEvent): void {
  parent.postMessage(event)
}

function onTranscriberEvent(event: TranscriberEvent): void {
  if (event.t !== 'audio') {
    send(event)
    return
  }
  if (event.session <= forgottenThrough || revoked.has(event.session)) return
  const path = audioPaths.get(event.session)
  if (path) heldAudio.set(event.session, encodeWav(event.samples, SAMPLE_RATE))
}

async function load(modelDir: string, numThreads: number): Promise<WorkerEvent> {
  try {
    const { engine, loadMs } = await loadParakeet(modelDir, numThreads)
    const detector = new VoiceDetector(join(modelDir, 'silero_vad.onnx'))
    transcriber = new Transcriber(engine, detector, onTranscriberEvent)
    for (const session of audioPaths.keys()) transcriber.wantAudio(session)
    return { t: 'loaded', loadMs, engine: engine.id }
  } catch (error) {
    loading = null
    return { t: 'loadFailed', message: error instanceof Error ? error.message : String(error) }
  }
}

const isId = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 1
const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0

/**
 * True for a message the overlay could have sent. Audio comes from a page and is checked
 * as everything else from a page is: a frame without samples would end this process, and
 * one for session Infinity would make every later session look older, and be dropped.
 */
function isAudioMessage(data: unknown): data is AudioMessage {
  if (typeof data !== 'object' || data === null) return false
  const message = data as Record<string, unknown>
  switch (message.t) {
    case 'pcm':
      return (
        isId(message.session) &&
        isCount(message.seq) &&
        message.pcm instanceof Float32Array &&
        message.pcm.length <= FRAME_SAMPLES
      )
    case 'end':
      return isId(message.session) && isCount(message.frames)
    case 'probe':
      // Answered with whatever arrived: finding out is what the smoke check sends it for.
      return typeof message.pcm === 'object' && message.pcm !== null
    default:
      return false
  }
}

function onAudio(message: unknown): void {
  if (!isAudioMessage(message)) return
  switch (message.t) {
    case 'probe':
      send({
        t: 'probe-ack',
        samples: message.pcm.length,
        isFloat32: message.pcm instanceof Float32Array,
      })
      return
    case 'pcm':
      transcriber?.acceptFrame(message.session, message.seq, message.pcm)
      return
    case 'end':
      if (transcriber) void transcriber.end(message.session, message.frames)
      else
        send({ t: 'failed', session: message.session, message: 'The speech model is not loaded' })
      return
  }
}

parent.on('message', (event) => {
  const control = event.data as WorkerControl
  switch (control.t) {
    case 'port': {
      const port = event.ports[0]
      if (!port) return
      port.on('message', (portEvent) => onAudio(portEvent.data))
      port.start()
      return
    }
    case 'load':
      loading ??= load(control.modelDir, control.numThreads)
      void loading.then(send)
      return
    case 'begin':
      transcriber?.begin(control.session)
      return
    case 'cancel':
      transcriber?.cancel(control.session)
      return
    case 'releaseEvaluation':
      audioPaths.delete(control.session)
      heldAudio.delete(control.session)
      forgottenThrough = Math.max(forgottenThrough, control.session - 20)
      for (const id of revoked) if (id <= forgottenThrough) revoked.delete(id)
      return
    case 'saveAudio':
      if (control.session <= forgottenThrough || revoked.has(control.session)) return
      audioPaths.set(control.session, control.path)
      transcriber?.wantAudio(control.session)
      return
    case 'commitEvaluation': {
      let failed = 1
      const path = audioPaths.get(control.session)
      const audio = heldAudio.get(control.session)
      if (!revoked.has(control.session) && path && audio) {
        try {
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
          writeFileSync(path, audio, { mode: 0o600 })
          failed = 0
        } catch {
          failed = 1
        }
      }
      heldAudio.delete(control.session)
      send({ t: 'evaluationDone', request: control.request, failed })
      return
    }
    case 'discardEvaluation': {
      let failed = 0
      for (const session of control.sessions) {
        revoked.add(session)
        heldAudio.delete(session)
        const path = audioPaths.get(session)
        if (path)
          try {
            rmSync(path, { force: true })
          } catch {
            failed++
          }
        audioPaths.delete(session)
      }
      send({ t: 'evaluationDone', request: control.request, failed })
      return
    }
  }
})

send({ t: 'ready' })
