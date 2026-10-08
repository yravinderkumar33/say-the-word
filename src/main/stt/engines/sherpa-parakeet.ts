import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sherpa from 'sherpa-onnx-node'
import { SAMPLE_RATE } from '@shared/audio-format'
import { fixRecognizerArtifacts } from '../text-artifacts'
import type { SpeechEngine } from '../transcriber'

/** A recognizer with a name. Kept small so another engine can be added behind it. */
export interface SttEngine extends SpeechEngine {
  readonly id: string
}

const PARAKEET_FILES = [
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
] as const

/**
 * Loads NVIDIA Parakeet TDT through sherpa-onnx. Loading takes a few seconds and a
 * good deal of memory, so it is done once and the engine is kept.
 */
export async function loadParakeet(
  modelDir: string,
  numThreads: number,
): Promise<{ engine: SttEngine; loadMs: number }> {
  // sherpa-onnx answers a missing file with "Failed to create offline recognizer" and
  // nothing more, so the files are checked here, where the missing one can be named.
  for (const name of PARAKEET_FILES) {
    if (!existsSync(join(modelDir, name))) throw new Error(`Speech model file missing: ${name}`)
  }

  const started = performance.now()
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: join(modelDir, 'encoder.int8.onnx'),
        decoder: join(modelDir, 'decoder.int8.onnx'),
        joiner: join(modelDir, 'joiner.int8.onnx'),
      },
      tokens: join(modelDir, 'tokens.txt'),
      modelType: 'nemo_transducer',
      numThreads,
      provider: 'cpu',
      debug: 0,
    },
    decodingMethod: 'greedy_search',
  })
  const loadMs = performance.now() - started

  const engine: SttEngine = {
    id: 'parakeet-tdt-0.6b-v3-int8',
    async transcribe(samples) {
      const decodeStarted = performance.now()
      const stream = recognizer.createStream()
      stream.acceptWaveform({ samples: withDither(samples), sampleRate: SAMPLE_RATE })
      const result = await recognizer.decodeAsync(stream)
      return {
        text: fixRecognizerArtifacts(result.text.trim()),
        decodeMs: performance.now() - decodeStarted,
      }
    },
  }
  return { engine, loadMs }
}

/**
 * Adds noise far below hearing. Perfect digital silence can make the model's feature
 * extraction misbehave and produce empty output for audio that contains speech.
 * The noise is a fixed sequence, not random, so the same audio always decodes the same way.
 */
function withDither(samples: Float32Array): Float32Array {
  const dithered = new Float32Array(samples.length)
  let state = 12_345
  for (let index = 0; index < samples.length; index++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) & 0x7fffffff
    dithered[index] = (samples[index] ?? 0) + (state / 0x7fffffff - 0.5) * 2e-5
  }
  return dithered
}
