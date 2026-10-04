import { describe, expect, it } from 'vitest'
import { SessionMetrics, formatTimings } from '../../src/main/dictation/session-metrics'

describe('SessionMetrics', () => {
  it('turns the moments of a dictation into durations', () => {
    const metrics = new SessionMetrics()
    metrics.started(7, 1_000)
    metrics.live(7, 1_140, 122.6)
    metrics.released(7, 6_000)
    metrics.decoded(7, {
      audioMs: 5_152.4,
      decodeMs: 210.7,
      chunks: 1,
      peakDb: -9.5,
      levelDb: -31.2,
    })
    metrics.textReady(7, 6_390)
    metrics.pasteSent(7, 6_392)
    metrics.pasteDone(7, 6_430)

    expect(metrics.finish(7, 'pasted')).toEqual({
      session: 7,
      outcome: 'pasted',
      micLiveMs: 140,
      micOpenMs: 123,
      heldMs: 5_000,
      audioMs: 5_152,
      decodeMs: 211,
      chunks: 1,
      peakDb: -9.5,
      levelDb: -31.2,
      releaseToTextMs: 390,
      releaseToPasteMs: 392,
      pasteMs: 38,
      cleanup: null,
      cleanupMs: null,
    })
  })

  it('records what cleanup did and how long it took', () => {
    const metrics = new SessionMetrics()
    metrics.started(2, 0)
    metrics.cleaned(2, 'guard:invented', 1_240)

    const timings = metrics.finish(2, 'pasted')

    expect(timings).toMatchObject({ cleanup: 'guard:invented', cleanupMs: 1_240 })
    expect(formatTimings(timings!)).toBe(
      '[metrics] session=2 outcome=pasted cleanup=guard:invented cleanupMs=1240',
    )
  })

  it('leaves out what never happened', () => {
    const metrics = new SessionMetrics()
    metrics.started(1, 0)
    metrics.live(1, 90, 80)

    const timings = metrics.finish(1, 'cancelled')

    expect(timings).toMatchObject({ micLiveMs: 90, heldMs: null, releaseToPasteMs: null })
    expect(formatTimings(timings!)).toBe(
      '[metrics] session=1 outcome=cancelled micLiveMs=90 micOpenMs=80',
    )
  })

  it('keeps the first of each moment, so a repeat cannot move it', () => {
    const metrics = new SessionMetrics()
    metrics.started(1, 0)
    metrics.live(1, 100, 100)
    metrics.live(1, 900, 900)
    metrics.released(1, 2_000)
    metrics.released(1, 5_000)
    metrics.textReady(1, 2_300)
    metrics.textReady(1, 9_000)

    expect(metrics.finish(1, 'pasted')).toMatchObject({
      micLiveMs: 100,
      heldMs: 2_000,
      releaseToTextMs: 300,
    })
  })

  it('reports a session once, and ignores moments of sessions it does not know', () => {
    const metrics = new SessionMetrics()
    metrics.live(3, 10, 10)
    metrics.released(3, 20)
    expect(metrics.finish(3, 'none')).toBeNull()

    metrics.started(4, 0)
    expect(metrics.finish(4, 'none')).not.toBeNull()
    expect(metrics.finish(4, 'none')).toBeNull()
  })

  it('does not grow without bound when sessions are never finished', () => {
    const metrics = new SessionMetrics()
    for (let session = 1; session <= 50; session++) metrics.started(session, session)

    expect(metrics.finish(1, 'none')).toBeNull()
    expect(metrics.finish(50, 'none')).not.toBeNull()
  })
})
