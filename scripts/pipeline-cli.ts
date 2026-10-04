// Runs a WAV file through the same speech path the app uses (voice detection,
// chunking, the recognizer), with no Electron, microphone or permissions involved.
//
//   npm run pipeline -- tests/fixtures/audio/short.daniel.wav
//   npm run pipeline -- --silence 3        three seconds of silence
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRAME_SAMPLES, SAMPLE_RATE } from '../src/shared/audio-format'
import { decodeWav } from '../src/shared/wav'
import { wordErrorRate } from '../src/shared/wer'
import { loadParakeet } from '../src/main/stt/engines/sherpa-parakeet'
import { DEFAULT_MODEL } from '../src/main/stt/model-catalog'
import { adoptModel, modelDir } from '../src/main/stt/model-store'
import { modelsRoot } from '../src/main/stt/models-dir'
import { Transcriber, type TranscriberEvent } from '../src/main/stt/transcriber'
import { VoiceDetector } from '../src/main/stt/vad'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const root = modelsRoot()
  if (!(await adoptModel(root, DEFAULT_MODEL)).ready) {
    throw new Error('The speech model is not downloaded. Run: npm run models:download')
  }
  const dir = modelDir(root, DEFAULT_MODEL)
  const { engine, loadMs } = await loadParakeet(dir, 4)
  const detector = new VoiceDetector(join(dir, 'silero_vad.onnx'))
  console.log(`model loaded in ${loadMs.toFixed(0)} ms`)

  const inputs: Array<{ name: string; samples: Float32Array; reference: string | null }> = []
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--silence') {
      const seconds = Number(args[++index] ?? 3)
      inputs.push({
        name: `${seconds} s of silence`,
        samples: new Float32Array(seconds * SAMPLE_RATE),
        reference: null,
      })
    } else if (arg) {
      const audio = decodeWav(readFileSync(arg))
      if (audio.sampleRate !== SAMPLE_RATE) throw new Error(`${arg} is not ${SAMPLE_RATE} Hz mono`)
      const referenceFile = arg.replace(/\.[a-z]+\.wav$/, '.txt')
      inputs.push({
        name: arg,
        samples: audio.samples,
        reference: existsSync(referenceFile) ? readFileSync(referenceFile, 'utf8') : null,
      })
    }
  }
  if (inputs.length === 0) throw new Error('Give one or more WAV files, or --silence <seconds>')

  let session = 0
  for (const input of inputs) {
    session += 1
    const events: TranscriberEvent[] = []
    const transcriber = new Transcriber(engine, detector, (event) => events.push(event))
    const started = performance.now()
    transcriber.begin(session)
    let frames = 0
    for (let offset = 0; offset < input.samples.length; offset += FRAME_SAMPLES) {
      transcriber.acceptFrame(
        session,
        frames++,
        input.samples.slice(offset, offset + FRAME_SAMPLES),
      )
    }
    const endCalled = performance.now()
    await transcriber.end(session, frames)
    const afterEnd = performance.now() - endCalled

    const event = events.find((item) => item.t === 'final' || item.t === 'failed')
    console.log(`\n${input.name}`)
    if (!event || event.t !== 'final') {
      console.log(`  FAILED: ${event?.t === 'failed' ? event.message : 'no result'}`)
      continue
    }
    console.log(
      `  audio ${(event.audioMs / 1_000).toFixed(1)} s · ${event.chunks} chunk(s) · recognizer ${event.decodeMs.toFixed(0)} ms · ` +
        `feeding ${(endCalled - started).toFixed(0)} ms · wait after end ${afterEnd.toFixed(0)} ms · lost frames ${event.lostFrames}`,
    )
    console.log(event.noSpeech ? '  (no speech)' : `  ${event.text}`)
    if (input.reference && !event.noSpeech) {
      console.log(
        `  word error rate ${(wordErrorRate(input.reference, event.text) * 100).toFixed(1)}%`,
      )
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
