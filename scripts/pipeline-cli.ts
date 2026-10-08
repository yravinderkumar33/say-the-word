// Runs a WAV file through the same speech path the app uses (voice detection,
// chunking, the recognizer), with no Electron, microphone or permissions involved.
//
//   npm run pipeline -- tests/fixtures/audio/short.daniel.wav
//   npm run pipeline -- --silence 3        three seconds of silence
import { existsSync, readFileSync } from 'node:fs'
import { SAMPLE_RATE } from '../src/shared/audio-format'
import { decodeWav } from '../src/shared/wav'
import { wordErrorRate } from '../src/shared/wer'
import { loadSpeech, transcribe } from './lib/speech'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const speech = await loadSpeech()
  console.log(`model loaded in ${speech.loadMs.toFixed(0)} ms`)

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

  for (const input of inputs) {
    const { result: event, feedingMs, afterEndMs } = await transcribe(speech, input.samples)
    console.log(`\n${input.name}`)
    if (!event || event.t !== 'final') {
      console.log(`  FAILED: ${event?.t === 'failed' ? event.message : 'no result'}`)
      continue
    }
    console.log(
      `  audio ${(event.audioMs / 1_000).toFixed(1)} s · ${event.chunks} chunk(s) · recognizer ${event.decodeMs.toFixed(0)} ms · ` +
        `feeding ${feedingMs.toFixed(0)} ms · wait after end ${afterEndMs.toFixed(0)} ms · lost frames ${event.lostFrames}`,
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
