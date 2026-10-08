import { createBirpc } from 'birpc'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, HistoryKeep } from '@shared/ipc'
import type { StorageAnswer } from '@shared/storage-protocol'
const mock = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mock.fork } }))
vi.mock('../../src/main/storage/storage-worker?modulePath', () => ({ default: 'fake-worker' }))
import { StorageHost } from '../../src/main/storage/storage-host'
import { StorageService } from '../../src/main/storage/storage-service'

/**
 * The storage process, without the process: the real request handling and the real
 * databases, in this one, answering over `birpc` as the worker does. A process that
 * stops takes its memory with it, as one does.
 */
class StandIn extends EventEmitter {
  readonly service = new StorageService()
  alive = true
  /** Requests it takes and never answers, as a process that hangs. */
  readonly silentOn = new Set<string>()
  private deliver: ((data: unknown) => void) | null = null
  constructor(readonly refuseInit = false) {
    super()
    createBirpc<
      Record<string, never>,
      { request(op: string, args: unknown[]): StorageAnswer | Promise<StorageAnswer> }
    >(
      {
        request: (op, args) => {
          if (this.silentOn.has(op)) return new Promise<StorageAnswer>(() => {})
          if (this.refuseInit && op === 'init') return { failed: true }
          const { answer, exit } = this.service.handle({ op, args })
          if (exit) setImmediate(() => this.kill())
          return answer
        },
      },
      {
        post: (data) => {
          if (this.alive) queueMicrotask(() => this.emit('message', data))
        },
        on: (fn) => {
          this.deliver = fn
        },
        timeout: -1,
      },
    )
  }
  postMessage(data: unknown): void {
    if (this.alive) queueMicrotask(() => this.deliver?.(data))
  }
  kill(): void {
    if (!this.alive) return
    this.alive = false
    queueMicrotask(() => this.emit('exit', 0))
  }
}

const dirs: string[] = []
const hosts: StorageHost[] = []
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop()
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700)
    rmSync(dir, { recursive: true, force: true })
  }
  mock.fork.mockReset()
  vi.useRealTimers()
})

const entry = (id: string, change: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  endedAt: Date.now(),
  app: null,
  outcome: 'pasted',
  fetched: null,
  mode: 'verbatim',
  note: null,
  heard: `synthetic ${id}`,
  written: `synthetic ${id}`,
  failure: null,
  audioMs: null,
  timings: { releaseToTextMs: null, tidyMs: null, pasteMs: null },
  ...change,
})
const count = { words: 3, mode: 'verbatim' as const, releaseToPasteMs: 400 }

function setup(keep: HistoryKeep = 'forever', dir = mkdtempSync(join(tmpdir(), 'flow-host-'))) {
  if (!dirs.includes(dir)) dirs.push(dir)
  const processes: StandIn[] = []
  const next: { refuseInit?: boolean } = {}
  mock.fork.mockImplementation(() => {
    const child = new StandIn(next.refuseInit ?? false)
    processes.push(child)
    return child
  })
  const host = new StorageHost({
    history: { dir: join(dir, 'history'), keep, keepIsKnown: true, paused: false },
    usageFile: join(dir, 'usage.json'),
    weekStartsOn: 1,
  })
  hosts.push(host)
  return { host, dir, processes, next }
}
const listed = async (host: StorageHost) =>
  (await host.history.page({ search: '', limit: 50 })).rows.map((row) => row.id).sort()

