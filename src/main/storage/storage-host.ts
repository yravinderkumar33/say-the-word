import { createBirpc, type BirpcReturn } from 'birpc'
import { utilityProcess, type UtilityProcess } from 'electron'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import pRetry from 'p-retry'
import { PRODUCT_NAME } from '@shared/product'
import type {
  DictationMode,
  HistoryEntry,
  HistoryKeep,
  HistoryQuery,
  HistoryPage,
  HistoryRow,
  HistorySummary,
} from '@shared/ipc'
import type { StorageFunctions, StorageInit, StorageSnapshot } from '@shared/storage-protocol'
import type { HistoryClearResult, KeepChange } from '../history/history-store'
import { usageSummary } from '../store/usage'
import workerPath from './storage-worker?modulePath'

/** How long one request to the storage process may take before it counts as lost. */
const REQUEST_TIMEOUT_MS = 30_000
/** How long quitting waits for what is still to be written. */
export const STOP_WITHIN_MS = 3_000
/** The first wait before writing again what could not be written, and the longest. */
const RETRY_FIRST_MS = 1_000
const RETRY_LONGEST_MS = 30_000
/** How many writes, and how much of them, main holds in each lane while they wait. */
const MOST_WAITING = 1_000
const MOST_WAITING_BYTES = 16 * 1024 * 1024

const EMPTY: StorageSnapshot = {
  history: {
    keep: 'session',
    paused: false,
    count: 0,
    version: 0,
    diskProblem: false,
    leftOnDisk: 0,
    disk: { files: 0, bytes: 0, unreadableFiles: 0, scanFailed: false },
  },
  recent: [],
  copyable: [],
  usage: { version: 1, words: {}, timings: { verbatim: [], cleaned: [] } },
  usageBytes: 0,
  waiting: { history: [], usage: [] },
}

type WriteOp = 'history.put' | 'history.patch' | 'usage.add'
/**
 * Dictations and counts are written independently: a counts database that cannot be
 * opened must not keep a dictation out of the history, nor the other way round.
 */
type Lane = 'history' | 'usage'
interface Write {
  op: WriteOp
  args: unknown[]
  bytes: number
  lane: Lane
  /** The dictation's id, or the count's receipt: how the storage process names it. */
  key: string
  /**
   * `unsent`: still to be given to the storage process. `held`: given, and held there
   * until it can be written. Main keeps a copy of both, so that a storage process that
   * stops can be given them again.
   */
  state: 'unsent' | 'held'
}

/** A request the storage process refused for what it carries: sending it again changes nothing. */
class InvalidRequest extends Error {}

