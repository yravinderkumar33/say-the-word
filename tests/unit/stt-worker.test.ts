import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_SAMPLES } from '@shared/audio-format'
import type { WorkerControl, WorkerEvent } from '@shared/stt-protocol'

/** The recognizer, as far as the worker can see it. A test can hold its load. */
const recognizer = vi.hoisted(() => ({
  loads: 0,
  gate: Promise.resolve(),
}))
vi.mock('../../src/main/stt/engines/sherpa-parakeet', () => ({
  loadParakeet: async () => {
    recognizer.loads += 1
    await recognizer.gate
    return {
      engine: {
        id: 'fake-engine',
        transcribe: async () => ({ text: 'synthetic', decodeMs: 1 }),
      },
      loadMs: 5,
    }
  },
}))

// The voice detector's native half: everything it is given is one stretch of speech.
vi.mock('sherpa-onnx-node', () => ({
  default: {
    Vad: class {
      private fed = 0
      private segments: Array<{ start: number; samples: Float32Array }> = []
      acceptWaveform(samples: Float32Array): void {
        this.fed += samples.length
      }
      isEmpty(): boolean {
        return this.segments.length === 0
      }
      front(): { start: number; samples: Float32Array } {
        return this.segments[0]!
      }
      pop(): void {
        this.segments.shift()
      }
      reset(): void {
        this.fed = 0
        this.segments = []
      }
      flush(): void {
        if (this.fed > 0) this.segments.push({ start: 0, samples: new Float32Array(this.fed) })
        this.fed = 0
      }
    },
  },
}))

/** The overlay's end of the audio line. */
class OverlayPort extends EventEmitter {
  start(): void {}
  send(data: unknown): void {
    this.emit('message', { data })
  }
}

let modelDir: string

/** A fresh worker process, as far as its module can tell. */
async function startWorker() {
  const events: WorkerEvent[] = []
  const parent = Object.assign(new EventEmitter(), {
    postMessage: (event: WorkerEvent) => events.push(event),
  })
  Object.defineProperty(process, 'parentPort', { value: parent, configurable: true })
  vi.resetModules()
  await import('../../src/main/stt/stt-worker')
  const control = (data: WorkerControl, ports: unknown[] = []): void => {
    parent.emit('message', { data, ports })
  }
  const overlay = new OverlayPort()
  control({ t: 'port' }, [overlay])
  return { events, control, overlay }
}

beforeEach(async () => {
  recognizer.loads = 0
  recognizer.gate = Promise.resolve()
  modelDir = await mkdtemp(join(tmpdir(), 'stt-worker-'))
  await writeFile(join(modelDir, 'silero_vad.onnx'), '')
})

afterEach(async () => {
  await rm(modelDir, { recursive: true, force: true })
})

describe('the speech worker', () => {
  it('reports a model without its voice-detection file as a failed load (Sp-F3)', async () => {
    await rm(join(modelDir, 'silero_vad.onnx'))
    const worker = await startWorker()

    worker.control({ t: 'load', modelDir, numThreads: 1 })

    // Loaded without it, the worker would hear no speech in anything.
    await vi.waitFor(() => expect(worker.events.at(-1)?.t).toMatch(/^load/))
    expect(worker.events.at(-1)).toEqual({
      t: 'loadFailed',
      message: 'Speech model file missing: silero_vad.onnx',
    })
  })

  it('loads the model once, however often it is asked (Sp-F8)', async () => {
    let release!: () => void
    recognizer.gate = new Promise((resolve) => (release = resolve))
    const worker = await startWorker()

    // Main stopped waiting for the first load, and asked again while it went on.
    worker.control({ t: 'load', modelDir, numThreads: 1 })
    worker.control({ t: 'load', modelDir, numThreads: 1 })
    release()
    await vi.waitFor(() => expect(worker.events.filter((e) => e.t === 'loaded')).toHaveLength(2))
    worker.control({ t: 'load', modelDir, numThreads: 1 })
    await vi.waitFor(() => expect(worker.events.filter((e) => e.t === 'loaded')).toHaveLength(3))

    expect(recognizer.loads).toBe(1)
    expect(worker.events.filter((event) => event.t === 'loaded')).toEqual([
      { t: 'loaded', loadMs: 5, engine: 'fake-engine' },
      { t: 'loaded', loadMs: 5, engine: 'fake-engine' },
      { t: 'loaded', loadMs: 5, engine: 'fake-engine' },
    ])
  })

  it('drops audio messages that make no sense, and goes on working (Sp-F2)', async () => {
    const worker = await startWorker()
    worker.control({ t: 'load', modelDir, numThreads: 1 })
    await vi.waitFor(() => expect(worker.events.at(-1)?.t).toBe('loaded'))
    const frame = new Float32Array(FRAME_SAMPLES)

    for (const nonsense of [
      null,
      'pcm',
      { t: 'pcm', session: 1, seq: 0 },
      { t: 'pcm', session: Number.POSITIVE_INFINITY, seq: 0, pcm: frame },
      { t: 'pcm', session: Number.NaN, seq: 0, pcm: frame },
      { t: 'pcm', session: 0, seq: 0, pcm: frame },
      { t: 'pcm', session: 1.5, seq: 0, pcm: frame },
      { t: 'pcm', session: '1', seq: 0, pcm: frame },
      { t: 'pcm', session: 1, seq: -1, pcm: frame },
      { t: 'pcm', session: 1, seq: 0, pcm: Array.from(frame) },
      { t: 'pcm', session: 1, seq: 0, pcm: new Float32Array(FRAME_SAMPLES + 1) },
      { t: 'end', session: Number.POSITIVE_INFINITY, frames: 0 },
      { t: 'end', session: 1, frames: -1 },
      { t: 'probe' },
      { t: 'something else' },
    ]) {
      worker.overlay.send(nonsense)
    }
    // The smoke check is answered with what arrived, whatever that is.
    worker.overlay.send({ t: 'probe', pcm: new Float64Array(3) })
    worker.overlay.send({ t: 'pcm', session: 2, seq: 0, pcm: frame })
    worker.overlay.send({ t: 'end', session: 2, frames: 1 })

    await vi.waitFor(() => expect(worker.events.at(-1)?.t).toBe('final'))
    expect(worker.events.slice(2)).toMatchObject([
      { t: 'probe-ack', samples: 3, isFloat32: false },
      { t: 'final', session: 2, noSpeech: false, lostFrames: 0, chunks: 1 },
    ])
  })
})