describe('the storage door, with the real stores behind it', () => {
  it('a counts database that cannot be opened keeps no dictation out of the history', async () => {
    const t = setup('session')
    await t.host.ready
    // Something is in the way of the counts database, for good.
    mkdirSync(join(t.dir, 'usage.sqlite'))
    for (const id of ['a', 'b', 'c']) {
      t.host.usage.add(count)
      t.host.history.put(entry(id))
    }
    await t.host.flush()

    expect(await listed(t.host)).toEqual(['a', 'b', 'c'])
    expect(t.host.history.count).toBe(3)
    // The figures wait; the history has nothing to say about that.
    expect(t.host.history.diskProblem).toBe(false)
    expect(t.host.usage.summary('verbatim').wordsToday).toBe(9)
  })

  it('counts that wait for good fill no room the dictations need, however many there are', async () => {
    const t = setup('session')
    await t.host.ready
    mkdirSync(join(t.dir, 'usage.sqlite'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // More counts than there is room for while they wait: every one of them is held.
    for (let i = 0; i < 1_050; i++) {
      t.host.usage.add(count)
      t.host.history.put(entry(`d${i}`))
      if (i % 100 === 99) await t.host.flush()
    }
    await t.host.flush()
    logged.mockRestore()

    // The newest are listed, as ever: held in memory, the newest 1,000.
    expect(t.host.history.count).toBe(1_000)
    expect((await t.host.history.page({ search: 'd1049', limit: 1 })).matched).toBe(1)
    // A count that was not kept is not a dictation that was not kept.
    expect(t.host.history.summary().overflowed).toBeUndefined()
    expect(t.host.history.diskProblem).toBe(false)
  })

  it('dictations the disk will not take now are listed, kept, and written when it will', async () => {
    const t = setup('forever')
    await t.host.ready
    t.host.history.put(entry('first'))
    await t.host.flush()
    const folder = join(t.dir, 'history')
    // The folder stops taking writes: the database cannot make its journal.
    chmodSync(folder, 0o500)
    for (const id of ['a', 'b', 'c']) t.host.history.put(entry(id))
    await t.host.flush()

    expect(await listed(t.host)).toEqual(['a', 'b', 'c', 'first'])
    expect(t.host.history.diskProblem).toBe(true)

    chmodSync(folder, 0o700)
    await t.host.flush()
    expect(t.host.history.diskProblem).toBe(false)
    await t.host.stop()

    // What was written is there for the next launch.
    const again = setup('forever', t.dir)
    await again.host.ready
    expect(await listed(again.host)).toEqual(['a', 'b', 'c', 'first'])
  })

  it('what the disk would not take is given again to a storage process that took its place', async () => {
    const t = setup('forever')
    await t.host.ready
    chmodSync(join(t.dir, 'history'), 0o500)
    t.host.history.put(entry('a'))
    await t.host.flush()
    expect(await listed(t.host)).toEqual(['a'])

    // The process that held it stops; the folder takes writes again.
    t.processes.at(-1)!.kill()
    await vi.waitFor(() => expect(t.processes.at(-1)!.alive).toBe(false))
    chmodSync(join(t.dir, 'history'), 0o700)
    await t.host.flush()

    expect(t.processes.length).toBe(2)
    expect(await listed(t.host)).toEqual(['a'])
    expect(t.host.history.diskProblem).toBe(false)
  })

  it('a write refused for what it carries is dropped and said, and the next is written', async () => {
    const t = setup('session')
    await t.host.ready
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.host.history.put({ ...entry('bad'), outcome: 'bogus' as HistoryEntry['outcome'] })
    t.host.history.put(entry('good'))
    await t.host.flush()
    logged.mockRestore()

    expect(await listed(t.host)).toEqual(['good'])
    expect(t.host.history.summary().overflowed).toBe(true)
    // Nothing is held back behind it, and nothing is tried again.
    await t.host.flush()
    expect(await listed(t.host)).toEqual(['good'])
  })

  it('the history held in memory that a stopped process took with it is said, not hidden', async () => {
    const t = setup('session')
    await t.host.ready
    t.host.history.put(entry('a'))
    t.host.history.put(entry('b'))
    await t.host.flush()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const versionBeforeCrash = t.host.history.version
    t.host.history.crashWorker()
    await vi.waitFor(() => expect(t.host.history.summary().lost).toBe(2))
    logged.mockRestore()
    expect(t.host.history.count).toBe(0)
    // A change, like any other.
    expect(t.host.history.version).toBeGreaterThan(versionBeforeCrash)
    expect(t.host.history.diskProblem).toBe(false)

    // Listing goes on with the next dictation, in a new process. The count of changes goes
    // on from where it was, although the new process's own starts from nothing.
    const versionBefore = t.host.history.version
    t.host.history.put(entry('c'))
    await t.host.flush()
    expect(await listed(t.host)).toEqual(['c'])
    expect(t.host.history.summary().lost).toBe(2)
    expect(t.host.history.version).toBeGreaterThan(versionBefore)

    // Deleting the history takes the notice with it.
    await t.host.history.clear()
    expect(t.host.history.summary().lost).toBeUndefined()
  })

  it('quitting is not taken for a process that stopped, and loses nothing it should keep', async () => {
    const t = setup('session')
    await t.host.ready
    t.host.history.put(entry('a'))
    await t.host.flush()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await t.host.stop()

    expect(logged).not.toHaveBeenCalled()
    expect(t.host.history.summary().lost).toBeUndefined()
    logged.mockRestore()
  })

  it('a process that did not start is not kept, nor started again at every request', async () => {
    const t = setup('session')
    // The first start succeeds; the process then stops, and the next one will not start.
    await t.host.ready
    t.next.refuseInit = true
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.processes[0]!.kill()
    await vi.waitFor(() => expect(t.processes[0]!.alive).toBe(false))

    await expect(t.host.history.page({ search: '', limit: 5 })).rejects.toThrow()
    expect(t.processes.length).toBe(2)
    expect(t.processes[1]!.alive).toBe(false)
    // Asked again at once: refused here, with no third process.
    await expect(t.host.history.page({ search: '', limit: 5 })).rejects.toThrow()
    expect(t.processes.length).toBe(2)
    logged.mockRestore()
  })

  it('what was asked while the storage process would not start is what the next one obeys', async () => {
    const t = setup('forever')
    await t.host.ready
    t.host.history.put(entry('a'))
    await t.host.flush()
    const file = join(t.dir, 'history', 'history.sqlite')
    expect(existsSync(file)).toBe(true)
    // The process stops, and the next one will not start for now.
    t.next.refuseInit = true
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.processes[0]!.kill()
    await vi.waitFor(() => expect(t.processes[0]!.alive).toBe(false))
    // "Only until I quit", then "Pause history": the settings say so; the process cannot be told.
    await expect(t.host.history.setKeep('session')).rejects.toThrow()
    t.host.history.setPaused(true)

    // Past the wait before starting one again, a dictation starts the next process.
    t.next.refuseInit = false
    await sleep(1_100)
    t.host.history.put(entry('said while paused'))
    await t.host.flush()
    logged.mockRestore()

    // Nothing more is kept on disk, and nothing is listed while the history is paused.
    expect(existsSync(file)).toBe(false)
    expect(t.host.history.paused).toBe(true)
    expect(t.host.history.count).toBe(0)
  })

  it('a second quit waits for the first to finish', async () => {
    const t = setup('session')
    await t.host.ready
    let first = false
    void t.host.stop().then(() => (first = true))
    await t.host.stop()

    expect(first).toBe(true)
  })

  it('a storage process that stopped before quit is not started again only to be closed', async () => {
    const t = setup('session')
    await t.host.ready
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.processes[0]!.kill()
    await vi.waitFor(() => expect(t.processes[0]!.alive).toBe(false))
    await t.host.stop()
    logged.mockRestore()

    expect(t.processes.length).toBe(1)
  })

  // Each request made while the database is held waits out the busy timeout: a few seconds.
  it(
    'a write whose answer did not say what waits is kept until an answer does',
    { timeout: 15_000 },
    async () => {
      const t = setup('forever')
      await t.host.ready
      // Another program holds the database: nothing can be written to it or read from it.
      const other = new DatabaseSync(join(t.dir, 'history', 'history.sqlite'))
      other.exec('BEGIN EXCLUSIVE')
      t.host.history.put(entry('a'))
      await t.host.flush().catch(() => {})

      // The process that holds it stops before the disk takes it.
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      t.processes.at(-1)!.kill()
      await vi.waitFor(() => expect(t.processes.at(-1)!.alive).toBe(false))
      other.exec('ROLLBACK')
      other.close()
      await t.host.flush()
      logged.mockRestore()

      expect(await listed(t.host)).toEqual(['a'])
    },
  )

  it('an operation that was carried out is not said to have failed because the reads after it were refused', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-host-'))
    dirs.push(dir)
    const service = new StorageService()
    service.handle({
      op: 'init',
      args: [
        {
          history: { dir: join(dir, 'history'), keep: 'forever', keepIsKnown: true, paused: false },
          usageFile: join(dir, 'usage.json'),
          weekStartsOn: 1,
        },
      ],
    })
    const other = new DatabaseSync(join(dir, 'history', 'history.sqlite'))
    other.exec('BEGIN EXCLUSIVE')
    const { answer } = service.handle({ op: 'history.pause', args: [true] })
    other.exec('ROLLBACK')
    other.close()
    service.handle({ op: 'close', args: [] })

    expect(answer.failed).toBeUndefined()
  })

  it('quitting does not wait long for a storage process that does not answer', async () => {
    const t = setup('session')
    await t.host.ready
    t.processes[0]!.silentOn.add('close')
    const began = performance.now()
    await t.host.stop()

    expect(performance.now() - began).toBeLessThan(4_000)
    expect(t.processes[0]!.alive).toBe(false)
  })

  it('a write made before a Delete All is not made after it', async () => {
    const t = setup('forever')
    await t.host.ready
    chmodSync(join(t.dir, 'history'), 0o500)
    t.host.history.put(entry('a'))
    t.host.usage.add(count)
    await t.host.flush()
    chmodSync(join(t.dir, 'history'), 0o700)

    await t.host.history.clear()
    await t.host.flush()
    expect(await listed(t.host)).toEqual([])
    // The figures are not the history: Delete All leaves them.
    expect(t.host.usage.summary('verbatim').wordsToday).toBe(3)
  })

  it('an answer about something else does not clear the warning of a write still waiting (QA-06)', async () => {
    const t = setup('forever')
    await t.host.ready
    chmodSync(join(t.dir, 'history'), 0o500)
    t.host.history.put(entry('a'))
    await t.host.flush()
    await t.host.history.page({ search: '', limit: 1 })
    expect(t.host.history.diskProblem).toBe(true)

    chmodSync(join(t.dir, 'history'), 0o700)
    await t.host.flush()
    expect(t.host.history.diskProblem).toBe(false)
  })

  it('a dictation that arrives when the room for waiting ones is full is said, and the others are kept', async () => {
    const t = setup('forever')
    await t.host.ready
    chmodSync(join(t.dir, 'history'), 0o500)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.host.history.put({ ...entry('a'), written: 'x'.repeat(10 * 1024 * 1024) })
    t.host.history.put({ ...entry('b'), written: 'x'.repeat(10 * 1024 * 1024) })
    await t.host.flush()
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
    expect(t.host.history.summary().overflowed).toBe(true)

    chmodSync(join(t.dir, 'history'), 0o700)
    await t.host.flush()
    expect(await listed(t.host)).toEqual(['a'])
    await t.host.history.clear()
    expect(t.host.history.summary().overflowed).toBeUndefined()
  })
})
