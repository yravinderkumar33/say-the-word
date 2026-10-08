import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DictationMode, Usage } from '@shared/ipc'
import {
  UsageStore,
  dayKey,
  daysOfWeekSoFar,
  firstDayOfWeek,
  usageSummary,
} from '../../src/main/store/usage'

/** The folders the tests made, removed after each of them. */
const made: string[] = []
const file = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'flow-usage-'))
  made.push(dir)
  return join(dir, 'usage.json')
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})
/** Local time, as the store counts days. 2026-10-07 is a Wednesday. */
const at = (day: number, hour = 12): Date => new Date(2026, 9, day, hour)
const pasted = (words: number, ms: number | null = 400) => ({
  words,
  mode: 'verbatim' as const,
  releaseToPasteMs: ms,
})
/** The figures as main works them out from what the store hands over: a week from Monday. */
const summary = (usage: UsageStore, mode: DictationMode, now: Date, weekStartsOn = 1): Usage =>
  usageSummary(usage.snapshot(), mode, now, weekStartsOn)

describe('UsageStore', () => {
  it('makes no file until there is something to count', () => {
    const path = file()
    const usage = new UsageStore(path)
    expect(usage.bytesOnDisk).toBe(0)
    expect(existsSync(usage.databasePath)).toBe(false)

    usage.add(pasted(4), at(7))
    expect(existsSync(usage.databasePath)).toBe(true)
    expect(summary(new UsageStore(path), 'verbatim', at(7)).wordsToday).toBe(4)
  })

  it('holds a count it cannot write, says so, and writes it when it can', () => {
    const path = file()
    // Something is in the way of the database, for now.
    mkdirSync(join(path, '..', 'usage.sqlite'))
    const usage = new UsageStore(path)
    expect(usage.add(pasted(5), at(7), 'receipt-1')).toBe(false)
    expect(usage.waitingIds()).toEqual(['receipt-1'])
    expect(summary(usage, 'verbatim', at(7)).wordsToday).toBe(5)

    rmSync(join(path, '..', 'usage.sqlite'), { recursive: true })
    expect(usage.flush()).toBe(true)
    expect(usage.waitingIds()).toEqual([])
    expect(summary(new UsageStore(path), 'verbatim', at(7)).wordsToday).toBe(5)
  })

  it('starts from nothing', () => {
    expect(summary(new UsageStore(file()), 'verbatim', at(7))).toEqual({
      wordsToday: 0,
      wordsThisWeek: 0,
      typicalMs: null,
    })
  })

  it('adds up the words of a day, and of the week so far', () => {
    const usage = new UsageStore(file())
    usage.add(pasted(100), at(5)) // Monday
    usage.add(pasted(40), at(6))
    usage.add(pasted(7), at(7, 9))
    usage.add(pasted(3), at(7, 23))

    expect(summary(usage, 'verbatim', at(7))).toMatchObject({ wordsToday: 10, wordsThisWeek: 150 })
  })

  it('starts the week afresh on its first day', () => {
    const usage = new UsageStore(file())
    usage.add(pasted(500), at(4)) // the Sunday before
    usage.add(pasted(20), at(5))

    expect(summary(usage, 'verbatim', at(5))).toMatchObject({ wordsToday: 20, wordsThisWeek: 20 })
    // Where a week starts on Sunday, that Sunday belongs to it.
    const sundayFirst = new UsageStore(file())
    sundayFirst.add(pasted(500), at(4))
    sundayFirst.add(pasted(20), at(5))
    expect(summary(sundayFirst, 'verbatim', at(5), 0).wordsThisWeek).toBe(520)
  })

  it('gives the usual time as the middle one, apart for each mode', () => {
    const usage = new UsageStore(file())
    for (const ms of [300, 9_000, 400, 380, 420]) usage.add(pasted(5, ms), at(7))
    usage.add({ words: 5, mode: 'cleaned', releaseToPasteMs: 1_100 }, at(7))
    usage.add({ words: 5, mode: 'cleaned', releaseToPasteMs: 900 }, at(7))

    expect(summary(usage, 'verbatim', at(7)).typicalMs).toBe(400)
    expect(summary(usage, 'cleaned', at(7)).typicalMs).toBe(1_000)
  })

  it('counts the words of a dictation that was not pasted, and takes no time from it', () => {
    const usage = new UsageStore(file())
    usage.add(pasted(12, null), at(7))

    expect(summary(usage, 'verbatim', at(7))).toEqual({
      wordsToday: 12,
      wordsThisWeek: 12,
      typicalMs: null,
    })
  })

  it('is still there after a restart', () => {
    const path = file()
    new UsageStore(path).add(pasted(64, 350), at(7))

    expect(summary(new UsageStore(path), 'verbatim', at(7))).toEqual({
      wordsToday: 64,
      wordsThisWeek: 64,
      typicalMs: 350,
    })
  })

  it('keeps numbers and dates in its file, and nothing else', () => {
    const path = file()
    new UsageStore(path).add(pasted(64, 350), at(7))

    expect(new UsageStore(path).snapshot()).toEqual({
      version: 1,
      words: { '2026-10-07': 64 },
      timings: { verbatim: [350], cleaned: [] },
    })
  })

  it('lets go of days and timings that are too old to be shown', () => {
    const usage = new UsageStore(file())
    for (let day = 1; day <= 30; day++) usage.add(pasted(1, day), new Date(2026, 8, day, 12))
    for (let more = 0; more < 60; more++)
      usage.add(pasted(1, 1_000 + more), new Date(2026, 8, 30, 13))

    const kept = usage.snapshot()
    expect(Object.keys(kept.words)).toHaveLength(14)
    expect(Object.keys(kept.words).sort()[0]).toBe('2026-09-17')
    expect(kept.timings.verbatim).toHaveLength(40)
    expect(kept.timings.verbatim.at(-1)).toBe(1_059)
  })

  it('starts from nothing when its file cannot be used', () => {
    const path = file()
    writeFileSync(path, '{ "version": 1, "words": "many" ')

    expect(summary(new UsageStore(path), 'verbatim', at(7)).wordsToday).toBe(0)
  })

  it('goes on without a file it cannot write', () => {
    // A file where the folder should be: nothing can be written under it.
    const inTheWay = file()
    writeFileSync(inTheWay, 'a file, not a folder')
    const path = join(inTheWay, 'usage.json')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const usage = new UsageStore(path)

    expect(() => usage.add(pasted(9), at(7))).not.toThrow()
    expect(summary(usage, 'verbatim', at(7)).wordsToday).toBe(9)
    expect(existsSync(path)).toBe(false)
    vi.restoreAllMocks()
  })
})

describe('days and weeks', () => {
  it('names a day by its local date', () => {
    expect(dayKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('lists the days of the week up to today', () => {
    expect(daysOfWeekSoFar(at(7), 1)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07'])
    expect(daysOfWeekSoFar(at(5), 1)).toEqual(['2026-10-05'])
    expect(daysOfWeekSoFar(at(4), 1)).toHaveLength(7)
    expect(daysOfWeekSoFar(at(4), 0)).toEqual(['2026-10-04'])
  })

  it('takes the first day of the week from where the Mac is set up to be', () => {
    expect(firstDayOfWeek('en-GB')).toBe(1)
    expect(firstDayOfWeek('en-US')).toBe(0)
    expect(firstDayOfWeek('not a locale')).toBe(1)
  })
})
