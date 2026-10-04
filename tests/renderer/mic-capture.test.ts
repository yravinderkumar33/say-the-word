import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FRAME_SAMPLES } from '@shared/audio-format'
import type { CaptureEvent } from '@shared/ipc'
import type { AudioMessage } from '@shared/stt-protocol'
import { MicCapture, openMicrophoneCount } from '../../src/renderer/overlay/capture/mic-capture'

/** What loading the worklet does; a test can make it fail once. */
const workletLoad = { fail: null as Error | null, loads: 0 }
vi.mock('../../src/renderer/overlay/capture/load-worklet', () => ({
  loadPcmWorklet: () => {
    workletLoad.loads += 1
    const failure = workletLoad.fail
    workletLoad.fail = null
    return failure ? Promise.reject(failure) : Promise.resolve()
  },
}))

// --- Stand-ins for the browser's audio objects ---------------------------------------

class FakeTrack extends EventTarget {
  stopped = false
  stop(): void {
    this.stopped = true
  }
}

class FakeStream {
  readonly track = new FakeTrack()
  getTracks(): FakeTrack[] {
    return [this.track]
  }
  getAudioTracks(): FakeTrack[] {
    return [this.track]
  }
}

/** The worklet's side of its port: tests push `started`, frames and `flushed` through it. */
class FakeWorkletPort {
  onmessage: ((event: MessageEvent) => void) | null = null
  /** A partial frame the worklet would hand over when asked to flush. */
  held: Float32Array | null = null
  /** True once the page has told the processor it is finished. */
  closed = false
  postMessage(message: unknown): void {
    if (message === 'close') this.closed = true
    if (message !== 'flush') return
    queueMicrotask(() => {
      if (this.held) this.emit(this.held)
      this.emit('flushed')
    })
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

class FakeWorkletNode {
  static latest: FakeWorkletNode | null = null
  readonly port = new FakeWorkletPort()
  disconnected = false
  constructor() {
    FakeWorkletNode.latest = this
  }
  connect<T>(next: T): T {
    return next
  }
  disconnect(): void {
    this.disconnected = true
  }
}

class FakeAudioContext {
  static latest: FakeAudioContext | null = null
  state = 'running'
  destination = {}
  /** `resume` and `suspend`, in the order they were asked for. */
  calls: string[] = []
  constructor() {
    FakeAudioContext.latest = this
  }
  suspend(): Promise<void> {
    this.calls.push('suspend')
    this.state = 'suspended'
    return Promise.resolve()
  }
  createMediaStreamSource(): { connect<T>(next: T): T; disconnect(): void } {
    return { connect: (next) => next, disconnect: () => {} }
  }
  createGain(): { gain: { value: number }; connect<T>(next: T): T } {
    return { gain: { value: 1 }, connect: (next) => next }
  }
  resume(): Promise<void> {
    this.calls.push('resume')
    this.state = 'running'
    return Promise.resolve()
  }
}

type GetUserMedia = (constraints: MediaStreamConstraints) => Promise<FakeStream>

/** Every capture made by a test, so each test starts with no microphone open. */
const captures: MicCapture[] = []
const SESSIONS = [1, 4, 5, 6]

function setup(getUserMedia?: GetUserMedia) {
  const streams: FakeStream[] = []
  const requests: MediaStreamConstraints[] = []
  const open: GetUserMedia =
    getUserMedia ??
    (() => {
      const stream = new FakeStream()
      streams.push(stream)
      return Promise.resolve(stream)
    })
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: (constraints: MediaStreamConstraints) => {
        requests.push(constraints)
        return open(constraints)
      },
      enumerateDevices: () =>
        Promise.resolve([
          { kind: 'audioinput', deviceId: 'default', label: 'Default' },
          { kind: 'audioinput', deviceId: 'built-in', label: 'MacBook Microphone' },
          { kind: 'audioinput', deviceId: '', label: '' },
          { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
        ]),
    },
  })

  const events: CaptureEvent[] = []
  const levels: number[] = []
  const capture = new MicCapture({
    onLevel: (level) => levels.push(level),
    onEvent: (event) => events.push(event),
  })
  captures.push(capture)
  const newPort = (): { port: MessagePort; sent: AudioMessage[] } => {
    const sent: AudioMessage[] = []
    const port = { postMessage: (message: AudioMessage) => sent.push(message) }
    return { port: port as unknown as MessagePort, sent }
  }
  const worker = newPort()
  capture.attachPort(worker.port)

