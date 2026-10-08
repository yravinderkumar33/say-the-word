import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { z } from 'zod'
import type {
  HistoryEntry,
  HistoryKeep,
  HistoryPage,
  HistoryQuery,
  HistoryRow,
  HistoryDiskFacts,
} from '@shared/ipc'
import { openDatabase, statement, transaction } from '../storage/sqlite'

const DAY_MS = 24 * 60 * 60_000

/** How long a dictation is kept under each choice. Null: until it is deleted, or the app quits. */
const KEEP_MS: Record<HistoryKeep, number | null> = {
  session: null,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  forever: null,
}

/** How much of a dictation a row of the list shows. */
const ROW_TEXT_LENGTH = 240
/** The most dictations held while nothing is written to disk. The oldest go first. */
const MEMORY_LIMIT = 1_000

/** The last moment of the year 9999: no dictation timed by this Mac's clock ends later. */
const LATEST_TIME = 253_402_300_799_999

const entrySchema = z.object({
  id: z.string().min(1),
  endedAt: z.number().min(0).max(LATEST_TIME),
  app: z.string().nullable(),
  outcome: z.enum([
    'pasted',
    'focusMoved',
    'passwordField',
    'secureInput',
    'notPasted',
    'cancelled',
    'interrupted',
    'noSpeech',
    'failed',
  ]),
  fetched: z.enum(['copied', 'pasted']).nullable(),
  mode: z.enum(['verbatim', 'cleaned']),
  note: z.string().nullable(),
  heard: z.string(),
  written: z.string(),
  failure: z.string().nullable(),
  audioMs: z.number().nullable(),
  timings: z.object({
    releaseToTextMs: z.number().nullable(),
    tidyMs: z.number().nullable(),
    pasteMs: z.number().nullable(),
  }),
})
const dayFileSchema = z.object({ version: z.literal(1), entries: z.array(z.unknown()) })
/** A day's file of the format before the database. */
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/
/** A day's file of that format as it was while being written. One that is still there was never finished. */
const UNFINISHED_DAY_FILE = /^\d{4}-\d{2}-\d{2}\.json\.tmp$/

export interface HistoryStoreOptions {
  /** The folder the dictations are written to, when they are written at all. */
  dir: string
  keep: HistoryKeep
  /**
   * False when the settings did not say how long dictations are kept, and `keep` is only
   * the default: the settings file was damaged, or was written by a build that does not
   * know the entry. What is found on disk is then not this store's to delete. True when
   * left out.
   */
  keepIsKnown?: boolean
  paused: boolean
  now?: () => number
  memoryLimit?: number
}

/** What a change of how long dictations are kept would do, for the dialog that asks. */
export interface KeepChange {
  /** Dictations would be written to disk from now on, which they are not at present. */
  startsWriting: boolean
  /**
   * How many dictations are older than the new limit, and would be deleted at once:
   * those listed, and those saved earlier that the change would list again.
   */
  expiring: number
  /** How many dictations saved earlier, on disk and not listed now, the change would list again. */
  relisted: number
}

/** A dictation as one row of the list: the start of its text, on one line. */
export function rowOf(entry: HistoryEntry): HistoryRow {
  return {
    id: entry.id,
    endedAt: entry.endedAt,
    app: entry.app,
    text: entry.written.replace(/\s+/g, ' ').trim().slice(0, ROW_TEXT_LENGTH),
    outcome: entry.outcome,
    fetched: entry.fetched,
    mode: entry.mode,
    note: entry.note,
    failure: entry.failure,
  }
}

const OWNED = /^(?:\d{4}-\d{2}-\d{2}\.json(?:\.tmp)?|history\.sqlite(?:-journal|-wal|-shm)?)$/
const MAX_PENDING_BYTES = 16 * 1024 * 1024
const MAX_PENDING = 1_000
const COLUMNS =
  'id,ended_at,app,outcome,fetched,mode,note,heard,written,failure,audio_ms,release_ms,tidy_ms,paste_ms,preview,search_text,has_text'
