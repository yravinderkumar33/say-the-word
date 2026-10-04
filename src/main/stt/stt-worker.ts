/**
 * Speech worker entry point. Runs in an Electron utility process, so recognition
 * never blocks the main process and a crash in native code cannot take the app down.
 *
 * It is a thin adapter: messages in, messages out. The logic lives in `Transcriber`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SAMPLE_RATE } from '@shared/audio-format'
import type { AudioMessage, WorkerControl, WorkerEvent } from '@shared/stt-protocol'
import { encodeWav } from '@shared/wav'
import { loadParakeet } from './engines/sherpa-parakeet'
import { Transcriber, type TranscriberEvent } from './transcriber'
import { VoiceDetector } from './vad'

const parent = process.parentPort
let transcriber: Transcriber | null = null
/** Evaluation mode: where to write a session's recording when it ends. */
const audioPaths = new Map<number, string>()

function send(event: WorkerEvent): void {
  parent.postMessage(event)
}

function onTranscriberEvent(event: TranscriberEvent): void {
  if (event.t !== 'audio') {
    send(event)
    return
  }
  // The recording itself never leaves this process: it is written straight to disk.
  const path = audioPaths.get(event.session)
  audioPaths.delete(event.session)
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, encodeWav(event.samples, SAMPLE_RATE))
    send({ t: 'audioSaved', session: event.session, path })
  } catch (error) {
    send({
      t: 'audioSaveFailed',
      session: event.session,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function load(modelDir: string, numThreads: number): Promise<void> {
  try {
    const { engine, loadMs } = await loadParakeet(modelDir, numThreads)
    const detector = new VoiceDetector(join(modelDir, 'silero_vad.onnx'))
    transcriber = new Transcriber(engine, detector, onTranscriberEvent)
    for (const session of audioPaths.keys()) transcriber.wantAudio(session)
    send({ t: 'loaded', loadMs, engine: engine.id })
  } catch (error) {
    send({ t: 'loadFailed', message: error instanceof Error ? error.message : String(error) })
  }
}

function onAudio(message: AudioMessage): void {
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
      port.on('message', (portEvent) => onAudio(portEvent.data as AudioMessage))
      port.start()
      return
    }
    case 'load':
      void load(control.modelDir, control.numThreads)
      return
    case 'begin':
      transcriber?.begin(control.session)
      return
    case 'cancel':
      audioPaths.delete(control.session)
      transcriber?.cancel(control.session)
      return
    case 'saveAudio':
      audioPaths.set(control.session, control.path)
      transcriber?.wantAudio(control.session)
      return
  }
})

send({ t: 'ready' })