  /** What the worklet does once audio flows: announce it, then deliver frames. */
  const worklet = (): FakeWorkletPort => FakeWorkletNode.latest!.port
  const frame = (value: number, length = FRAME_SAMPLES): Float32Array =>
    new Float32Array(length).fill(value)

  return { capture, events, levels, streams, requests, sent: worker.sent, newPort, worklet, frame }
}

/** Lets pending promise callbacks run, without moving the clock. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0)
}
const kinds = (messages: AudioMessage[]): string[] => messages.map((message) => message.t)

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
  FakeWorkletNode.latest = null
  FakeAudioContext.latest = null
  workletLoad.fail = null
  workletLoad.loads = 0
})

afterEach(() => {
  for (const capture of captures.splice(0)) for (const id of SESSIONS) capture.cancel(id)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('MicCapture', () => {
  it('reports live when audio starts to flow, and sends every frame in order', async () => {
    const t = setup()
    await t.capture.start(5, null)
    expect(t.events).toEqual([])

    t.worklet().emit('started')
    t.worklet().emit(t.frame(0.1))
    t.worklet().emit(t.frame(0.2))

    expect(t.events).toMatchObject([{ kind: 'live', session: 5 }])
    expect(t.sent).toMatchObject([
      { t: 'pcm', session: 5, seq: 0 },
      { t: 'pcm', session: 5, seq: 1 },
    ])
    expect(t.levels.at(-1)).toBeGreaterThan(0)
    expect(openMicrophoneCount()).toBe(1)
  })

  it('asks for the raw signal: no echo cancellation, noise suppression or gain control', async () => {
    const t = setup()
    await t.capture.start(1, null)

    expect(t.requests[0]!.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    })
  })

  it('on stop: keeps a short tail, sends the last partial frame, then ends the session', async () => {
    const t = setup()
    await t.capture.start(5, null)
    t.worklet().emit('started')
    t.worklet().emit(t.frame(0.1))
    const worklet = t.worklet()
    worklet.held = t.frame(0.1, 300)

    const stopping = t.capture.stop(5)
    // Still recording during the tail: a frame that arrives now belongs to the session.
    worklet.emit(t.frame(0.3))
    expect(t.streams[0]!.track.stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    await stopping

    expect(kinds(t.sent)).toEqual(['pcm', 'pcm', 'pcm', 'end'])
    expect(t.sent.at(-2)).toMatchObject({ seq: 2 })
    expect((t.sent.at(-2) as { pcm: Float32Array }).pcm).toHaveLength(300)
    expect(t.sent.at(-1)).toEqual({ t: 'end', session: 5, frames: 3 })
    expect(t.events.at(-1)).toEqual({ kind: 'ended', session: 5, frames: 3, micLost: false })
    expect(t.streams[0]!.track.stopped).toBe(true)
    expect(openMicrophoneCount()).toBe(0)
  })

  it('closes a microphone that only finishes opening after the cancel', async () => {
    let open!: (stream: FakeStream) => void
    const t = setup(() => new Promise((resolve) => (open = resolve)))
    const starting = t.capture.start(5, null)
    await settle()

    t.capture.cancel(5)
    const late = new FakeStream()
    open(late)
    await starting

    expect(late.track.stopped).toBe(true)
    expect(openMicrophoneCount()).toBe(0)
    expect(t.events).toEqual([])
    expect(t.sent).toEqual([])
  })

  it('on cancel: closes the microphone at once and sends nothing more', async () => {
    const t = setup()
    await t.capture.start(5, null)
    const worklet = t.worklet()
    worklet.emit('started')
    worklet.emit(t.frame(0.1))

    t.capture.cancel(5)
    worklet.emit(t.frame(0.2))
    await vi.advanceTimersByTimeAsync(500)

    expect(kinds(t.sent)).toEqual(['pcm'])
    expect(t.streams[0]!.track.stopped).toBe(true)
    expect(t.events.map((event) => event.kind)).toEqual(['live'])
  })

  it('ignores a stop or a cancel meant for another session', async () => {
    const t = setup()
    await t.capture.start(5, null)
    t.worklet().emit('started')

    t.capture.cancel(4)
    await t.capture.stop(6)

    expect(t.streams[0]!.track.stopped).toBe(false)
    expect(openMicrophoneCount()).toBe(1)
    t.capture.cancel(5)
  })

  it('a new session replaces one that is still recording', async () => {
    const t = setup()
    await t.capture.start(5, null)
    t.worklet().emit('started')
    const first = t.worklet()

    await t.capture.start(6, null)
    first.emit(t.frame(0.5))
    t.worklet().emit(t.frame(0.1))

    expect(t.streams[0]!.track.stopped).toBe(true)
    expect(t.sent).toMatchObject([{ t: 'pcm', session: 6, seq: 0 }])
    t.capture.cancel(6)
  })

  it('a stop before the microphone opened ends the session with no audio', async () => {
    let open!: (stream: FakeStream) => void
    const t = setup(() => new Promise((resolve) => (open = resolve)))
    const starting = t.capture.start(5, null)
    await settle()

    const stopping = t.capture.stop(5)
    await vi.advanceTimersByTimeAsync(200)
    await stopping
    const late = new FakeStream()
    open(late)
    await starting

    expect(t.sent).toEqual([{ t: 'end', session: 5, frames: 0 }])
    expect(late.track.stopped).toBe(true)
    expect(openMicrophoneCount()).toBe(0)
  })

  describe('when the speech worker is restarted', () => {
    it('sends the recording in progress to the new worker from its first frame', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      t.worklet().emit(t.frame(0.2))

      const replacement = t.newPort()
      t.capture.attachPort(replacement.port)
      t.worklet().emit(t.frame(0.3))

      expect(replacement.sent).toMatchObject([
        { t: 'pcm', session: 5, seq: 0 },
        { t: 'pcm', session: 5, seq: 1 },
        { t: 'pcm', session: 5, seq: 2 },
      ])
      // Nothing more goes to the worker that is gone.
      expect(t.sent).toHaveLength(2)
      t.capture.cancel(5)
    })

    it('sends a finished recording again while its text is still awaited', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      const stopping = t.capture.stop(5)
      await vi.advanceTimersByTimeAsync(200)
      await stopping

      const replacement = t.newPort()
      t.capture.attachPort(replacement.port)

      expect(replacement.sent).toMatchObject([
        { t: 'pcm', session: 5, seq: 0 },
        { t: 'end', session: 5, frames: 1 },
      ])
    })

    it('sends nothing once the text has arrived, or after a cancel', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      const stopping = t.capture.stop(5)
      await vi.advanceTimersByTimeAsync(200)
      await stopping

      t.capture.forget(5)
      const afterText = t.newPort()
      t.capture.attachPort(afterText.port)
      expect(afterText.sent).toEqual([])

      await t.capture.start(6, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      t.capture.cancel(6)
      const afterCancel = t.newPort()
      t.capture.attachPort(afterCancel.port)
      expect(afterCancel.sent).toEqual([])
    })
  })

  describe('Undo and Retry', () => {
    it('holds a cancelled recording, and sends it when asked', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      t.worklet().emit(t.frame(0.2))
      t.capture.cancel(5)
      const before = t.sent.length

      t.capture.resend(5)

      expect(t.sent.slice(before)).toMatchObject([
        { t: 'pcm', session: 5, seq: 0 },
        { t: 'pcm', session: 5, seq: 1 },
        { t: 'end', session: 5, frames: 2 },
      ])
      // The microphone itself stays closed.
      expect(openMicrophoneCount()).toBe(0)
    })

    it('sends a finished recording again when asked', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      const stopping = t.capture.stop(5)
      await vi.advanceTimersByTimeAsync(200)
      await stopping
      const before = t.sent.length

      t.capture.resend(5)

      expect(kinds(t.sent.slice(before))).toEqual(['pcm', 'end'])
    })

    it('says so when the recording is no longer held', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      t.capture.cancel(5)
      t.capture.forget(5)
      const before = t.sent.length

      t.capture.resend(5)
      t.capture.resend(99)

      expect(t.sent.slice(before)).toEqual([])
      expect(t.events.slice(-2)).toEqual([
        { kind: 'gone', session: 5 },
        { kind: 'gone', session: 99 },
      ])
    })

    it('does not report a recording as gone while it is still being wound up', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      const stopping = t.capture.stop(5)

      // Asked for during the tail: the recording is on its way to the worker already.
      t.capture.resend(5)
      await vi.advanceTimersByTimeAsync(200)
      await stopping

      expect(t.events.map((event) => event.kind)).toEqual(['live', 'ended'])
      expect(kinds(t.sent)).toEqual(['pcm', 'end'])
    })

    it('holds a cancelled recording even when nothing had been captured yet', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.capture.cancel(5)
      const before = t.sent.length

      expect(t.capture.holdsRecording).toBe(true)
      t.capture.resend(5)

      // An empty recording, which the recognizer answers with "no speech".
      expect(t.sent.slice(before)).toEqual([{ t: 'end', session: 5, frames: 0 }])
      expect(t.events.map((event) => event.kind)).not.toContain('gone')
    })

    it('lets the held recording go when the next session starts', async () => {
      const t = setup()
      await t.capture.start(5, null)
      t.worklet().emit('started')
      t.worklet().emit(t.frame(0.1))
      t.capture.cancel(5)

      await t.capture.start(6, null)
      t.capture.resend(5)

      expect(t.events.at(-1)).toEqual({ kind: 'gone', session: 5 })
      t.capture.cancel(6)
    })
  })

  it('lets the audio graph rest between sessions, and wakes it for the next one', async () => {
    const t = setup()
    await t.capture.start(5, null)
    t.worklet().emit('started')
    const stopping = t.capture.stop(5)
    await vi.advanceTimersByTimeAsync(400)
    await stopping

    await t.capture.start(6, null)
    t.capture.cancel(6)

    expect(FakeAudioContext.latest!.calls).toEqual(['resume', 'suspend', 'resume', 'suspend'])
  })

  it('tells the worklet it is finished when a recording ends or is cancelled', async () => {
    const t = setup()
    await t.capture.start(5, null)
    const first = t.worklet()
    const stopping = t.capture.stop(5)
    await vi.advanceTimersByTimeAsync(400)
    await stopping

    await t.capture.start(6, null)
    const second = t.worklet()
    t.capture.cancel(6)

    expect(first.closed).toBe(true)
    expect(second.closed).toBe(true)
  })

  it('never asks for the microphone when the session ended while the audio setup loaded', async () => {
    const t = setup()

    const starting = t.capture.start(5, null)
    t.capture.cancel(5)
    await starting

    expect(t.requests).toEqual([])
    expect(openMicrophoneCount()).toBe(0)
  })

  it('tries the audio setup again after it failed once', async () => {
    const t = setup()
    workletLoad.fail = new Error('The audio worklet could not be loaded')

    await t.capture.start(5, null)
    await t.capture.start(6, null)
    t.worklet().emit('started')

    expect(t.events).toMatchObject([
      { kind: 'failed', session: 5, message: 'The audio worklet could not be loaded' },
      { kind: 'live', session: 6 },
    ])
    expect(workletLoad.loads).toBe(2)
  })

  it('when the microphone goes away: sends what was captured and says so', async () => {
    const t = setup()
    await t.capture.start(5, null)
    t.worklet().emit('started')
    t.worklet().emit(t.frame(0.1))

    t.streams[0]!.track.dispatchEvent(new Event('ended'))
    await vi.advanceTimersByTimeAsync(200)

    expect(t.sent.at(-1)).toEqual({ t: 'end', session: 5, frames: 1 })
    expect(t.events.at(-1)).toEqual({ kind: 'ended', session: 5, frames: 1, micLost: true })
    expect(openMicrophoneCount()).toBe(0)
  })

  it('reports a refused microphone in plain words, and holds nothing open', async () => {
    const t = setup(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))

    await t.capture.start(5, null)

    expect(t.events).toEqual([
      { kind: 'failed', session: 5, message: 'Microphone access was not allowed' },
    ])
    expect(openMicrophoneCount()).toBe(0)
  })

  it('falls back to the default microphone when the chosen one is gone', async () => {
    const stream = new FakeStream()
    const t = setup((constraints) => {
      const audio = constraints.audio as MediaTrackConstraints
      return audio.deviceId
        ? Promise.reject(new DOMException('gone', 'OverconstrainedError'))
        : Promise.resolve(stream)
    })

    await t.capture.start(5, 'usb-headset')
    t.worklet().emit('started')

    expect(t.requests.map((request) => (request.audio as MediaTrackConstraints).deviceId)).toEqual([
      { exact: 'usb-headset' },
      undefined,
    ])
    expect(t.events).toMatchObject([{ kind: 'live', session: 5 }])
    t.capture.cancel(5)
  })

  it('does not fall back when the chosen microphone was refused rather than missing', async () => {
    const t = setup(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))

    await t.capture.start(5, 'usb-headset')

    expect(t.requests).toHaveLength(1)
    expect(t.events).toMatchObject([{ kind: 'failed' }])
  })

  it('lists real microphones only', async () => {
    const t = setup()

    expect(await t.capture.listMicrophones()).toEqual([
      { deviceId: 'built-in', label: 'MacBook Microphone' },
    ])
  })
})
