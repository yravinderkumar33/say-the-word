import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { outputLock } from '../../scripts/lib/build-output.mjs'

// Process numbers this test stands in for; none of them is this process or its parent.
const PACK = 4_000_001
const BUILD = 4_000_002
const MONDAY = 'Mon Oct  5 10:00:00 2026'
const LATER = 'Mon Oct  5 18:00:00 2026'

/** The processes running, by number, with the time each started (null: `ps` cannot say). */
const running = (processes: Record<number, string | null>) => ({
  isRunning: (pid: number) => pid in processes,
  started: (pid: number) => processes[pid] ?? null,
})

/** Where the note goes in a folder of the test's own, with no note in it yet. */
function noteIn(): string {
  const out = join(mkdtempSync(join(tmpdir(), 'flow-build-output-')), 'out')
  mkdirSync(out)
  return join(out, '.in-use.json')
}
const holderOf = (note: string) => JSON.parse(readFileSync(note, 'utf8'))

describe('the lock on the build output', () => {
  it('takes a free build output, and notes who took it and when that process started', () => {
    const note = noteIn()
    const lock = outputLock(note, running({ [BUILD]: MONDAY }))
    expect(lock.take('build', BUILD)).toBeNull()
    expect(holderOf(note)).toEqual({ pid: BUILD, what: 'build', started: MONDAY })
    // Nothing of the way it was written is left beside it.
    expect(readdirSync(join(note, '..'))).toEqual(['.in-use.json'])
  })

  it('refuses while the holder runs, and names it', () => {
    const note = noteIn()
    const lock = outputLock(note, running({ [PACK]: MONDAY, [BUILD]: LATER }))
    expect(lock.take('pack', PACK)).toBeNull()
    expect(lock.take('build', BUILD)).toMatch(/^"pack" is running \(process 4000001\)/)
    expect(holderOf(note).pid).toBe(PACK)
  })

  it('takes it from a holder that has ended', () => {
    const note = noteIn()
    expect(outputLock(note, running({ [PACK]: MONDAY })).take('pack', PACK)).toBeNull()
    expect(outputLock(note, running({ [BUILD]: LATER })).take('build', BUILD)).toBeNull()
    expect(holderOf(note).what).toBe('build')
  })

  it('does not take a later process given the same number for the holder', () => {
    const note = noteIn()
    expect(outputLock(note, running({ [PACK]: MONDAY })).take('pack', PACK)).toBeNull()
    // However long a run lasts, its note stands for as long as it runs, and no longer.
    const reused = running({ [PACK]: LATER, [BUILD]: LATER })
    expect(outputLock(note, reused).take('build', BUILD)).toBeNull()
  })

  it('takes a running holder whose start cannot be read to be the one', () => {
    const note = noteIn()
    expect(outputLock(note, running({ [PACK]: MONDAY })).take('pack', PACK)).toBeNull()
    const unreadable = running({ [PACK]: null, [BUILD]: LATER })
    expect(outputLock(note, unreadable).take('build', BUILD)).toMatch(/"pack" is running/)
  })

  it('keeps a note written before start times were, while its process runs', () => {
    const note = noteIn()
    writeFileSync(note, JSON.stringify({ pid: PACK, what: 'test:app', since: Date.now() }))
    const lock = outputLock(note, running({ [PACK]: MONDAY, [BUILD]: LATER }))
    expect(lock.take('build', BUILD)).toMatch(/"test:app" is running/)
  })

  it('replaces a note that cannot be read', () => {
    const note = noteIn()
    writeFileSync(note, '{"pid": 40')
    expect(outputLock(note, running({ [BUILD]: LATER })).take('build', BUILD)).toBeNull()
    expect(holderOf(note).what).toBe('build')
  })

  it('lets a step of the command line that holds it take it over', () => {
    const note = noteIn()
    const line = running({ [process.ppid]: MONDAY, [BUILD]: LATER })
    expect(outputLock(note, line).take('build', process.ppid)).toBeNull()
    expect(outputLock(note, line).take('test:app', BUILD)).toBeNull()
    expect(holderOf(note)).toEqual({ pid: BUILD, what: 'test:app', started: LATER })
  })
})
