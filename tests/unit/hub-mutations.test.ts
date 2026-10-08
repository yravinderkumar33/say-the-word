/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-function-type -- IPC adapter exercises differently shaped channels. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC, type HistoryEntry } from '@shared/ipc'
const doors = vi.hoisted(() => ({ handlers: new Map<string, Function>() }))
/** The row menu the system would draw: its items, and how it is closed. */
const menu = vi.hoisted(() => ({
  items: [] as Array<{ label?: string; click?: () => unknown }>,
  close: null as (() => void) | null,
}))
vi.mock('../../src/main/security', () => ({
  handleFromOwnPages: (channel: string, handle: Function) => doors.handlers.set(channel, handle),
}))
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (items: typeof menu.items) => {
      menu.items = items
      return { popup: ({ callback }: { callback: () => void }) => (menu.close = callback) }
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
}))
import { wireHub, type HubParts } from '../../src/main/hub/wire-hub'
import { SettingsStore } from '../../src/main/store/settings'
import type { Question } from '../../src/main/system/confirm'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** The hub's parts that these requests touch, with a history the test describes. */
function setup(
  history: Record<string, unknown>,
  answer = false,
  more: Record<string, unknown> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'flow-hub-'))
  dirs.push(dir)
  const settings = new SettingsStore(join(dir, 'settings.json'))
  const asked: Question[] = []
  const parts = {
    settings,
    changeSettings: (patch: any) => {
      settings.update(patch)
      return true
    },
    settingsChanged: () => {},
    history,
    ask: (question: Question) => {
      asked.push(question)
      return Promise.resolve(answer)
    },
    dictation: { privacyBlocked: () => false, privacyGeneration: () => 0, copied: () => {} },
    hubWindow: () => ({}),
    sessionOf: () => null,
    doors: { copy: () => {} },
    ...more,
  } as unknown as HubParts
  wireHub(parts)
  return { asked, handler: (channel: string) => doors.handlers.get(channel)! }
}

describe('latest model selection (QA-10)', () => {
  it('returns superseded when slower validation completes after Rules only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-hub-'))
    try {
      const settings = new SettingsStore(join(dir, 'settings.json'))
      let complete!: (value: any) => void
      const parts = {
        settings,
        changeSettings: (patch: any) => {
          settings.update(patch)
          return true
        },
        settingsChanged: () => {},
        dictation: { cleanupFacts: () => new Promise((resolve) => (complete = resolve)) },
      } as unknown as HubParts
      wireHub(parts)
      const select = doors.handlers.get(IPC.cleanupChooseModel)!
      const slow = select(null, 'slow:latest')
      const latest = await select(null, null)
      complete({ models: [{ name: 'slow:latest' }] })
      const stale = await slow
      expect(latest.status).toBe('applied')
      expect(stale.status).toBe('superseded')
      expect(settings.get().cleanupModel).toBe(null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('what deleting the history asks, and says', () => {
  /** Kept on disk, with dictations listed, beside a database that cannot be read. */
  const unreadable = () => ({
    keep: 'forever',
    onDisk: true,
    count: 2,
    leftOnDisk: 0,
    diskFacts: () => ({ files: 1, bytes: 65_536, unreadableFiles: 1, scanFailed: false }),
    preview: () => Promise.resolve({ startsWriting: false, expiring: 0, relisted: 0 }),
    clear: vi.fn(),
    setKeep: vi.fn(),
  })

  it('names a file that cannot be read, which goes with the dictations listed', async () => {
    const history = unreadable()
    const t = setup(history)

    expect(await t.handler(IPC.historyDeleteAll)(null)).toBe(false)
    expect(await t.handler(IPC.historySetKeep)(null, 'session')).toBe(false)

    expect(t.asked[0]!.detail).toContain(
      'The file of dictations saved earlier, still on disk, is deleted too.',
    )
    expect(t.asked[1]!.detail).toContain(
      'including the file of dictations saved earlier that the list does not show',
    )
    expect(history.clear).not.toHaveBeenCalled()
    expect(history.setKeep).not.toHaveBeenCalled()
  })

  it('says in the log how many files would not go', async () => {
    const said = vi.spyOn(console, 'log').mockImplementation(() => {})
    const history = {
      ...unreadable(),
      clear: () =>
        Promise.resolve({
          deleted: 2,
          failed: 0,
          deletedFiles: 0,
          failedFiles: 2,
          scanFailed: false,
        }),
    }
    const t = setup(history, true)

    expect(await t.handler(IPC.historyDeleteAll)(null)).toBe(true)
    expect(said.mock.calls.flat().join(' ')).toContain('2 files are still on disk')
  })
})

describe('what a Delete on the Privacy page says it did', () => {
  it('does not take a recordings folder that could not be looked into for an empty one', async () => {
    const evaluation = mkdtempSync(join(tmpdir(), 'flow-hub-'))
    dirs.push(evaluation)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const t = setup(
      {
        keep: 'session',
        onDisk: false,
        count: 0,
        leftOnDisk: 0,
        bytesOnDisk: () => 0,
        diskFacts: () => ({ files: 0, bytes: 0, unreadableFiles: 0, scanFailed: false }),
      },
      true,
      {
        evaluationDir: evaluation,
        dictation: { speech: { model: { label: 'Parakeet' } } },
        ledger: { list: () => [] },
        logFile: null,
        usage: { bytesOnDisk: 0 },
      },
    )
    chmodSync(evaluation, 0o000)
    let facts: any
    try {
      facts = await t.handler(IPC.privacyDelete)(null, 'recordings')
    } finally {
      chmodSync(evaluation, 0o700)
    }

    expect(facts.problem).toMatchObject({ kind: 'recordings', deleted: 0, scanFailed: true })
    expect(facts.problem.failed).toBeGreaterThan(0)
  })
})

describe("a row's menu", () => {
  it('says in the log when what was chosen fails, and leaves nothing unhandled', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const row: HistoryEntry = {
        id: 'one',
        endedAt: 0,
        app: null,
        outcome: 'notPasted',
        fetched: null,
        mode: 'verbatim',
        note: null,
        heard: 'synthetic',
        written: 'synthetic',
        failure: null,
        audioMs: null,
        timings: { releaseToTextMs: null, tidyMs: null, pasteMs: null },
      }
      const unavailable = new Error('Storage process unavailable')
      const t = setup({
        // The row is read for the menu; by the time an item is chosen, the storage has stopped.
        get: vi.fn().mockResolvedValueOnce(row).mockRejectedValue(unavailable),
        remove: () => Promise.reject(unavailable),
        patch: () => {},
      })
      const chosen = t.handler(IPC.historyMenu)(null, 'one')
      await vi.waitFor(() => expect(menu.close).not.toBeNull())
      menu.items.find((item) => item.label === 'Copy')!.click!()
      menu.items.find((item) => item.label === 'Delete')!.click!()
      menu.close!()
      expect(await chosen).toBeNull()
      await settled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }

    expect(unhandled).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledTimes(2)
  })
})
