import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase, statement, transaction } from '../storage/sqlite'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import type { DictationMode, Usage } from '@shared/ipc'

/** Days whose word counts are kept. A week is shown; the rest is room for a week that began earlier. */
const KEPT_DAYS = 14
/** Recent dictations whose timing is kept, per mode. Enough for "usually" to mean something. */
const KEPT_TIMINGS = 40

const usageSchema = z.object({
  version: z.literal(1),
  /** Words dictated on each day, by local date (`2026-10-04`). */
  words: z.record(z.string(), z.number().int().nonnegative()).default({}),
  /** Milliseconds from releasing the key to the paste, newest last. */
  timings: z
    .object({
      verbatim: z.array(z.number().nonnegative()).default([]),
      cleaned: z.array(z.number().nonnegative()).default([]),
    })
    .default({ verbatim: [], cleaned: [] }),
})
type UsageFile = z.infer<typeof usageSchema>

/** The local date of a moment, as the file's key for that day. */
export function dayKey(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
}

/**
 * The day a week starts on where this Mac is set up to be, as `Date.getDay()` counts
 * days (0 is Sunday). Monday where the system does not say.
 */
export function firstDayOfWeek(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number }
      weekInfo?: { firstDay: number }
    }
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay
    // There a week runs from 1 (Monday) to 7 (Sunday).
    return typeof firstDay === 'number' ? firstDay % 7 : 1
  } catch {
    return 1
  }
}

/** The keys of the days of the week that `now` is in, up to and including today. */
export function daysOfWeekSoFar(now: Date, weekStartsOn: number): string[] {
  const sinceStart = (now.getDay() - weekStartsOn + 7) % 7
  const days: string[] = []
  for (let back = sinceStart; back >= 0; back--) {
    days.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)))
  }
  return days
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  const value =
    sorted.length % 2 === 1
      ? sorted[middle]
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
  return value ?? null
}

/**
 * How much has been dictated, and how long it usually takes: the figures the window
 * shows. Kept as one small file of numbers. It never holds a word of what was said,
 * and nothing in it is sent anywhere.
 *
 * A file that cannot be read means starting from nothing, and one that cannot be
 * written costs the figures and nothing else: a dictation is never held up for them.
 */
const CREATE_USAGE = `CREATE TABLE IF NOT EXISTS days(day TEXT PRIMARY KEY,words INTEGER NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS timings(id INTEGER PRIMARY KEY,mode TEXT NOT NULL,ms REAL NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY) STRICT;
  CREATE TABLE IF NOT EXISTS imports(name TEXT PRIMARY KEY,digest TEXT NOT NULL) STRICT;`
type CountOperation = {
  dictation: { words: number; mode: DictationMode; releaseToPasteMs: number | null }
  now: Date
}

/** Where the counts are kept: beside the file they were kept in before the database. */
export function usageDatabasePath(usageFile: string): string {
  return join(dirname(usageFile), 'usage.sqlite')
}

