// The package ships no type definitions. These cover only what this app uses, and
// follow the JavaScript in node_modules/sherpa-onnx-node (version 1.13.8).
declare module 'sherpa-onnx-node' {
  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number }
    modelConfig: {
      transducer: { encoder: string; decoder: string; joiner: string }
      tokens: string
      modelType: string
      numThreads: number
      provider: string
      debug: number
    }
    decodingMethod: string
  }

  export interface OfflineRecognizerResult {
    text: string
    tokens?: string[]
    timestamps?: number[]
    lang?: string
  }

  export class OfflineStream {
    acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>
    createStream(): OfflineStream
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>
  }

  export interface VadConfig {
    sileroVad: {
      model: string
      threshold: number
      minSilenceDuration: number
      minSpeechDuration: number
      maxSpeechDuration: number
      windowSize: number
    }
    sampleRate: number
    numThreads: number
    debug: boolean
  }

  export interface SpeechSegment {
    /** Index of the segment's first sample, counted from the last `reset()`. */
    start: number
    samples: Float32Array
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number)
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    isDetected(): boolean
    pop(): void
    /** Pass `false`: Electron rejects the external buffers the default would return. */
    front(enableExternalBuffer?: boolean): SpeechSegment
    reset(): void
    flush(): void
  }

  const sherpa: {
    OfflineRecognizer: typeof OfflineRecognizer
    Vad: typeof Vad
    version: string
    onnxruntimeVersion: string
  }
  export default sherpa
}
