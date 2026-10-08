import type { HistorySummary, HistoryRow, HistoryKeep } from './ipc'

export interface StorageInit {
  history: {
    dir: string
    keep: HistoryKeep
    keepIsKnown?: boolean
    paused: boolean
  }
  usageFile: string
  /** Main's: it works out the figures from the snapshot. The storage process does not use it. */
  weekStartsOn: number
}
export interface StorageSnapshot {
  history: HistorySummary
  recent: HistoryRow[]
  copyable: HistoryRow[]
  usage: {
    version: 1
    words: Record<string, number>
    timings: { verbatim: number[]; cleaned: number[] }
  }
  usageBytes: number
  /**
   * What the storage process has accepted and holds, but could not yet write where it
   * belongs: the ids of dictations and the receipts of counts. Main keeps its own copy of
   * each until it is no longer named here, so that a restarted process can be given it again.
   */
  waiting: { history: string[]; usage: string[] }
}
/** One request to the storage process: what to do, and with what. */
export interface StorageRequest {
  op: string
  args: unknown[]
}
/** Its answer. The storage process answers every request, and never with an error of its own. */
export interface StorageAnswer {
  value?: unknown
  snapshot?: StorageSnapshot
  /**
   * The request was not carried out. `invalid`: it never will be, because what it carries
   * is not a dictation or a count the stores accept; sending it again would change nothing.
   */
  failed?: true | 'invalid'
}
/** What the storage process offers main over its port (with `birpc`, which pairs answers to requests). */
export interface StorageFunctions {
  request(op: string, args: unknown[]): StorageAnswer
}