const CREATE = `CREATE TABLE IF NOT EXISTS history (
 id TEXT PRIMARY KEY, ended_at REAL NOT NULL, app TEXT, outcome TEXT NOT NULL, fetched TEXT,
 mode TEXT NOT NULL, note TEXT, heard TEXT NOT NULL, written TEXT NOT NULL, failure TEXT,
 audio_ms REAL, release_ms REAL, tidy_ms REAL, paste_ms REAL, preview TEXT NOT NULL,
 search_text TEXT NOT NULL, has_text INTEGER NOT NULL) STRICT;
 CREATE INDEX IF NOT EXISTS history_time ON history(ended_at DESC,id DESC);
 CREATE INDEX IF NOT EXISTS history_copyable ON history(ended_at DESC,id DESC) WHERE has_text=1;
 CREATE TABLE IF NOT EXISTS imports (name TEXT PRIMARY KEY,digest TEXT NOT NULL,complete INTEGER NOT NULL) STRICT;
`

export interface HistoryClearResult {
  deleted: number
  failed: number
  deletedFiles: number
  failedFiles: number
  scanFailed: boolean
}

/** SQLite repository, owned by the storage utility process. No full durable-history mirror. */
export class HistoryStore {
  private db: DatabaseSync = openDatabase(':memory:')
  private durable = false
  private keepFor: HistoryKeep
  private isPaused: boolean
  private changes = 0
  private lastCount = 0
  private unlimitedSession = false
  private readonly dirty = new Map<string, HistoryEntry>()
  /** The size of what `dirty` holds, kept as it changes rather than added up at every change. */
  private dirtyBytes = 0
  /** What was learnt about each file found in the folder, until the file changes. */
  private readonly looked = new Map<string, { size: number; mtimeMs: number; readable: boolean }>()
  private readonly problems = new Set<string>()
  private readonly now: () => number
  private readonly memoryLimit: number