export class UsageStore {
  private db: DatabaseSync = openDatabase(':memory:')
  private current: UsageFile = { version: 1, words: {}, timings: { verbatim: [], cleaned: [] } }
  private durable = false
  private problem = false
  private readonly pending = new Map<string, CountOperation>()
  readonly databasePath: string
  constructor(private readonly filePath: string) {
    this.databasePath = usageDatabasePath(filePath)
    this.db.exec(CREATE_USAGE)
    // The database is made when there is something to count, not at every start: until
    // then Privacy says that nothing is counted, and there is nothing to delete.
    if (existsSync(this.databasePath) || existsSync(this.filePath)) this.connect()
    this.current = this.read()
  }
  /** True when the count is written; false when it is held, to be written when it can be. */
  add(
    dictation: CountOperation['dictation'],
    now: Date = new Date(),
    operation: string = randomUUID(),
  ): boolean {
    const item = { dictation, now }
    if (this.flush()) {
      try {
        this.write(operation, item)
        this.current = this.read()
        return true
      } catch {
        this.problem = true
      }
    }
    if (!this.pending.has(operation)) {
      if (this.pending.size >= 1000) throw new Error('Pending count limit reached')
      this.pending.set(operation, item)
      if (!this.durable) {
        this.write(operation, item)
        this.current = this.read()
      }
    }
    return false
  }
  /** Writes what is held, if the database can be had. True when nothing is left held. */
  flush(): boolean {
    this.connect()
    if (!this.durable) return false
    try {
      for (const [id, queued] of this.pending) {
        this.write(id, queued)
        this.pending.delete(id)
      }
      if (this.pending.size === 0) this.current = this.read()
      return true
    } catch {
      this.problem = true
      return false
    }
  }
  /** The receipts of the counts that are held and not yet written. */
  waitingIds(): string[] {
    return [...this.pending.keys()]
  }
  /** The figures as they stand. Main works out from them what the window shows (`usageSummary`). */
  snapshot(): UsageFile {
    return this.current
  }
  get diskProblem(): boolean {
    return this.problem || this.pending.size > 0
  }
  get bytesOnDisk(): number {
    let bytes = 0
    for (const path of [
      this.databasePath,
      this.databasePath + '-journal',
      this.filePath,
      this.filePath + '.tmp',
    ])
      try {
        bytes += statSync(path).size
      } catch {
        /* Missing. */
      }
    return bytes
  }
  clear(): boolean {
    this.pending.clear()
    try {
      this.db.exec('DELETE FROM days; DELETE FROM timings; DELETE FROM operations')
      this.current = this.read()
    } catch {
      this.problem = true
      return false
    }
    // The import receipt survives when source removal fails, so cleared counts cannot return.
    let removed = true
    for (const path of [this.filePath, this.filePath + '.tmp'])
      try {
        rmSync(path, { force: true })
      } catch {
        removed = false
      }
    if (!removed) {
      this.problem = true
      return false
    }
    this.db.close()
    this.durable = false
    this.db = openDatabase(':memory:')
    this.db.exec(CREATE_USAGE)
    try {
      rmSync(this.databasePath, { force: true })
      rmSync(this.databasePath + '-journal', { force: true })
      this.problem = false
      return true
    } catch {
      this.problem = true
      return false
    }
  }
  close(): void {
    this.db.close()
  }
  private connect(): void {
    if (this.durable) return
    let disk: DatabaseSync | null = null
    try {
      disk = openDatabase(this.databasePath)
      const version = Number(statement(disk, 'PRAGMA user_version').get()?.user_version ?? 0)
      if (version > 1) throw new Error('Unsupported usage schema')
      disk.exec(CREATE_USAGE)
      if (version === 0) disk.exec('PRAGMA user_version=1')
      this.db.close()
      this.db = disk
      this.durable = true
      this.problem = false
    } catch {
      disk?.close()
      this.problem = true
      return
    }
    // The figures of the format before the database come in once, whenever it is opened.
    this.importLegacy()
  }
  private write(id: string, { dictation, now }: CountOperation): void {
    if (statement(this.db, 'SELECT 1 FROM operations WHERE id=?').get(id)) return
    transaction(this.db, () => {
      statement(this.db, 'INSERT INTO operations(id) VALUES (?)').run(id)
      this.db
        .prepare(
          'INSERT INTO days(day,words) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET words=words+excluded.words',
        )
        .run(dayKey(now), Math.max(0, Math.round(dictation.words)))
      this.db.exec(
        `DELETE FROM days WHERE day IN (SELECT day FROM days ORDER BY day DESC LIMIT -1 OFFSET ${KEPT_DAYS})`,
      )
      if (dictation.releaseToPasteMs !== null && dictation.releaseToPasteMs >= 0) {
        this.db
          .prepare('INSERT INTO timings(mode,ms) VALUES (?,?)')
          .run(dictation.mode, dictation.releaseToPasteMs)
        this.db
          .prepare(
            `DELETE FROM timings WHERE mode=? AND id NOT IN (SELECT id FROM timings WHERE mode=? ORDER BY id DESC LIMIT ${KEPT_TIMINGS})`,
          )
          .run(dictation.mode, dictation.mode)
      }
      this.db.exec(
        'DELETE FROM operations WHERE rowid IN (SELECT rowid FROM operations ORDER BY rowid DESC LIMIT -1 OFFSET 2000)',
      )
    })
  }
  private read(): UsageFile {
    const words: Record<string, number> = {}
    for (const row of statement(this.db, 'SELECT day,words FROM days').all())
      words[String(row.day)] = Number(row.words)
    const timings: UsageFile['timings'] = { verbatim: [], cleaned: [] }
    for (const row of statement(this.db, 'SELECT mode,ms FROM timings ORDER BY id').all())
      timings[row.mode as DictationMode].push(Number(row.ms))
    return { version: 1, words, timings }
  }
  private importLegacy(): void {
    try {
      const raw = readFileSync(this.filePath, 'utf8')
      const digest = createHash('sha256').update(raw).digest('hex')
      const old = statement(this.db, 'SELECT digest FROM imports WHERE name=?').get('usage.json')
      if (old) {
        if (old.digest === digest) rmSync(this.filePath, { force: true })
        else this.problem = true
        return
      }
      const parsed = usageSchema.parse(JSON.parse(raw))
      transaction(this.db, () => {
        for (const [day, words] of Object.entries(parsed.words))
          this.db
            .prepare(
              'INSERT INTO days(day,words) VALUES (?,?) ON CONFLICT(day) DO UPDATE SET words=max(words,excluded.words)',
            )
            .run(day, words)
        for (const mode of ['verbatim', 'cleaned'] as const)
          for (const ms of parsed.timings[mode].slice(-KEPT_TIMINGS))
            statement(this.db, 'INSERT INTO timings(mode,ms) VALUES (?,?)').run(mode, ms)
        this.db.exec(
          `DELETE FROM days WHERE day IN (SELECT day FROM days ORDER BY day DESC LIMIT -1 OFFSET ${KEPT_DAYS})`,
        )
        statement(this.db, 'INSERT INTO imports(name,digest) VALUES (?,?)').run(
          'usage.json',
          digest,
        )
      })
      if (
        statement(this.db, 'SELECT digest FROM imports WHERE name=?').get('usage.json')?.digest !==
        digest
      )
        throw new Error('Import not committed')
      rmSync(this.filePath, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.problem = true
    }
  }
}

export function usageSummary(
  current: UsageFile,
  mode: DictationMode,
  now: Date,
  weekStartsOn: number,
): Usage {
  return {
    wordsToday: current.words[dayKey(now)] ?? 0,
    wordsThisWeek: daysOfWeekSoFar(now, weekStartsOn).reduce(
      (sum, day) => sum + (current.words[day] ?? 0),
      0,
    ),
    typicalMs: median(current.timings[mode]),
  }
}
