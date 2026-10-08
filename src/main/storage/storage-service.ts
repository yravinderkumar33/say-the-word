import { z } from 'zod'
import type {
  StorageAnswer,
  StorageInit,
  StorageRequest,
  StorageSnapshot,
} from '@shared/storage-protocol'
import { HistoryStore } from '../history/history-store'
import { UsageStore } from '../store/usage'

/** How many of the newest dictations main is given with every answer, for Home and the menu. */
const RECENT_IN_SNAPSHOT = 8

const countSchema = z.tuple([
  z.object({
    words: z.number().min(0),
    mode: z.enum(['verbatim', 'cleaned']),
    releaseToPasteMs: z.number().nullable(),
  }),
  z.number(),
  z.string().min(1),
])

/**
 * What the storage process does with each request, apart from the process itself, so
 * that a test can drive it with no Electron in sight. One request at a time, in order:
 * the databases are synchronous, and this process does nothing else.
 *
 * Nothing that was said ever reaches a reply's error or the log from here: a failure is
 * a flag, and the snapshot holds counts, ids and the short rows the pages show.
 */
export class StorageService {
  private history: HistoryStore | null = null
  private usage: UsageStore | null = null

  /** The answer to one request, and whether the process is to end after giving it. */
  handle(request: StorageRequest): { answer: StorageAnswer; exit?: true } {
    let value: unknown
    try {
      value = this.run(request)
    } catch (error) {
      return {
        answer: { failed: error instanceof z.ZodError ? 'invalid' : true, ...this.trySnapshot() },
      }
    }
    if (request.op === 'close') return { answer: { value: true }, exit: true }
    // What was done stands although the reads after it are refused: a deletion that was
    // made is not said to have failed.
    return { answer: { value, ...this.trySnapshot() } }
  }

  /** The snapshot, if it can be read: a database that refuses a write may refuse reads too. */
  private trySnapshot(): { snapshot?: StorageSnapshot } {
    try {
      return { snapshot: this.snapshot() }
    } catch {
      return {}
    }
  }

  private run({ op, args }: StorageRequest): unknown {
    if (op === 'init') {
      const options = args[0] as StorageInit
      this.history = new HistoryStore(options.history)
      this.usage = new UsageStore(options.usageFile)
      return undefined
    }
    const history = this.history
    const usage = this.usage
    if (!history || !usage) throw new Error('Storage is not started')
    switch (op) {
      case 'history.put':
        history.put(args[0] as Parameters<HistoryStore['put']>[0], args[1] === true)
        return undefined
      case 'history.patch':
        history.patch(z.string().parse(args[0]), args[1] as Parameters<HistoryStore['patch']>[1])
        return undefined
      case 'history.get':
        return history.get(z.string().parse(args[0]))
      case 'history.page':
        return history.page(args[0] as Parameters<HistoryStore['page']>[0])
      case 'history.remove':
        return history.remove(z.string().parse(args[0]))
      case 'history.clear':
        return history.clear()
      case 'history.preview':
        return history.preview(args[0] as Parameters<HistoryStore['preview']>[0])
      case 'history.keep':
        history.setKeep(args[0] as Parameters<HistoryStore['setKeep']>[0])
        return undefined
      case 'history.pause':
        history.setPaused(args[0] === true)
        return undefined
      case 'history.sweep':
        return history.sweep()
      case 'usage.add': {
        const [dictation, time, receipt] = countSchema.parse(args)
        usage.add(dictation, new Date(time), receipt)
        return undefined
      }
      case 'usage.clear':
        return usage.clear()
      case 'flush':
        history.flush()
        usage.flush()
        return undefined
      case 'close':
        history.close()
        usage.close()
        return undefined
      default:
        throw new Error('Unknown storage operation')
    }
  }

  private snapshot(): StorageSnapshot {
    const history = this.history
    const usage = this.usage
    if (!history || !usage) throw new Error('Storage is not started')
    // Once per answer: looking at the folder reads the files that are left in it.
    const disk = history.diskFacts()
    return {
      history: {
        keep: history.keep,
        paused: history.paused,
        count: history.count,
        version: history.version,
        diskProblem: history.diskProblem,
        leftOnDisk: history.onDisk ? 0 : disk.files,
        disk,
      },
      recent: history.newest(RECENT_IN_SNAPSHOT),
      copyable: history.newestWithText(RECENT_IN_SNAPSHOT),
      usage: usage.snapshot(),
      usageBytes: usage.bytesOnDisk,
      waiting: { history: history.waitingIds(), usage: usage.waitingIds() },
    }
  }
}