  constructor(private readonly options: HistoryStoreOptions) {
    this.keepFor = options.keep
    this.isPaused = options.paused
    this.now = options.now ?? Date.now
    this.memoryLimit = options.memoryLimit ?? MEMORY_LIMIT
    this.db.exec(CREATE)
    if (this.onDisk) {
      // A day's file that the format before the database never finished writing holds the
      // same words as the day's file itself: it goes at the start, as it always did.
      this.removeFiles(this.ownedFiles().filter((name) => UNFINISHED_DAY_FILE.test(name)))
      this.connect()
      this.importLegacy()
      this.sweep()
    } else if (options.keepIsKnown ?? true) this.deleteOwnedFiles()
  }
  get dir(): string {
    return this.options.dir
  }
  get file(): string {
    return join(this.dir, 'history.sqlite')
  }
  get keep(): HistoryKeep {
    return this.keepFor
  }
  get paused(): boolean {
    return this.isPaused
  }
  get onDisk(): boolean {
    return this.keepFor !== 'session'
  }
  get version(): number {
    return this.changes
  }
  get count(): number {
    try {
      this.lastCount = Number(statement(this.db, 'SELECT count(*) n FROM history').get()?.n ?? 0)
      const count =
        this.lastCount +
        [...this.dirty.keys()].filter(
          (id) => !statement(this.db, 'SELECT 1 FROM history WHERE id=?').get(id),
        ).length
      this.problems.delete('read')
      return count
    } catch {
      this.problems.add('read')
      return this.lastCount + this.dirty.size
    }
  }
  pending(id: string): boolean {
    return this.dirty.has(id)
  }
  /** The dictations accepted and listed, but not yet written where they belong. */
  waitingIds(): string[] {
    return [...this.dirty.keys()]
  }
  get diskProblem(): boolean {
    return this.problems.size > 0 || this.dirty.size > 0
  }
  diskFacts(): HistoryDiskFacts {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((name) => OWNED.test(name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { files: 0, bytes: 0, unreadableFiles: 0, scanFailed: false }
      this.problems.add('scan')
      return { files: 0, bytes: 0, unreadableFiles: 0, scanFailed: true }
    }
    this.problems.delete('scan')
    let bytes = 0
    let unreadableFiles = 0
    for (const name of [...this.looked.keys()]) if (!names.includes(name)) this.looked.delete(name)
    for (const name of names) {
      try {
        const path = join(this.dir, name)
        const stat = statSync(path)
        bytes += stat.size
        if (!stat.isFile()) {
          unreadableFiles++
          continue
        }
        if (DAY_FILE.test(name) && !this.readableDayFile(name, stat)) unreadableFiles++
        if (name === 'history.sqlite' && !this.durable && this.problems.has('open'))
          unreadableFiles++
      } catch {
        unreadableFiles++
      }
    }
    return { files: names.length, bytes, unreadableFiles, scanFailed: false }
  }
  /**
   * Whether a day's file of the earlier format holds nothing but dictations. Read once for
   * each version of the file: every answer of the storage process looks at the folder.
   */
  private readableDayFile(name: string, stat: { size: number; mtimeMs: number }): boolean {
    const known = this.looked.get(name)
    if (known && known.size === stat.size && known.mtimeMs === stat.mtimeMs) return known.readable
    let readable: boolean
    try {
      const legacy = dayFileSchema.parse(JSON.parse(readFileSync(join(this.dir, name), 'utf8')))
      readable = legacy.entries.every((entry) => entrySchema.safeParse(entry).success)
    } catch {
      readable = false
    }
    this.looked.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, readable })
    return readable
  }
  setPaused(paused: boolean): void {
    if (paused !== this.isPaused) {
      this.isPaused = paused
      this.bump()
    }
  }

  put(entry: HistoryEntry, preserveTimings = false): void {
    // A dictation as the app makes it is one the schema takes, and what the schema gives
    // back is written as one: an outcome or a mode added to `@shared/ipc` and not to the
    // schema fails to compile here, rather than have every write of it refused.
    const parsed = entrySchema.parse(entry satisfies z.input<typeof entrySchema>)
    const before = this.get(entry.id)
    if (!before && this.isPaused) return
    const next =
      preserveTimings && before
        ? { ...parsed, audioMs: before.audioMs, timings: before.timings }
        : parsed
    this.flush()
    try {
      this.write(next)
      this.unstage(next.id)
    } catch {
      this.stage(next)
    }
    if (!this.onDisk && !this.unlimitedSession)
      this.db
        .prepare(
          'DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY ended_at DESC,id DESC LIMIT -1 OFFSET ?)',
        )
        .run(this.memoryLimit)
    this.bump()
    this.sweep()
  }
  patch(id: string, change: Partial<Omit<HistoryEntry, 'id'>>): void {
    const before = this.get(id)
    if (before) this.put({ ...before, ...change })
  }
  get(id: string): HistoryEntry | null {
    const pending = this.dirty.get(id)
    if (pending) return pending
    try {
      const row = statement(this.db, `SELECT ${COLUMNS} FROM history WHERE id=?`).get(id)
      return row ? fromSql(row) : null
    } catch {
      this.problems.add('read')
      return null
    }
  }
  newest(limit: number): HistoryRow[] {
    return this.page({ search: '', limit }).rows
  }
  newestWithText(limit: number): HistoryRow[] {
    return this.selectRows('', [], limit, true).rows
  }
  page(query: HistoryQuery): HistoryPage {
    const terms = query.search.toLowerCase().split(/\s+/).filter(Boolean)
    return this.selectRows(
      terms.map(() => 'instr(search_text,?)>0').join(' AND '),
      terms,
      query.limit,
    )
  }
  remove(id: string): boolean {
    if (!this.get(id)) return false
    try {
      statement(this.db, 'DELETE FROM history WHERE id=?').run(id)
      this.unstage(id)
      this.problems.delete(`delete:${id}`)
      this.bump()
      return true
    } catch {
      this.problems.add(`delete:${id}`)
      return false
    }
  }
  clear(): HistoryClearResult {
    const before = this.count
    this.dirty.clear()
    this.dirtyBytes = 0
    let failed = 0
    try {
      this.db.exec('DELETE FROM history')
      this.problems.clear()
    } catch {
      failed = before
      this.problems.add('clear')
    }
    // Keep the import ledger while an undeletable legacy source remains, preventing resurrection.
    const legacy = this.ownedFiles().filter(
      (name) => name !== 'history.sqlite' && !name.startsWith('history.sqlite-'),
    )
    const removed = this.removeFiles(legacy)
    let deletedFiles = removed.deleted
    let failedFiles = removed.failed
    if (removed.failed === 0 && failed === 0) {
      const memory = openDatabase(':memory:')
      memory.exec(CREATE)
      this.db.close()
      this.db = memory
      this.durable = false
      const rest = this.deleteOwnedFiles()
      deletedFiles += rest.deleted
      failedFiles += rest.failed
      if (rest.failed > 0) this.problems.add('clear')
    }
    const disk = this.diskFacts()
    if (removed.failed > 0 || disk.scanFailed) this.problems.add('clear')
    this.bump()
    return {
      deleted: before - failed,
      failed,
      deletedFiles,
      failedFiles,
      scanFailed: disk.scanFailed,
    }
  }
  preview(keep: HistoryKeep): KeepChange {
    const ms = KEEP_MS[keep]
    const cutoff = ms === null ? -Infinity : this.now() - ms
    const expiring = new Set<string>()
    for (const row of statement(this.db, 'SELECT id FROM history WHERE ended_at<?').iterate(cutoff))
      expiring.add(String(row.id))
    for (const entry of this.dirty.values()) if (entry.endedAt < cutoff) expiring.add(entry.id)
    // The database on disk is not open: what it holds, and the days' files of the earlier
    // format, are listed again by a time to keep them for, and swept at once by that time.
    // The question must count them, or it would delete what nobody was told about.
    let relisted = 0
    if (!this.durable && keep !== 'session') {
      const listed = new Set<string>(this.waitingIds())
      for (const row of statement(this.db, 'SELECT id FROM history').iterate())
        listed.add(String(row.id))
      const saved = this.savedEarlier()
      for (const [id, endedAt] of saved) if (endedAt < cutoff) expiring.add(id)
      relisted = [...saved.keys()].filter((id) => !listed.has(id)).length
    }
    return {
      startsWriting: !this.onDisk && keep !== 'session',
      expiring: expiring.size,
      relisted,
    }
  }
  /**
   * The dictations on disk while the database is not open, by id with the time each was
   * made: those in the database, and those in days' files of the earlier format. Read
   * without changing anything: this is asked before the question, not after the yes.
   */
  private savedEarlier(): Map<string, number> {
    const saved = new Map<string, number>()
    if (existsSync(this.file)) {
      let disk: DatabaseSync | null = null
      try {
        disk = new DatabaseSync(this.file, { readOnly: true })
        for (const row of disk.prepare('SELECT id,ended_at FROM history').iterate())
          saved.set(String(row.id), Number(row.ended_at))
      } catch {
        // Unreadable: it stays where it is, counted among the files that are left.
      } finally {
        disk?.close()
      }
    }
    for (const name of this.ownedFiles().filter((file) => DAY_FILE.test(file))) {
      try {
        const file = dayFileSchema.parse(JSON.parse(readFileSync(join(this.dir, name), 'utf8')))
        for (const item of file.entries) {
          const entry = entrySchema.safeParse(item)
          if (entry.success) saved.set(entry.data.id, entry.data.endedAt)
        }
      } catch {
        // Kept as it is, and not imported: nothing in it is listed or swept.
      }
    }
    return saved
  }
  setKeep(keep: HistoryKeep): void {
    const wasOnDisk = this.onDisk
    if (wasOnDisk && keep === 'session') {
      // Transfer in batches entirely inside the storage process, preserving all rows until quit.
      const memory = openDatabase(':memory:')
      memory.exec(CREATE)
      for (const row of statement(this.db, `SELECT ${COLUMNS} FROM history`).iterate())
        insert(memory, fromSql(row))
      for (const entry of this.dirty.values()) insert(memory, entry)
      this.db.close()
      this.db = memory
      this.durable = false
      this.dirty.clear()
      this.dirtyBytes = 0
      this.unlimitedSession = true
    }
    this.keepFor = keep
    if (!this.onDisk) this.deleteOwnedFiles()
    else {
      // The dictations listed now are written at once, and what is on disk is listed again.
      this.connect()
      this.flush()
      this.importLegacy()
      this.sweep()
    }
    this.bump()
  }
  sweep(): number {
    const ms = KEEP_MS[this.keepFor]
    if (ms === null) return 0
    const cutoff = this.now() - ms
    try {
      const removed = Number(
        statement(this.db, 'DELETE FROM history WHERE ended_at<?').run(cutoff).changes,
      )
      for (const [id, entry] of this.dirty) if (entry.endedAt < cutoff) this.unstage(id)
      this.problems.delete('sweep')
      if (removed) this.bump()
      return removed
    } catch {
      this.problems.add('sweep')
      return 0
    }
  }
  flush(): void {
    if (!this.onDisk) return
    for (const [id, entry] of this.dirty) {
      try {
        this.write(entry)
        this.unstage(id)
      } catch {
        // The disk will not take a write now. Every accepted entry is kept for the next
        // try, rather than each waiting out the busy timeout in turn; a new one still
        // tries to write itself.
        return
      }
    }
  }
  close(): void {
    this.db.close()
  }
  private connect(): void {
    if (this.durable || !this.onDisk) return
    let disk: DatabaseSync | null = null
    try {
      disk = openDatabase(this.file)
      const version = Number(statement(disk, 'PRAGMA user_version').get()?.user_version ?? 0)
      if (version > 1) throw new Error('Unsupported history schema')
      disk.exec(CREATE)
      if (version === 0) disk.exec('PRAGMA user_version=1')
      transaction(disk, () => {
        for (const row of statement(this.db, `SELECT ${COLUMNS} FROM history`).iterate())
          insert(disk!, fromSql(row))
      })
      this.db.close()
      this.db = disk
      this.durable = true
      this.problems.delete('open')
    } catch {
      disk?.close()
      this.problems.add('open')
    }
  }
  private write(entry: HistoryEntry): void {
    // Kept on disk, the database is opened, or made, when there is something to write to it.
    this.connect()
    if (this.onDisk && !this.durable) throw new Error('History storage unavailable')
    transaction(this.db, () => insert(this.db, entry))
  }
  private stage(entry: HistoryEntry): void {
    const bytes = Buffer.byteLength(JSON.stringify(entry))
    const before = this.dirty.get(entry.id)
    const held = this.dirtyBytes - (before ? Buffer.byteLength(JSON.stringify(before)) : 0)
    if ((!before && this.dirty.size >= MAX_PENDING) || held + bytes > MAX_PENDING_BYTES) {
      this.problems.add('overflow')
      console.error('[history] pending storage limit reached; new history could not be kept')
      throw new Error('Pending storage limit reached')
    }
    this.dirty.set(entry.id, entry)
    this.dirtyBytes = held + bytes
  }
  private unstage(id: string): void {
    const before = this.dirty.get(id)
    if (!before) return
    this.dirty.delete(id)
    this.dirtyBytes = Math.max(0, this.dirtyBytes - Buffer.byteLength(JSON.stringify(before)))
  }
  private selectRows(
    where: string,
    args: SQLInputValue[],
    limit: number,
    textOnly = false,
  ): HistoryPage {
    const clauses = [where, textOnly ? 'has_text=1' : ''].filter(Boolean)
    const filter = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
    // Prepared once for each shape of search: every answer of the storage process lists rows.
    const newest = statement(
      this.db,
      `SELECT id,ended_at,app,outcome,fetched,mode,note,failure,preview FROM history${filter} ORDER BY ended_at DESC,id DESC LIMIT ?`,
    )
    const matching = statement(this.db, `SELECT count(*) n FROM history${filter}`)
    if (this.dirty.size === 0) {
      const rows = newest.all(...args, limit).map(sqlRow)
      return { rows, total: this.count, matched: Number(matching.get(...args)?.n ?? 0) }
    }
    const pending = [...this.dirty.values()].filter(
      (entry) =>
        (!textOnly || entry.written.trim().length > 0) &&
        args.every((term) =>
          `${entry.written}\n${entry.heard}\n${entry.app ?? ''}`
            .toLowerCase()
            .includes(String(term)),
        ),
    )
    const diskRows = newest.all(...args, limit + this.dirty.size).map(sqlRow)
    const count = Number(matching.get(...args)?.n ?? 0)
    const written = statement(
      this.db,
      `SELECT 1 FROM history${filter}${filter ? ' AND' : ' WHERE'} id=?`,
    )
    const overwritten = [...this.dirty.keys()].filter((id) => written.get(...args, id)).length
    const rows = [...diskRows.filter((row) => !this.dirty.has(row.id)), ...pending.map(rowOf)]
      .sort((a, b) => b.endedAt - a.endedAt || b.id.localeCompare(a.id))
      .slice(0, limit)
    return { rows, total: this.count, matched: count - overwritten + pending.length }
  }
  private importLegacy(): void {
    if (!this.durable) return
    for (const name of this.ownedFiles().filter((name) => DAY_FILE.test(name))) {
      try {
        const path = join(this.dir, name)
        const raw = readFileSync(path, 'utf8')
        const digest = createHash('sha256').update(raw).digest('hex')
        const imported = this.db
          .prepare('SELECT digest,complete FROM imports WHERE name=?')
          .get(name)
        if (imported) {
          if (imported.digest !== digest) {
            this.problems.add(`import:${name}`)
            continue
          }
          if (imported.complete === 1) this.removeFiles([name])
          else this.problems.add(`import:${name}`)
          continue
        }
        const file = dayFileSchema.parse(JSON.parse(raw))
        const entries = file.entries.map((item) => entrySchema.safeParse(item))
        transaction(this.db, () => {
          for (const entry of entries)
            if (entry.success && !this.get(entry.data.id)) insert(this.db, entry.data)
          this.db
            .prepare('INSERT INTO imports(name,digest,complete) VALUES (?,?,?)')
            .run(name, digest, Number(entries.every((entry) => entry.success)))
        })
        const committed = statement(this.db, 'SELECT digest FROM imports WHERE name=?').get(name)
        if (committed?.digest !== digest) throw new Error('Import commit could not be verified')
        if (entries.every((entry) => entry.success)) this.removeFiles([name])
        else this.problems.add(`import:${name}`)
      } catch {
        this.problems.add(`import:${name}`)
      }
    }
  }
  private ownedFiles(): string[] {
    try {
      return readdirSync(this.dir).filter((name) => OWNED.test(name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.problems.add('scan')
      return []
    }
  }
  private removeFiles(names: string[]): { deleted: number; failed: number } {
    let deleted = 0,
      failed = 0
    for (const name of names) {
      try {
        rmSync(join(this.dir, name), { force: true })
        deleted++
        this.problems.delete(`file:${name}`)
        this.problems.delete(`import:${name}`)
      } catch {
        failed++
        this.problems.add(`file:${name}`)
      }
    }
    return { deleted, failed }
  }
  private deleteOwnedFiles(): { deleted: number; failed: number } {
    return this.removeFiles(this.ownedFiles())
  }
  private bump(): void {
    this.changes++
  }
}
function insert(db: DatabaseSync, entry: HistoryEntry): void {
  const values: SQLInputValue[] = [
    entry.id,
    entry.endedAt,
    entry.app,
    entry.outcome,
    entry.fetched,
    entry.mode,
    entry.note,
    entry.heard,
    entry.written,
    entry.failure,
    entry.audioMs,
    entry.timings.releaseToTextMs,
    entry.timings.tidyMs,
    entry.timings.pasteMs,
    rowOf(entry).text,
    `${entry.written}\n${entry.heard}\n${entry.app ?? ''}`.toLowerCase(),
    Number(entry.written.trim().length > 0),
  ]
  statement(
    db,
    `INSERT INTO history(${COLUMNS}) VALUES (${values.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${COLUMNS.split(
      ',',
    )
      .slice(1)
      .map((c) => `${c}=excluded.${c}`)
      .join(',')}`,
  ).run(...values)
}
function sqlRow(row: Record<string, unknown>): HistoryRow {
  return {
    id: String(row.id),
    endedAt: Number(row.ended_at),
    app: row.app as string | null,
    outcome: row.outcome as HistoryRow['outcome'],
    fetched: row.fetched as HistoryRow['fetched'],
    mode: row.mode as HistoryRow['mode'],
    note: row.note as string | null,
    failure: row.failure as string | null,
    text: String(row.preview),
  }
}
function fromSql(row: Record<string, unknown>): HistoryEntry {
  const { text: preview, ...rest } = sqlRow(row)
  void preview
  return {
    ...rest,
    heard: String(row.heard),
    written: String(row.written),
    audioMs: row.audio_ms as number | null,
    timings: {
      releaseToTextMs: row.release_ms as number | null,
      tidyMs: row.tidy_ms as number | null,
      pasteMs: row.paste_ms as number | null,
    },
  }
}
