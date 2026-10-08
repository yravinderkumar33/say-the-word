import type * as FsRuntime from 'node:fs'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, HistoryKeep } from '@shared/ipc'
import { HistoryStore, rowOf } from '../../src/main/history/history-store'
import { transaction } from '../../src/main/storage/sqlite'

const faults = vi.hoisted(() => new Set<string>())
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof FsRuntime>()
  return {
    ...real,
    rmSync: ((path, options) => {
      if (faults.has(String(path))) throw new Error('test removal fault')
      return real.rmSync(path, options)
    }) as typeof real.rmSync,
  }
})
const DAY = 86400000
const NOW = Date.UTC(2026, 9, 5, 12)
let dir: string
let clock: number
const stores: HistoryStore[] = []
const entry = (id: string, change: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  endedAt: clock,
  app: 'Notes',
  outcome: 'pasted',
  fetched: null,
  mode: 'verbatim',
  note: null,
  heard: `heard ${id}`,
  written: `written ${id}`,
  failure: null,
  audioMs: 4000,
  timings: { releaseToTextMs: 400, tidyMs: null, pasteMs: 40 },
  ...change,
})
function store(keep: HistoryKeep = 'session', known = true, limit = 1000) {
  const value = new HistoryStore({
    dir,
    keep,
    keepIsKnown: known,
    paused: false,
    now: () => clock,
    memoryLimit: limit,
  })
  stores.push(value)
  return value
}
const files = () => (existsSync(dir) ? readdirSync(dir).sort() : [])
const ids = (value: HistoryStore) =>
  value.page({ search: '', limit: 2000 }).rows.map((row) => row.id)
const legacy = (name: string, entries: unknown[]) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify({ version: 1, entries }))
}
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'flow-history-')), 'history')
  clock = NOW
})
afterEach(() => {
  for (const value of stores.splice(0)) value.close()
  if (existsSync(dir)) chmodSync(dir, 0o700)
  rmSync(join(dir, '..'), { recursive: true, force: true })
  faults.clear()
  vi.restoreAllMocks()
})

