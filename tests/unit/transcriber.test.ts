import { describe, expect, it } from 'vitest'
import { SAMPLE_RATE } from '@shared/audio-format'
import type { SampleRange } from '../../src/main/stt/chunk-planner'
import {
  Transcriber,
  type SpeechDetector,
  type SpeechEngine,
  type TranscriberEvent,
} from '../../src/main/stt/transcriber'

const FRAME = 1_600 // 0.1 s, which keeps the arithmetic readable
const seconds = (value: number): number => Math.round(value * SAMPLE_RATE)

/** Reports the speech ranges it was scripted with, as the audio passes them. */
class ScriptedDetector implements SpeechDetector {
  private fed = 0
  private pending: SampleRange[] = []
  resets = 0

  constructor(private readonly script: SampleRange[]) {
    this.pending = [...script]
  }

  reset(): void {
    this.resets += 1
    this.fed = 0
    this.pending = [...this.script]
  }

  accept(samples: Float32Array): SampleRange[] {
    this.fed += samples.length
    const ended = this.pending.filter((range) => range.end <= this.fed)
    this.pending = this.pending.filter((range) => range.end > this.fed)
    return ended
  }

  /** Speech still open when the audio stops is closed at the end of the audio. */
  finish(): SampleRange[] {
    const open = this.pending
      .filter((range) => range.start < this.fed)
      .map((range) => ({ start: range.start, end: Math.min(range.end, this.fed) }))
    this.pending = []
    return open
  }
}

/** "Transcribes" audio as its length, so tests can see exactly what was decoded. */
class FakeEngine implements SpeechEngine {
  decoded: number[] = []
  failWith: Error | null = null
  private gate: Promise<void> = Promise.resolve()

  /** Makes every later decode wait until the returned function is called. */
  hold(): () => void {
    let release!: () => void
    this.gate = new Promise((resolve) => (release = resolve))
    return release
  }

  async transcribe(samples: Float32Array): Promise<{ text: string; decodeMs: number }> {
    await this.gate
    if (this.failWith) throw this.failWith
    this.decoded.push(samples.length)
    return { text: `[${(samples.length / SAMPLE_RATE).toFixed(1)}s]`, decodeMs: 10 }
  }
}

function setup(speech: SampleRange[], maxChunkSec = 30) {
  const events: TranscriberEvent[] = []
  const engine = new FakeEngine()
  const detector = new ScriptedDetector(speech)
  const transcriber = new Transcriber(engine, detector, (event) => events.push(event), {
    maxChunkSec,
    padBeforeSec: 0.2,
    padAfterSec: 0.3,
  })
  /** Feeds `durationSec` of audio as frames and returns how many frames were sent. */
  const feed = (session: number, durationSec: number, fromSeq = 0): number => {
    const frames = Math.round((durationSec * SAMPLE_RATE) / FRAME)
    for (let index = 0; index < frames; index++) {
      transcriber.acceptFrame(session, fromSeq + index, new Float32Array(FRAME))
    }
    return fromSeq + frames
  }
  return { transcriber, engine, detector, events, feed }
}

