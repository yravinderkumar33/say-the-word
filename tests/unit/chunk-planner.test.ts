import { describe, expect, it } from 'vitest'
import { ChunkPlanner, splitAtQuietPoints } from '../../src/main/stt/chunk-planner'

// One "second" is 100 samples here, which keeps the numbers readable.
const SECOND = 100
const options = { maxChunkSamples: 15 * SECOND, padBefore: 20, padAfter: 30 }
const seconds = (start: number, end: number) => ({ start: start * SECOND, end: end * SECOND })

describe('ChunkPlanner', () => {
  it('reports no speech and nothing to decode for a silent recording', () => {
    const planner = new ChunkPlanner(options)

    expect(planner.finish(5 * SECOND)).toEqual([])
    expect(planner.hadSpeech).toBe(false)
  })

  it('decodes a short dictation as one chunk at the end, padded on both sides', () => {
    const planner = new ChunkPlanner(options)

    expect(planner.addSpeech(seconds(1, 4))).toEqual([])
    expect(planner.finish(5 * SECOND)).toEqual([{ start: 80, end: 430 }])
    expect(planner.hadSpeech).toBe(true)
  })

  it('keeps several short stretches of speech in one chunk, pauses included', () => {
    const planner = new ChunkPlanner(options)

    expect(planner.addSpeech(seconds(1, 3))).toEqual([])
    expect(planner.addSpeech(seconds(4, 7))).toEqual([])
    expect(planner.addSpeech(seconds(8, 10))).toEqual([])
    expect(planner.finish(11 * SECOND)).toEqual([{ start: 80, end: 1_030 }])
  })

  it('never pads beyond the start or end of the recording', () => {
    const planner = new ChunkPlanner(options)
    planner.addSpeech({ start: 5, end: 395 })

    expect(planner.finish(400)).toEqual([{ start: 0, end: 400 }])
  })

  it('closes a chunk as soon as the next stretch would make it too long', () => {
    const planner = new ChunkPlanner(options)
    planner.addSpeech(seconds(0, 8))

    // 0–8 s plus 9–17 s would be 17 s, over the 15 s limit.
    expect(planner.addSpeech(seconds(9, 17))).toEqual([{ start: 0, end: 830 }])
    expect(planner.finish(18 * SECOND)).toEqual([{ start: 880, end: 1_730 }])
  })

  it('never decodes the same audio twice when chunks sit close together', () => {
    const planner = new ChunkPlanner({ maxChunkSamples: 10 * SECOND, padBefore: 50, padAfter: 50 })
    planner.addSpeech(seconds(0, 9))

    // The second stretch starts 0.2 s after the first ends: the paddings would overlap.
    const first = planner.addSpeech({ start: 920, end: 1_800 })
    const second = planner.finish(20 * SECOND)

    expect(first).toEqual([{ start: 0, end: 920 }])
    expect(second).toEqual([{ start: 920, end: 1_850 }])
  })

  it('hands over a single stretch longer than the limit whole, for splitting by loudness', () => {
    const planner = new ChunkPlanner(options)

    expect(planner.addSpeech(seconds(1, 40))).toEqual([])
    expect(planner.finish(41 * SECOND)).toEqual([{ start: 80, end: 4_030 }])
  })

  it('decodes a long session piece by piece and leaves only the tail for the end', () => {
    const planner = new ChunkPlanner(options)
    const during: unknown[] = []
    for (let start = 0; start < 60; start += 10) {
      during.push(...planner.addSpeech(seconds(start, start + 9)))
    }

    const atEnd = planner.finish(60 * SECOND)

    expect(during).toHaveLength(5)
    expect(atEnd).toHaveLength(1)
  })
})

describe('splitAtQuietPoints', () => {
  const frame = 10
  const searchBack = 200

  /** Loud everywhere except the given ranges, which are silent. */
  function audio(length: number, quiet: Array<[number, number]>): Float32Array {
    const samples = new Float32Array(length).fill(0.5)
    for (const [start, end] of quiet) samples.fill(0, start, end)
    return samples
  }

  it('returns short audio as a single piece', () => {
    expect(splitAtQuietPoints(audio(800, []), 1_000, { frame, searchBack })).toEqual([
      { start: 0, end: 800 },
    ])
  })

  it('cuts in the pause before the limit rather than at the limit', () => {
    const samples = audio(1_500, [[900, 940]])

    const pieces = splitAtQuietPoints(samples, 1_000, { frame, searchBack })

    expect(pieces).toHaveLength(2)
    expect(pieces[0]!.end).toBeGreaterThanOrEqual(900)
    expect(pieces[0]!.end).toBeLessThanOrEqual(940)
  })

  it('covers all of the audio with no gap and no overlap, and respects the limit', () => {
    const samples = audio(4_700, [
      [950, 970],
      [1_800, 1_850],
      [2_700, 2_720],
    ])

    const pieces = splitAtQuietPoints(samples, 1_000, { frame, searchBack })

    expect(pieces[0]!.start).toBe(0)
    expect(pieces.at(-1)!.end).toBe(samples.length)
    for (let index = 1; index < pieces.length; index++) {
      expect(pieces[index]!.start).toBe(pieces[index - 1]!.end)
    }
    for (const piece of pieces) expect(piece.end - piece.start).toBeLessThanOrEqual(1_000)
  })

  it('still cuts within the limit when there is no pause at all', () => {
    const pieces = splitAtQuietPoints(audio(2_500, []), 1_000, { frame, searchBack })

    for (const piece of pieces) expect(piece.end - piece.start).toBeLessThanOrEqual(1_000)
    expect(pieces.at(-1)!.end).toBe(2_500)
  })
})