/** Async storage door. Only bounded row previews and numeric summaries live in main. */
export class StorageHost {
  private child: UtilityProcess | null = null
  /** The requests to the current storage process and their answers, paired by `birpc`. */
  private rpc: BirpcReturn<StorageFunctions> | null = null
  private snapshot: StorageSnapshot = structuredClone(EMPTY)
  private tail: Promise<unknown> = Promise.resolve()
  private closed = false
  /** Quitting: the storage process is being asked to finish, and will end. */
  private stopping = false
  /** Quitting, once asked for: a second quit waits for the same end. */
  private stopped: Promise<void> | null = null
  /** The loop that tries again what could not be written, while it runs. */
  private retrying: AbortController | null = null
  private restarting: Promise<void> | null = null
  /** When the storage process last failed to start, and how long until it is tried again. */
  private startFailedAt = -Infinity
  private startAgainAfterMs = 0
  private readonly writes = new Map<number, Write>()
  private nextWrite = 0
  private overflow = false
  /** Dictations held in memory that went with a storage process that stopped. */
  private lost = 0
  /**
   * Added to the storage process's count of changes, which goes up with every change and
   * never back: a process started in place of one that stopped counts from nothing.
   */
  private versionBase = 0
  readonly history: HistoryRepository
  readonly usage: UsageRepository
  readonly ready: Promise<void>
  constructor(
    private readonly options: StorageInit,
    private readonly changed: () => void = () => {},
  ) {
    this.snapshot.history.keep = options.history.keep
    this.snapshot.history.paused = options.history.paused
    this.history = new HistoryRepository(this)
    this.usage = new UsageRepository(this, options.weekStartsOn)
    this.ready = this.start().catch(() => {
      this.snapshot.history.diskProblem = true
      this.changed()
    })
  }
  crashWorker(): void {
    this.child?.kill()
  }
  /** The folder the history is kept in when it is kept on disk. */
  get historyDir(): string {
    return this.options.history.dir
  }
  current(): StorageSnapshot {
    // Counts that wait are the figures' business, not the history's.
    const unsaved =
      [...this.writes.values()].some((write) => write.lane === 'history') || this.overflow
    if (!unsaved && this.lost === 0 && this.versionBase === 0) return this.snapshot
    return {
      ...this.snapshot,
      history: {
        ...this.snapshot.history,
        version: this.versionBase + this.snapshot.history.version,
        diskProblem: this.snapshot.history.diskProblem || unsaved,
        ...(this.lost > 0 ? { lost: this.lost } : {}),
        ...(this.overflow ? { overflowed: true } : {}),
      },
    }
  }
  private async ensureStarted(): Promise<void> {
    if (this.child) return
    // A process that would not start is not started again at every request.
    if (performance.now() - this.startFailedAt < this.startAgainAfterMs)
      throw new Error('Storage process unavailable')
    this.restarting ??= this.start().finally(() => {
      this.restarting = null
    })
    await this.restarting
  }
  private async start(): Promise<void> {
    const child = utilityProcess.fork(workerPath, [], {
      serviceName: `${PRODUCT_NAME} Storage`,
      stdio: 'pipe',
    })
    const rpc = createBirpc<StorageFunctions>(
      {},
      {
        post: (data) => child.postMessage(data),
        on: (fn) => child.on('message', fn),
        timeout: REQUEST_TIMEOUT_MS,
      },
    )
    this.child = child
    this.rpc = rpc
    // What the process says goes to the log, as the speech process's does. It never
    // says what was dictated: its failures are flags, and its messages are fixed text.
    child.stdout?.on('data', (text: Buffer) =>
      console.log(`[storage] ${text.toString().trimEnd()}`),
    )
    child.stderr?.on('data', (text: Buffer) =>
      console.error(`[storage] ${text.toString().trimEnd()}`),
    )
    child.on('exit', () => {
      rpc.$close(new Error('Storage process stopped'))
      if (this.child !== child) return
      this.child = null
      this.rpc = null
      // It was asked to end, at quit: nothing went with it that was not meant to.
      if (this.stopping) return
      this.lostWithProcess()
      this.changed()
      this.scheduleRetry()
    })
    try {
      await this.send('init', [this.options])
      this.startAgainAfterMs = 0
    } catch (error) {
      // A process that did not start is not kept: every request would be handed to it,
      // and refused, for as long as it ran.
      if (this.child === child) {
        this.child = null
        this.rpc = null
        child.kill()
      }
      this.startFailedAt = performance.now()
      this.startAgainAfterMs = Math.min(
        RETRY_LONGEST_MS,
        Math.max(RETRY_FIRST_MS, this.startAgainAfterMs * 2),
      )
      throw error
    }
  }
  /**
   * The storage process stopped. What it held in memory went with it: the history of a
   * session that keeps it only until the app quits. That is said on the History page,
   * never left to be found out. Writes it held for the disk are given to the next one.
   */
  private lostWithProcess(): void {
    this.versionBase += this.snapshot.history.version + 1
    // How the process kept the history, as it last said: a change asked for since may not
    // have reached it.
    const inMemory = this.snapshot.history.keep === 'session'
    const lost = inMemory ? this.snapshot.history.count : 0
    if (lost > 0) {
      this.lost += lost
      console.error(
        `[storage] the storage process stopped: ${lost} dictations held in memory were lost`,
      )
    } else console.error('[storage] the storage process stopped')
    // What it held for the disk is given to the next one.
    for (const write of this.writes.values()) write.state = 'unsent'
    this.snapshot = {
      ...this.snapshot,
      // Kept on disk, the list is still what it was; held in memory, it is gone.
      history: inMemory
        ? { ...this.snapshot.history, version: 0, count: 0 }
        : { ...this.snapshot.history, version: 0 },
      ...(inMemory ? { recent: [], copyable: [] } : {}),
      waiting: { history: [], usage: [] },
    }
  }
  private async send(op: string, args: unknown[]): Promise<unknown> {
    const rpc = this.rpc
    if (!rpc) throw new Error('Storage process unavailable')
    const answer = await rpc.request(op, args)
    // An answer from a process that has since been replaced says nothing about the new one.
    if (rpc !== this.rpc) throw new Error('Storage process stopped')
    if (answer.snapshot) {
      this.snapshot = answer.snapshot
      this.settleHeld()
      this.changed()
    }
    if (answer.failed) {
      this.snapshot.history.diskProblem = true
      this.changed()
      throw answer.failed === 'invalid'
        ? new InvalidRequest('Storage refused the request')
        : new Error('Storage operation failed')
    }
    return answer.value
  }
  request<T>(op: string, args: unknown[] = []): Promise<T> {
    // The settings say so already, and a storage process started from now on obeys what
    // it is given at the start: it is given this, whether or not the one there can be told.
    if (op === 'history.keep') {
      this.options.history.keep = args[0] as HistoryKeep
      this.options.history.keepIsKnown = true
    }
    if (op === 'history.pause') this.options.history.paused = args[0] as boolean
    const result = this.tail.then(async () => {
      await this.ready
      if (this.closed) throw new Error('Storage closed')
      await this.ensureStarted()
      return this.send(op, args)
    })
    this.tail = result.catch(() => {})
    return result as Promise<T>
  }
  enqueue(op: string, args: unknown[]): void {
    if (op !== 'history.put' && op !== 'history.patch' && op !== 'usage.add') {
      void this.request(op, args).catch(() => {
        this.snapshot.history.diskProblem = true
        this.changed()
      })
      return
    }
    const lane: Lane = op === 'usage.add' ? 'usage' : 'history'
    const bytes = Buffer.byteLength(JSON.stringify(args))
    // Each lane has its own room: counts held for good take none of what dictations need.
    let waiting = 0
    let held = 0
    for (const item of this.writes.values()) {
      if (item.lane !== lane) continue
      waiting++
      held += item.bytes
    }
    if (waiting >= MOST_WAITING || held + bytes > MOST_WAITING_BYTES) {
      // A dictation that is not kept is said on the History page; a count is not.
      if (lane === 'history') {
        this.overflow = true
        this.changed()
      }
      console.error(`[storage] pending ${lane} write limit reached; the new one was not accepted`)
      return
    }
    const key =
      op === 'history.put'
        ? (args[0] as HistoryEntry).id
        : op === 'history.patch'
          ? String(args[0])
          : String(args[2])
    this.writes.set(++this.nextWrite, { op, args, bytes, lane, key, state: 'unsent' })
    void this.drain()
      .catch(() => {})
      .finally(() => this.scheduleRetry())
  }
  /**
   * Gives the storage process what is still to be given, in order within each lane. One
   * that fails holds back the rest of its lane, which keeps a dictation's changes behind
   * the dictation, and leaves the other lane alone. One the storage process refuses for
   * what it carries is dropped and said, never retried forever. One it holds, because the
   * disk will not take it now, is kept here until it is no longer held there.
   */
  private drain(): Promise<void> {
    const result = this.tail.then(async () => {
      await this.ready
      if (this.closed) return
      await this.ensureStarted()
      const stopped = new Set<Lane>()
      for (const [id, item] of this.writes) {
        if (item.state !== 'unsent' || stopped.has(item.lane)) continue
        const before = this.snapshot
        try {
          await this.send(item.op, item.args)
        } catch (error) {
          if (error instanceof InvalidRequest) {
            this.writes.delete(id)
            // A dictation that is not kept is said on the History page; a count is not.
            if (item.lane === 'history') this.overflow = true
            console.error(`[storage] a ${item.lane} write was refused as malformed; it was dropped`)
            continue
          }
          if (!this.child) throw error
          stopped.add(item.lane)
          continue
        }
        // An answer without a snapshot does not say whether the write was held there: it
        // is kept here until an answer says it is no longer waiting.
        const { waiting } = this.snapshot
        if (
          this.snapshot === before ||
          (item.lane === 'history' ? waiting.history : waiting.usage).includes(item.key)
        )
          item.state = 'held'
        else this.writes.delete(id)
      }
      this.changed()
    })
    this.tail = result.catch(() => {})
    return result
  }
  /** Writes the storage process held are dropped here once it no longer holds them: they are written. */
  private settleHeld(): void {
    const { history, usage } = this.snapshot.waiting
    for (const [id, item] of this.writes) {
      if (item.state !== 'held') continue
      if (!(item.lane === 'history' ? history : usage).includes(item.key)) this.writes.delete(id)
    }
  }
  /**
   * Tries again what could not be written: after a second, then less often while it still
   * cannot be, up to every half a minute. It ends when nothing is left waiting.
   */
  private scheduleRetry(): void {
    if (this.retrying || this.closed || this.stopping || this.writes.size === 0) return
    const controller = new AbortController()
    this.retrying = controller
    void pRetry(
      async () => {
        const unsent = [...this.writes.values()].some((item) => item.state === 'unsent')
        // What is held there is tried again there; what is not yet there is given to it.
        await (unsent ? this.drain() : this.request('flush'))
        if (this.writes.size > 0) throw new Error('Writes are still waiting')
      },
      {
        retries: Infinity,
        minTimeout: RETRY_FIRST_MS,
        maxTimeout: RETRY_LONGEST_MS,
        signal: controller.signal,
        unref: true,
      },
    )
      .catch(() => {})
      .finally(() => {
        if (this.retrying === controller) this.retrying = null
        this.changed()
      })
  }
  /**
   * Before a deletion: what waits to be written in that lane is dropped at once, so that
   * a write from before a Delete All is not made after it.
   */
  invalidate(kind: 'all' | 'usage' = 'all'): void {
    if (kind === 'all') {
      for (const [id, item] of this.writes) if (item.lane === 'history') this.writes.delete(id)
      this.overflow = false
      this.lost = 0
    } else {
      for (const [id, item] of this.writes) if (item.lane === 'usage') this.writes.delete(id)
    }
    if (this.writes.size === 0) {
      this.retrying?.abort()
      this.retrying = null
    }
  }
  discardEntry(id: string): void {
    for (const [key, item] of this.writes)
      if (item.lane === 'history' && item.key === id) this.writes.delete(key)
  }
  async flush(): Promise<void> {
    await this.drain()
    await this.request('flush')
  }
  /**
   * At quit: what is still to be written is given its chance, within a few seconds. A
   * storage process that does not answer does not keep the app from quitting, and a
   * second quit waits for the end of the first.
   */
  stop(): Promise<void> {
    this.stopped ??= this.finish()
    return this.stopped
  }
  private async finish(): Promise<void> {
    this.stopping = true
    this.retrying?.abort()
    this.retrying = null
    const finishing = (async () => {
      // A storage process that has stopped is started again for what waits to be
      // written, and not only to be closed.
      if (!this.child && this.writes.size === 0) return
      await this.drain().catch(() => {})
      await this.request('close').catch(() => {})
    })()
    const timer = new AbortController()
    await Promise.race([
      finishing,
      sleep(STOP_WITHIN_MS, undefined, { signal: timer.signal }).catch(() => {}),
    ])
    timer.abort()
    if (this.writes.size > 0)
      console.error(`[storage] quitting with ${this.writes.size} writes not made`)
    this.closed = true
    const child = this.child
    this.child = null
    this.rpc?.$close(new Error('Storage closed'))
    this.rpc = null
    child?.kill()
  }
}
export class HistoryRepository {
  constructor(private readonly host: StorageHost) {}
  crashWorker(): void {
    this.host.crashWorker()
  }
  get dir(): string {
    return this.host.historyDir
  }
  get keep(): HistoryKeep {
    return this.host.current().history.keep
  }
  get paused(): boolean {
    return this.host.current().history.paused
  }
  get onDisk(): boolean {
    return this.keep !== 'session'
  }
  get count(): number {
    return this.host.current().history.count
  }
  get version(): number {
    return this.host.current().history.version
  }
  get diskProblem(): boolean {
    return this.host.current().history.diskProblem
  }
  get leftOnDisk(): number {
    return this.host.current().history.leftOnDisk
  }
  /** The summary the pages are given, with what main itself knows. */
  summary(): HistorySummary {
    return this.host.current().history
  }
  diskFacts(): NonNullable<HistorySummary['disk']> {
    return this.host.current().history.disk!
  }
  bytesOnDisk(): number {
    return this.diskFacts().bytes
  }
  newest(limit: number): HistoryRow[] {
    return this.host.current().recent.slice(0, limit)
  }
  newestWithText(limit: number): HistoryRow[] {
    return this.host.current().copyable.slice(0, limit)
  }
  get(id: string): Promise<HistoryEntry | null> {
    return this.host.request('history.get', [id])
  }
  page(query: HistoryQuery): Promise<HistoryPage> {
    return this.host.request('history.page', [query])
  }
  put(entry: HistoryEntry, preserveTimings = false): void {
    this.host.enqueue('history.put', [entry, preserveTimings])
  }
  patch(id: string, change: Partial<Omit<HistoryEntry, 'id'>>): void {
    this.host.enqueue('history.patch', [id, change])
  }
  async remove(id: string): Promise<boolean> {
    const removed = await this.host.request<boolean>('history.remove', [id])
    if (removed) this.host.discardEntry(id)
    return removed
  }
  clear(): Promise<HistoryClearResult> {
    this.host.invalidate()
    return this.host.request('history.clear')
  }
  preview(keep: HistoryKeep): Promise<KeepChange> {
    return this.host.request('history.preview', [keep])
  }
  setKeep(keep: HistoryKeep): Promise<void> {
    return this.host.request('history.keep', [keep])
  }
  setPaused(paused: boolean): void {
    this.host.enqueue('history.pause', [paused])
  }
  sweep(): void {
    this.host.enqueue('history.sweep', [])
  }
}
export class UsageRepository {
  constructor(
    private readonly host: StorageHost,
    private readonly weekStartsOn: number,
  ) {}
  get bytesOnDisk(): number {
    return this.host.current().usageBytes
  }
  add(dictation: { words: number; mode: DictationMode; releaseToPasteMs: number | null }): void {
    this.host.enqueue('usage.add', [dictation, Date.now(), randomUUID()])
  }
  summary(mode: DictationMode, now: Date = new Date()) {
    return usageSummary(this.host.current().usage, mode, now, this.weekStartsOn)
  }
  clear(): Promise<boolean> {
    this.host.invalidate('usage')
    return this.host.request('usage.clear')
  }
}
