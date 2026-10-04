import sherpa from 'sherpa-onnx-node'
import { SAMPLE_RATE } from '@shared/audio-format'
import type { SampleRange } from './chunk-planner'

/** The detector reads audio in windows of exactly this many samples. */
const WINDOW = 512

/**
 * Finds the stretches of speech in a recording (Silero VAD through sherpa-onnx).
 * Sample positions count from the last `reset()`.
 */
export class VoiceDetector {
  private readonly vad: InstanceType<typeof sherpa.Vad>
  private remainder = new Float32Array(0)

  constructor(modelPath: string) {
    this.vad = new sherpa.Vad(
      {
        sileroVad: {
          model: modelPath,
          threshold: 0.5,
          // A pause this long ends a stretch of speech.
          minSilenceDuration: 0.5,
          minSpeechDuration: 0.25,
          // Not a hard cap: past it the detector only gets keener to find a pause.
          maxSpeechDuration: 20,
          windowSize: WINDOW,
        },
        sampleRate: SAMPLE_RATE,
        numThreads: 1,
        debug: false,
      },
      60,
    )
  }

  reset(): void {
    this.vad.reset()
    this.remainder = new Float32Array(0)
  }

  /** Feeds audio and returns the stretches of speech that have just ended. */
  accept(samples: Float32Array): SampleRange[] {
    const audio = this.remainder.length > 0 ? concat(this.remainder, samples) : samples
    let offset = 0
    while (offset + WINDOW <= audio.length) {
      this.vad.acceptWaveform(audio.subarray(offset, offset + WINDOW))
      offset += WINDOW
    }
    this.remainder = audio.slice(offset)
    return this.drain()
  }

  /** True while the speaker is mid-sentence. */
  get speaking(): boolean {
    return this.vad.isDetected()
  }

  /** No more audio: closes the stretch of speech in progress, if any, and returns it. */
  finish(): SampleRange[] {
    this.vad.flush()
    return this.drain()
  }

  private drain(): SampleRange[] {
    const ranges: SampleRange[] = []
    while (!this.vad.isEmpty()) {
      const segment = this.vad.front(false)
      this.vad.pop()
      ranges.push({ start: segment.start, end: segment.start + segment.samples.length })
    }
    return ranges
  }
}

function concat(first: Float32Array, second: Float32Array): Float32Array {
  const joined = new Float32Array(first.length + second.length)
  joined.set(first)
  joined.set(second, first.length)
  return joined
}