describe('SQLite history and privacy', () => {
  it('session history creates no transcript-bearing files', () => {
    const h = store()
    h.put(entry('a'))
    h.patch('a', { fetched: 'copied' })
    expect(h.count).toBe(1)
    expect(files()).toEqual([])
  })
  it('sorts by time and deterministic id, independent of arrival order', () => {
    const h = store()
    h.put(entry('a'))
    h.put(entry('b'))
    h.put(entry('c', { endedAt: NOW - DAY }))
    expect(ids(h)).toEqual(['b', 'a', 'c'])
  })
  it('returns previews in lists and full text only in detail', () => {
    const h = store()
    h.put(entry('a', { written: 'line\n' + 'word '.repeat(100) }))
    expect(h.newest(1)[0]?.text.length).toBe(240)
    expect(h.get('a')?.written.length).toBeGreaterThan(240)
    expect(rowOf(entry('b', { written: 'one\n two' })).text).toBe('one two')
  })
  it('preserves case-insensitive substring AND searches and counts', () => {
    const h = store()
    h.put(entry('a', { written: 'Thursday review', heard: 'um review', app: 'Slack' }))
    h.put(entry('b', { written: 'Review diff', app: 'Terminal' }))
    expect(h.page({ search: 'REVIEW thur', limit: 1 })).toMatchObject({
      total: 2,
      matched: 1,
      rows: [{ id: 'a' }],
    })
    expect(h.page({ search: 'um slack', limit: 1 }).matched).toBe(1)
  })
  it('does not interpolate SQL from search strings', () => {
    const h = store()
    h.put(entry('a'))
    expect(h.page({ search: "' OR 1=1 --", limit: 10 }).matched).toBe(0)
    expect(h.count).toBe(1)
  })
  it('caps ordinary session entries and ignores new entries while paused', () => {
    const h = store('session', true, 2)
    for (const id of ['a', 'b', 'c']) {
      clock++
      h.put(entry(id))
    }
    expect(ids(h)).toEqual(['c', 'b'])
    h.setPaused(true)
    h.put(entry('d'))
    h.patch('c', { fetched: 'copied' })
    expect(h.count).toBe(2)
    expect(h.get('c')?.fetched).toBe('copied')
  })
  it('indexes usable text separately from empty outcomes', () => {
    const h = store()
    h.put(entry('a'))
    h.put(entry('b', { written: ' ' }))
    expect(h.newestWithText(1)[0]?.id).toBe('a')
  })
  it('updates an idempotent row without duplicating history', () => {
    const h = store('forever')
    h.put(entry('a'))
    h.put(entry('a', { endedAt: NOW + DAY, outcome: 'focusMoved' }))
    expect(store('forever').count).toBe(1)
    expect(store('forever').get('a')?.outcome).toBe('focusMoved')
  })
  it('retains timing fields when a later outcome has no new timing', () => {
    const h = store()
    h.put(entry('a'))
    h.put(
      entry('a', {
        audioMs: null,
        timings: { releaseToTextMs: null, tidyMs: null, pasteMs: null },
      }),
      true,
    )
    expect(h.get('a')?.audioMs).toBe(4000)
  })
  it('creates one restrictive database only after explicit consent', () => {
    const h = store()
    h.put(entry('a'))
    h.setKeep('forever')
    expect(files()).toEqual(['history.sqlite'])
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(h.file).mode & 0o777).toBe(0o600)
    expect(store('forever').count).toBe(1)
  })
  it('unknown retention preserves all legacy and database files without opening them (QA-01)', () => {
    legacy('2026-10-03.json', [entry('old')])
    writeFileSync(join(dir, 'history.sqlite'), 'corrupt')
    const h = store('session', false)
    h.put(entry('new'))
    expect(h.count).toBe(1)
    expect(files()).toEqual(['2026-10-03.json', 'history.sqlite'])
    expect(h.diskFacts().files).toBe(2)
  })
  it('counts what a time to keep lists again, and what it deletes at once, before the question', () => {
    // Saved for good, then the settings could no longer say so: the database is kept, unlisted.
    const saved = store('forever')
    saved.put(entry('old', { endedAt: NOW - 40 * DAY }))
    saved.put(entry('recent', { endedAt: NOW - DAY }))
    legacy('2026-08-01.json', [entry('older', { endedAt: NOW - 60 * DAY })])
    const h = store('session', false)
    h.put(entry('now'))

    // The question is put before anything is opened or changed.
    expect(h.preview('week')).toEqual({ startsWriting: true, expiring: 2, relisted: 3 })
    expect(files()).toEqual(['2026-08-01.json', 'history.sqlite'])
    expect(h.preview('forever')).toMatchObject({ expiring: 0, relisted: 3 })

    // What the answer then does is what the question said.
    h.setKeep('week')
    expect(ids(h)).toEqual(['now', 'recent'])
  })
  it('removes at the start a day file the earlier format never finished, when the history is kept', () => {
    legacy('2026-10-03.json', [entry('kept')])
    writeFileSync(join(dir, '2026-10-03.json.tmp'), JSON.stringify({ version: 1, entries: [] }))
    const h = store('forever')
    expect(files()).toEqual(['history.sqlite'])
    expect(ids(h)).toEqual(['kept'])
  })
  it('leaves a never-finished file alone while it does not know how long the history is kept', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '2026-10-03.json.tmp'), 'partial')
    store('session', false)
    expect(files()).toEqual(['2026-10-03.json.tmp'])
  })
  it('reads a file left in the folder once for each version of it, not at every look', () => {
    legacy('2026-10-04.json', [entry('old')])
    const path = join(dir, '2026-10-04.json')
    // Whole seconds, so that setting the time again gives back exactly the same time.
    const time = new Date(Date.UTC(2026, 9, 4, 12))
    utimesSync(path, time, time)
    const h = store('session', false)
    expect(h.diskFacts().unreadableFiles).toBe(0)
    // The same size and time, other bytes: what was learnt about it stands.
    writeFileSync(path, 'x'.repeat(statSync(path).size))
    utimesSync(path, time, time)
    expect(h.diskFacts().unreadableFiles).toBe(0)
    // Changed: read again.
    const later = new Date(time.getTime() + 60_000)
    utimesSync(path, later, later)
    expect(h.diskFacts().unreadableFiles).toBe(1)
  })
  it('explicit fallback choice removes leftovers even when equal to the fallback', () => {
    legacy('2026-10-03.json', [entry('old')])
    const h = store('session', false)
    h.setKeep('session')
    expect(files()).toEqual([])
  })
  it('transfers every persistent row into session SQLite without the ordinary cap', () => {
    const h = store('forever', true, 2)
    for (let i = 0; i < 8; i++) h.put(entry(String(i)))
    h.setKeep('session')
    h.put(entry('new'))
    expect(h.count).toBe(9)
    expect(files()).toEqual([])
    expect(store().count).toBe(0)
  })
  it('expires rows transactionally after a retention change or restart', () => {
    const h = store('forever')
    h.put(entry('old', { endedAt: NOW - 8 * DAY }))
    h.put(entry('recent'))
    expect(h.preview('week').expiring).toBe(1)
    h.setKeep('week')
    expect(ids(h)).toEqual(['recent'])
    clock += 8 * DAY
    expect(store('week').count).toBe(0)
  })
  it('deletes rows independent of time zone', () => {
    const h = store('forever')
    h.put(entry('a', { endedAt: Date.UTC(2026, 9, 4, 3, 30) }))
    expect(h.remove('a')).toBe(true)
    expect(store('forever').count).toBe(0)
  })
  it('clears rows and all owned files while preserving unrelated files (QA-07)', () => {
    const h = store('forever')
    h.put(entry('a'))
    legacy('2026-10-04.json', [])
    writeFileSync(join(dir, '2026-10-03.json.tmp'), 'partial')
    writeFileSync(join(dir, 'notes.txt'), 'unrelated')
    expect(h.clear()).toMatchObject({ deleted: 1, failed: 0, failedFiles: 0 })
    expect(files()).toEqual(['notes.txt'])
    h.put(entry('next'))
    expect(store('forever').count).toBe(1)
  })
  it('after Delete All, nothing is made on disk again until there is a dictation to keep', () => {
    const h = store('week')
    h.put(entry('a'))
    h.clear()
    // The hourly sweep, and a try at what waits, find nothing to write.
    h.sweep()
    h.flush()
    expect(files()).toEqual([])

    // The next dictation makes the database, and is written at once.
    h.put(entry('b'))
    expect(h.waitingIds()).toEqual([])
    expect(store('week').count).toBe(1)
  })
  it('reports corrupt orphan files separately from readable row count (QA-07)', () => {
    legacy('2026-10-04.json', [])
    writeFileSync(join(dir, '2026-10-04.json'), 'malformed')
    const h = store('session', false)
    expect(h.count).toBe(0)
    expect(h.diskFacts()).toMatchObject({ files: 1, unreadableFiles: 1 })
    expect(h.clear()).toMatchObject({ deleted: 0, deletedFiles: 1, failedFiles: 0 })
  })
  it('reports enumeration failure and leaves deletion available (QA-07)', () => {
    mkdirSync(dir, { recursive: true })
    const h = store('session', false)
    chmodSync(dir, 0o000)
    expect(h.diskFacts().scanFailed).toBe(true)
    expect(h.clear().scanFailed).toBe(true)
  })
})

