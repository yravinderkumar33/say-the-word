import { describe, expect, it } from 'vitest'
import { PAUSE_MS, Pause, clockTime } from '../../src/main/dictation/pause'

function setup() {
  const changes: Array<number | null> = []
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  const clock = { now: 1_000_000 }
  const pause = new Pause({
    now: () => clock.now,
    onChange: (until) => changes.push(until),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })
  return { pause, changes, timers, clock }
}

describe('pausing dictation', () => {
  it('lasts an hour, and says until when', () => {
    const { pause, changes, timers } = setup()

    pause.start()

    expect(pause.active).toBe(true)
    expect(pause.until).toBe(1_000_000 + PAUSE_MS)
    expect(changes).toEqual([1_000_000 + PAUSE_MS])
    expect(timers.map((timer) => timer.ms)).toEqual([60 * 60_000])
  })

  it('ends by itself when its time is up', () => {
    const { pause, changes, timers, clock } = setup()
    pause.start()

    clock.now += PAUSE_MS
    timers[0]?.run()

    expect(pause.active).toBe(false)
    expect(pause.until).toBeNull()
    expect(changes.at(-1)).toBeNull()
  })

  it('waits out the rest of its time when its timer runs early by the clock', () => {
    const { pause, changes, timers, clock } = setup()
    pause.start()

    clock.now += 59 * 60_000
    timers[0]?.run()

    expect(pause.active).toBe(true)
    expect(timers.at(-1)?.ms).toBe(60_000)
    expect(changes).toEqual([1_000_000 + PAUSE_MS])
  })

  it('ends at the time it said after a sleep, whose time its timer does not count', () => {
    const { pause, changes, timers, clock } = setup()
    pause.start()

    // Asleep for an hour and a half: the timer has not run, but the hour is up.
    clock.now += 90 * 60_000
    pause.recheck()

    expect(pause.active).toBe(false)
    expect(changes).toEqual([1_000_000 + PAUSE_MS, null])
    expect(timers[0]?.cleared).toBe(true)
  })

  it('is due sooner after a sleep that did not reach its end', () => {
    const { pause, changes, timers, clock } = setup()
    pause.start()

    clock.now += 40 * 60_000
    pause.recheck()

    expect(pause.active).toBe(true)
    expect(pause.until).toBe(1_000_000 + PAUSE_MS)
    expect(timers[0]?.cleared).toBe(true)
    expect(timers.at(-1)?.ms).toBe(20 * 60_000)
    expect(changes).toEqual([1_000_000 + PAUSE_MS])
  })

  it('does nothing on a wake when it is not paused', () => {
    const { pause, changes, timers } = setup()

    pause.recheck()

    expect(changes).toEqual([])
    expect(timers).toEqual([])
  })

  it('ends when it is resumed, and its timer goes with it', () => {
    const { pause, changes, timers } = setup()
    pause.start()

    pause.end()

    expect(changes).toEqual([1_000_000 + PAUSE_MS, null])
    expect(timers[0]?.cleared).toBe(true)
  })

  it('says nothing when it is resumed although it was not paused', () => {
    const { pause, changes } = setup()

    pause.end()

    expect(changes).toEqual([])
  })

  it('starts over when it is paused again', () => {
    const { pause, clock, timers } = setup()
    pause.start()
    clock.now += 30 * 60_000

    pause.start()

    expect(pause.until).toBe(clock.now + PAUSE_MS)
    expect(timers[0]?.cleared).toBe(true)
    expect(timers).toHaveLength(2)
  })

  it('writes a time of day as the menu says it', () => {
    expect(clockTime(new Date(2026, 9, 4, 11, 42).getTime())).toBe('11:42')
    expect(clockTime(new Date(2026, 9, 4, 9, 5).getTime())).toBe('09:05')
  })
})