describe('Transcriber', () => {
  it('decodes a short dictation once, from just before the first word to just after the last', async () => {
    const t = setup([{ start: seconds(1), end: seconds(4) }])
    t.transcriber.begin(1)
    const frames = t.feed(1, 5)

    await t.transcriber.end(1, frames)

    expect(t.engine.decoded).toEqual([seconds(3.5)])
    expect(t.events).toEqual([
      {
        t: 'final',
        session: 1,
        text: '[3.5s]',
        noSpeech: false,
        audioMs: 5_000,
        decodeMs: 10,
        chunks: 1,
        lostFrames: 0,
        // The frames fed here are digital silence.
        peakDb: -120,
        levelDb: -120,
      },
    ])
  })

  it('answers a recording that ended before its first frame, even one it was never told of', async () => {
    const t = setup([])

    // No `begin` and no frame: the key was let go while the microphone was still opening.
    await t.transcriber.end(4, 0)

    expect(t.events).toMatchObject([{ t: 'final', session: 4, noSpeech: true, lostFrames: 0 }])
    expect(t.engine.decoded).toEqual([])
  })

  it('says so when frames were announced and none arrived', async () => {
    const t = setup([])

    await t.transcriber.end(4, 3)

    expect(t.events).toMatchObject([{ t: 'final', session: 4, noSpeech: true, lostFrames: 3 }])
  })

  it('still ignores the end of a session older than the current one', async () => {
    const t = setup([])
    t.transcriber.begin(7)

    await t.transcriber.end(6, 0)

    expect(t.events).toEqual([])
  })

  it('reports how loud the recording was', async () => {
    const t = setup([{ start: seconds(0.2), end: seconds(0.8) }])
    t.transcriber.begin(1)
    // Half a second at a tenth of full scale, then half a second of silence.
    for (let index = 0; index < 5; index++) {
      t.transcriber.acceptFrame(1, index, new Float32Array(FRAME).fill(index % 2 ? 0.1 : -0.1))
    }
    for (let index = 5; index < 10; index++) {
      t.transcriber.acceptFrame(1, index, new Float32Array(FRAME))
    }
    await t.transcriber.end(1, 10)

    // 0.1 of full scale is -20 dB; half the recording at that level averages 3 dB lower.
    expect(t.events).toMatchObject([{ t: 'final', peakDb: -20, levelDb: -23 }])
  })

  it('reports no speech without running the recognizer', async () => {
    const t = setup([])
    t.transcriber.begin(1)
    const frames = t.feed(1, 3)

    await t.transcriber.end(1, frames)

    expect(t.engine.decoded).toEqual([])
    expect(t.events).toMatchObject([{ t: 'final', session: 1, text: '', noSpeech: true }])
  })

  it('includes speech that was still going when the recording stopped', async () => {
    const t = setup([{ start: seconds(1), end: seconds(60) }])
    t.transcriber.begin(1)
    const frames = t.feed(1, 4)

    await t.transcriber.end(1, frames)

    // From 0.8 s (padding before 1 s) to the end of the audio at 4 s.
    expect(t.engine.decoded).toEqual([seconds(3.2)])
  })

  it('decodes a long session piece by piece while it is still being recorded', async () => {
    const speech = [0, 20, 40].map((start) => ({
      start: seconds(start + 1),
      end: seconds(start + 19),
    }))
    const t = setup(speech)
    t.transcriber.begin(1)

    t.feed(1, 45)
    await Promise.resolve()
    // The first stretch was closed and decoded when the second one ended.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(t.engine.decoded.length).toBeGreaterThanOrEqual(1)

    const frames = t.feed(1, 16, 450)
    await t.transcriber.end(1, frames)

    expect(t.events).toMatchObject([{ t: 'final', chunks: 3, noSpeech: false }])
    expect((t.events[0] as { text: string }).text.split(' ')).toHaveLength(3)
  })

  it('splits a stretch with no pause so that no piece exceeds the limit', async () => {
    const t = setup([{ start: 0, end: seconds(70) }], 30)
    t.transcriber.begin(1)
    const frames = t.feed(1, 70)

    await t.transcriber.end(1, frames)

    expect(t.engine.decoded.length).toBeGreaterThanOrEqual(3)
    for (const length of t.engine.decoded) expect(length).toBeLessThanOrEqual(seconds(30))
    expect(t.engine.decoded.reduce((sum, length) => sum + length, 0)).toBe(seconds(70))
  })

  it('counts frames that never arrived', async () => {
    const t = setup([{ start: seconds(0.2), end: seconds(0.8) }])
    t.transcriber.begin(1)
    t.transcriber.acceptFrame(1, 0, new Float32Array(FRAME))
    t.transcriber.acceptFrame(1, 3, new Float32Array(FRAME))

    await t.transcriber.end(1, 6)

    expect(t.events).toMatchObject([{ t: 'final', lostFrames: 4 }])
  })

  it('drops frames that belong to an older session', async () => {
    const t = setup([{ start: seconds(0.1), end: seconds(0.4) }])
    t.transcriber.begin(2)
    t.feed(1, 5)
    const frames = t.feed(2, 0.5)

    await t.transcriber.end(2, frames)

    expect(t.events).toMatchObject([{ t: 'final', session: 2, audioMs: 500 }])
  })

  it('starts a session from its first frame when the frame arrives before `begin`', async () => {
    const t = setup([{ start: seconds(0.1), end: seconds(0.4) }])
    const frames = t.feed(7, 0.5)
    t.transcriber.begin(7)

    await t.transcriber.end(7, frames)

    expect(t.events).toMatchObject([{ t: 'final', session: 7, audioMs: 500 }])
  })

  it('never reports a cancelled session, even if a decode was under way', async () => {
    const t = setup([{ start: seconds(1), end: seconds(4) }])
    const release = t.engine.hold()
    t.transcriber.begin(1)
    const frames = t.feed(1, 5)
    const ended = t.transcriber.end(1, frames)

    t.transcriber.cancel(1)
    release()
    await ended

    expect(t.events).toEqual([])
  })

  it('ignores an `end` for a session that is not current', async () => {
    const t = setup([])
    t.transcriber.begin(2)

    await t.transcriber.end(1, 0)

    expect(t.events).toEqual([])
  })

  it('reports a recognizer failure for the session', async () => {
    const t = setup([{ start: seconds(1), end: seconds(2) }])
    t.engine.failWith = new Error('recognizer broke')
    t.transcriber.begin(1)
    const frames = t.feed(1, 3)

    await t.transcriber.end(1, frames)

    expect(t.events).toEqual([{ t: 'failed', session: 1, message: 'recognizer broke' }])
  })

  it('starts the session over when the sender replays the recording from the start', async () => {
    const t = setup([{ start: seconds(0.1), end: seconds(0.9) }])
    t.transcriber.begin(1)
    t.feed(1, 0.5)

    const frames = t.feed(1, 1)
    await t.transcriber.end(1, frames)

    expect(t.events).toMatchObject([{ t: 'final', session: 1, audioMs: 1_000, lostFrames: 0 }])
    expect(t.detector.resets).toBe(2)
  })

  it('is ready for the next session after one ends', async () => {
    const t = setup([{ start: seconds(0.1), end: seconds(0.4) }])
    t.transcriber.begin(1)
    await t.transcriber.end(1, t.feed(1, 0.5))
    t.transcriber.begin(2)
    await t.transcriber.end(2, t.feed(2, 0.5))

    expect(t.events.map((event) => event.session)).toEqual([1, 2])
  })

  describe('handing over the recording (evaluation mode)', () => {
    const audio = (events: TranscriberEvent[]) =>
      events.filter((event) => event.t === 'audio') as Array<
        Extract<TranscriberEvent, { t: 'audio' }>
      >

    it('hands over nothing unless asked', async () => {
      const t = setup([{ start: seconds(1), end: seconds(2) }])
      t.transcriber.begin(1)
      await t.transcriber.end(1, t.feed(1, 3))

      expect(audio(t.events)).toEqual([])
    })

    it('hands over the whole recording when the session ends, before its text', async () => {
      const t = setup([{ start: seconds(1), end: seconds(2) }])
      t.transcriber.wantAudio(1)
      t.transcriber.begin(1)
      await t.transcriber.end(1, t.feed(1, 3))

      expect(t.events.map((event) => event.t)).toEqual(['audio', 'final'])
      expect(audio(t.events)[0]).toMatchObject({ session: 1 })
      expect(audio(t.events)[0]!.samples).toHaveLength(seconds(3))
    })

    it('can be asked while the recording is already under way', async () => {
      const t = setup([{ start: seconds(1), end: seconds(2) }])
      t.transcriber.begin(1)
      const frames = t.feed(1, 3)
      t.transcriber.wantAudio(1)
      await t.transcriber.end(1, frames)

      expect(audio(t.events)).toHaveLength(1)
    })

    it('hands over nothing for a cancelled session, or for another session', async () => {
      const t = setup([{ start: seconds(1), end: seconds(2) }])
      t.transcriber.wantAudio(1)
      t.transcriber.begin(1)
      t.feed(1, 3)
      t.transcriber.cancel(1)

      t.transcriber.begin(2)
      await t.transcriber.end(2, t.feed(2, 3))

      expect(audio(t.events)).toEqual([])
    })

    it('hands a recording over once', async () => {
      const t = setup([{ start: seconds(1), end: seconds(2) }])
      t.transcriber.wantAudio(1)
      t.transcriber.begin(1)
      await t.transcriber.end(1, t.feed(1, 3))
      t.transcriber.begin(2)
      await t.transcriber.end(2, t.feed(2, 3))

      expect(audio(t.events).map((event) => event.session)).toEqual([1])
    })
  })
})