describe('transactional legacy migration and storage failures', () => {
  it('imports local-day JSON directly without repartitioning or data loss (QA-02)', () => {
    legacy('2026-10-03.json', [entry('a', { endedAt: Date.UTC(2026, 9, 4, 3, 30) })])
    const h = store('forever')
    expect(ids(h)).toEqual(['a'])
    expect(files()).toEqual(['history.sqlite'])
    expect(store('forever').count).toBe(1)
  })
  it('imports duplicate files idempotently', () => {
    legacy('2026-10-03.json', [entry('a')])
    legacy('2026-10-04.json', [entry('a')])
    const h = store('forever')
    expect(h.count).toBe(1)
    expect(files()).toEqual(['history.sqlite'])
  })
  it('preserves malformed sources and imports only valid entries', () => {
    legacy('2026-10-03.json', [entry('a'), { id: 'bad' }])
    const h = store('forever')
    expect(h.count).toBe(1)
    expect(h.diskProblem).toBe(true)
    expect(files()).toContain('2026-10-03.json')
    h.remove('a')
    expect(store('forever').count).toBe(0)
  })
  it('preserves a corrupt database and exposes the failure rather than replacing it', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'history.sqlite'), 'broken')
    const h = store('forever')
    h.put(entry('a'))
    expect(readFileSync(h.file, 'utf8')).toBe('broken')
    expect(h.diskProblem).toBe(true)
    expect(h.pending('a')).toBe(true)
    expect(h.clear()).toMatchObject({ failedFiles: 0 })
    expect(files()).toEqual([])
  })
  it('does not remove a source when the import transaction cannot commit (QA-02)', () => {
    const h = store('forever')
    const db = new DatabaseSync(h.file)
    db.exec(
      "CREATE TRIGGER deny BEFORE INSERT ON history BEGIN SELECT RAISE(FAIL,'test fault'); END",
    )
    legacy('2026-10-03.json', [entry('a')])
    const again = store('forever')
    expect(again.count).toBe(0)
    expect(files()).toContain('2026-10-03.json')
    expect(db.prepare('SELECT count(*) n FROM imports').get()?.n).toBe(0)
    db.close()
  })
  it('keeps import receipts after source removal fails, including Delete All (QA-02)', () => {
    legacy('2026-10-03.json', [entry('a')])
    faults.add(join(dir, '2026-10-03.json'))
    const h = store('forever')
    expect(h.count).toBe(1)
    expect(files()).toContain('2026-10-03.json')
    const result = h.clear()
    expect(result.failedFiles).toBe(1)
    expect(result.failed).toBe(0)
    expect(store('forever').count).toBe(0)
  })
  it('treats changed, previously imported sources as conflicts', () => {
    legacy('2026-10-03.json', [entry('a')])
    const h = store('forever')
    legacy('2026-10-03.json', [entry('b')])
    const again = store('forever')
    expect(ids(again)).toEqual(['a'])
    expect(again.diskProblem).toBe(true)
    expect(files()).toContain('2026-10-03.json')
    expect(h.count).toBe(1)
  })
  it('retries each failed row independently; unrelated success cannot hide it (QA-06)', () => {
    const h = store('forever')
    const db = new DatabaseSync(h.file)
    db.exec(
      "CREATE TRIGGER deny BEFORE INSERT ON history WHEN NEW.id='a' BEGIN SELECT RAISE(FAIL,'test fault'); END",
    )
    h.put(entry('a'))
    h.put(entry('b'))
    expect(h.pending('a')).toBe(true)
    expect(h.diskProblem).toBe(true)
    expect(h.count).toBe(2)
    db.exec('DROP TRIGGER deny')
    h.flush()
    expect(h.diskProblem).toBe(false)
    expect(store('forever').count).toBe(2)
    db.close()
  })
  it('preserves accepted pending writes on lock/full failures and retries after release', () => {
    const h = store('forever')
    const db = new DatabaseSync(h.file)
    db.exec('BEGIN EXCLUSIVE')
    h.put(entry('a'))
    expect(h.pending('a')).toBe(true)
    expect(h.count).toBe(1)
    db.exec('ROLLBACK')
    h.flush()
    expect(h.pending('a')).toBe(false)
    db.close()
  })
  it('a dictation that arrives while others wait for the disk does not try each of them first', () => {
    const h = store('forever')
    h.put(entry('first'))
    // The folder stops taking writes: the database cannot make its journal.
    chmodSync(dir, 0o500)
    for (const id of ['a', 'b', 'c', 'd', 'e']) h.put(entry(id))
    expect(h.waitingIds()).toHaveLength(5)

    const ran = vi.spyOn(DatabaseSync.prototype, 'exec')
    h.put(entry('f'))
    // One that waits is tried, and the new one; the others wait for the next try.
    expect(ran.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE')).toHaveLength(2)

    chmodSync(dir, 0o700)
    h.flush()
    expect(h.waitingIds()).toEqual([])
    expect(store('forever').count).toBe(7)
  })
  it('lists what waits beside what is written without preparing a statement for each', () => {
    const h = store('forever')
    h.put(entry('first'))
    chmodSync(dir, 0o500)
    for (let i = 0; i < 20; i++) h.put(entry(`w${i}`))
    h.newest(8)

    const prepared = vi.spyOn(DatabaseSync.prototype, 'prepare')
    expect(h.newest(8)).toHaveLength(8)
    expect(prepared).not.toHaveBeenCalled()
  })
  it('a transaction that SQLite has already ended fails with its own reason', () => {
    const db = new DatabaseSync(':memory:')
    expect(() =>
      transaction(db, () => {
        // SQLite ends a transaction itself after some failures: a full disk, an I/O error.
        db.exec('ROLLBACK')
        throw new Error('the reason it failed')
      }),
    ).toThrow('the reason it failed')
    db.close()
  })
  it('does not silently evict accepted writes when the byte cap overflows', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'history.sqlite'), 'broken')
    const h = store('forever')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.put(entry('a', { written: 'x'.repeat(9 * 1024 * 1024) }))
    expect(() => h.put(entry('b', { written: 'x'.repeat(9 * 1024 * 1024) }))).toThrow()
    expect(h.get('a')?.written.length).toBe(9 * 1024 * 1024)
    expect(logged).toHaveBeenCalled()
  })
})
