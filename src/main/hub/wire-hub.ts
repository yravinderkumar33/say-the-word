import { BrowserWindow, Menu } from 'electron'
import { z } from 'zod'
import {
  HISTORY_KEEPS,
  IPC,
  MOST_HISTORY_ROWS,
  STORED_KINDS,
  type ChangeResult,
  type CleanupFacts,
  type DeleteProblem,
  type ExternalLink,
  type HistoryEntry,
  type HistoryKeep,
  type HistoryPage,
  type Microphone,
  type ModelChoiceResult,
  type PrivacyFacts,
  type StoredKind,
  type TryResult,
} from '@shared/ipc'
import { DICTATION_KEYS } from '@shared/keycodes'
import type { Dictation } from '../dictation/wire-dictation'
import type { HistoryRepository, UsageRepository } from '../storage/storage-host'
import type { LogFile } from '../log-file'
import type { NetworkLedger } from '../privacy/network-ledger'
import { deleteRecordings, recordingFacts } from '../privacy/stored'
import { handleFromOwnPages } from '../security'
import type { SettingsPatch, SettingsStore } from '../store/settings'
import type { Ask } from '../system/confirm'
import type { LoginItem } from '../system/login-item'
import { ollamaAddress } from './ollama-address'
import { deleteAllHistoryQuestion, deleteStoredQuestion, keepQuestion } from './questions'

/** The longest search that is looked for. */
const MOST_SEARCH = 200

/**
 * The things outside the app that a page can ask for: a file shown in Finder, a page
 * opened in the browser, text put on the clipboard, Ollama started. They are handed in
 * so that the automated tests can count them instead of doing them: a test must not
 * bring Finder or a browser to the front, or write over the clipboard of the person
 * using the Mac.
 */
export interface Doors {
  showInFinder(path: string): void
  openFolder(path: string): void
  openLink(link: ExternalLink): void
  copy(text: string): void
  startOllama(): void
}

export interface HubParts {
  settings: SettingsStore
  /** Every change goes through here: it is made only if it can be saved. */
  changeSettings(patch: SettingsPatch): boolean
  history: HistoryRepository
  dictation: Dictation
  usage: UsageRepository
  ledger: NetworkLedger
  logFile: LogFile | null
  usageFile: string
  evaluationDir: string
  ask: Ask
  loginItem: LoginItem
  doors: Doors
  /** The microphones the system offers now. */
  microphones(): Microphone[]
  setMicrophoneOrder(deviceIds: string[]): void
  /** A setting the Dock icon, the menu or the tray depends on has changed. */
  settingsChanged(): void
  /** What "Copy Diagnostics" puts on the clipboard. */
  diagnostics(): Promise<string>
  hubWindow(): BrowserWindow | null
  closeHub(): void
  /** The first run is to be shown again, or is over. */
  setFirstRun(pending: boolean): void
  /** The session a dictation in the history came from, when it was made in this launch. */
  sessionOf(id: string): number | null
}

const preferenceSchema = z
  .object({
    sounds: z.boolean(),
    soundVolume: z.number().min(0).max(1),
    pillAtRest: z.boolean(),
    showInDock: z.boolean(),
    modelKeep: z.enum(['tenMinutes', 'hour', 'always']),
    dictationKey: z.enum(DICTATION_KEYS as [string, ...string[]]),
    ollamaUrl: z.string().max(200),
    historyPaused: z.boolean(),
  })
  .partial()
  .strict()

const NOT_SAVED = 'That could not be saved.'

/** The requests of the main window's pages that came with the History, Cleanup, Settings and Privacy pages. */
export function wireHub(parts: HubParts): {
  privacyFacts(): PrivacyFacts
  /** Puts a dictation's text on the clipboard; the menu-bar menu's Recent uses it too. */
  copyEntry(id: string, which: 'written' | 'heard'): Promise<boolean>
} {
  const { settings, changeSettings, history, dictation, usage, ask, doors } = parts
  /** What the last Delete on the Privacy page left behind. */
  let deleteProblem: DeleteProblem | null = null
  let selection = 0
  let configuration = 0

  // --- Settings ---------------------------------------------------------------------

  handleFromOwnPages(IPC.changePreference, (_event, payload): ChangeResult => {
    const parsed = preferenceSchema.safeParse(payload)
    if (!parsed.success)
      return { ok: false, problem: 'That is not a setting this page can change.' }
    const patch = parsed.data
    if (patch.ollamaUrl !== undefined) {
      const address = ollamaAddress(patch.ollamaUrl, settings.get().allowRemoteOllama)
      if (!address.ok) return address
      patch.ollamaUrl = address.url
    }
    if (!changeSettings(patch as SettingsPatch))
      return { ok: false, problem: NOT_SAVED, appliedVolume: settings.get().soundVolume }
    if (patch.ollamaUrl !== undefined) {
      configuration++
      selection++
    }
    if (patch.historyPaused !== undefined) history.setPaused(patch.historyPaused)
    parts.settingsChanged()
    return { ok: true, appliedVolume: settings.get().soundVolume }
  })

  handleFromOwnPages(IPC.setMicrophoneOrder, (_event, payload): void => {
    const ids = z.array(z.string().min(1)).max(64).safeParse(payload)
    if (ids.success) parts.setMicrophoneOrder(ids.data)
  })

  handleFromOwnPages(IPC.setOpenAtLogin, (_event, on): void => {
    if (typeof on !== 'boolean') return
    parts.loginItem.set(on)
    console.log(`[app] open at login: ${on ? 'on' : 'off'}`)
  })

  handleFromOwnPages(IPC.resumeDictation, (): void => dictation.pause.end())

  handleFromOwnPages(IPC.openLink, (_event, link): void => {
    if (link === 'support' || link === 'source' || link === 'issues' || link === 'ollama') {
      doors.openLink(link)
    }
  })
  handleFromOwnPages(IPC.showLog, (): void => {
    if (parts.logFile) doors.showInFinder(parts.logFile.path)
  })
  handleFromOwnPages(IPC.copyDiagnostics, async (): Promise<void> => {
    doors.copy(await parts.diagnostics())
  })

  // --- History ----------------------------------------------------------------------

  handleFromOwnPages(IPC.historyList, async (_event, payload): Promise<HistoryPage> => {
    const query = z
      .object({ search: z.string(), limit: z.number().int().min(1).max(MOST_HISTORY_ROWS) })
      .safeParse(payload)
    // A search that is longer than any dictation's first line is cut, not thrown away:
    // thrown away, it would list everything, as if nothing had been searched for.
    if (dictation.privacyBlocked?.()) return { rows: [], total: 0, matched: 0 }
    const generation = dictation.privacyGeneration?.()
    const page = await history.page(
      query.success
        ? { ...query.data, search: query.data.search.slice(0, MOST_SEARCH) }
        : { search: '', limit: MOST_HISTORY_ROWS },
    )
    return generation === dictation.privacyGeneration?.()
      ? page
      : { rows: [], total: 0, matched: 0 }
  })

  handleFromOwnPages(IPC.historyEntry, async (_event, id): Promise<HistoryEntry | null> => {
    if (typeof id !== 'string' || dictation.privacyBlocked?.()) return null
    const generation = dictation.privacyGeneration?.()
    const entry = await history.get(id)
    return generation === dictation.privacyGeneration?.() ? entry : null
  })

  /** Puts a dictation's text on the clipboard, and notes that a text that was not pasted has been fetched. */
  const copyEntry = async (id: string, which: 'written' | 'heard'): Promise<boolean> => {
    if (dictation.privacyBlocked?.()) return false
    const generation = dictation.privacyGeneration?.()
    const entry = await history.get(id)
    if (generation !== dictation.privacyGeneration?.()) return false
    const text = which === 'heard' ? entry?.heard : entry?.written
    if (!entry || !text) return false
    doors.copy(text)
    if (entry.outcome !== 'pasted' && !entry.fetched) history.patch(id, { fetched: 'copied' })
    dictation.copied(parts.sessionOf(id))
    return true
  }
  handleFromOwnPages(IPC.historyCopy, async (_event, payload): Promise<boolean> => {
    const asked = z
      .object({ id: z.string(), which: z.enum(['written', 'heard']) })
      .safeParse(payload)
    return asked.success ? copyEntry(asked.data.id, asked.data.which) : false
  })

  handleFromOwnPages(IPC.historyDelete, async (_event, id): Promise<void> => {
    if (typeof id === 'string') await history.remove(id)
  })

  /**
   * The files a deletion of the history removes that no listed dictation stands for: days'
   * files left while it is held in memory; kept on disk, those that cannot be read (a
   * database damaged, or written by a newer build), or whatever files are there when
   * nothing is listed. A question about the dictations listed alone would hide them.
   */
  const unlistedFiles = (): number => {
    if (!history.onDisk) return history.leftOnDisk
    const disk = history.diskFacts()
    return history.count === 0 ? disk.files : disk.unreadableFiles
  }

  handleFromOwnPages(IPC.historyDeleteAll, async (): Promise<boolean> => {
    if (history.count === 0 && history.diskFacts().files === 0 && !history.diskFacts().scanFailed)
      return false
    const question = deleteAllHistoryQuestion(history.count, history.onDisk, unlistedFiles())
    if (!(await ask(question))) return false
    const { deleted, failed, failedFiles } = await history.clear()
    console.log(
      `[history] deleted ${deleted}; ${failed} could not be deleted; ` +
        `${failedFiles} files are still on disk`,
    )
    return true
  })

  /**
   * How long dictations are kept. Whatever is asked for, a system dialog says what it
   * will do and waits for a yes: writing what was said to disk is never started on a
   * page's word alone, and neither is deleting all of it (Delete All, and the Privacy
   * page's Delete, ask in the same way). One dictation at a time is deleted on the
   * page's word, as its Delete button and the Delete key do.
   */
  const setKeep = async (keep: HistoryKeep): Promise<boolean> => {
    if (keep === history.keep && settings.stated('historyKeep')) return true
    const change = await history.preview(keep)
    // Going back to memory deletes every file the history owns, those the list does not show too.
    const unlisted = history.onDisk ? history.diskFacts().unreadableFiles : history.leftOnDisk
    if (!(await ask(keepQuestion(keep, change, history.count, unlisted)))) return false
    if (!changeSettings({ historyKeep: keep })) return false
    await history.setKeep(keep)
    console.log(`[history] dictations are kept: ${keep}`)
    return true
  }
  handleFromOwnPages(IPC.historySetKeep, (_event, keep): Promise<boolean> | boolean =>
    HISTORY_KEEPS.includes(keep as HistoryKeep) ? setKeep(keep as HistoryKeep) : false,
  )

  // A row's menu, drawn by the system: the keyboard's and VoiceOver's way to what the
  // pointer finds on hover.
  handleFromOwnPages(IPC.historyMenu, async (_event, id): Promise<'open' | null> => {
    const entry = typeof id === 'string' ? await history.get(id) : null
    const window = parts.hubWindow()
    if (!entry || !window) return Promise.resolve(null)
    return new Promise((resolve) => {
      let chosen: 'open' | null = null
      // What the storage cannot do now is said in the log, never with the dictation's text.
      const menu = Menu.buildFromTemplate([
        { label: 'Open', click: () => (chosen = 'open') },
        {
          label: 'Copy',
          enabled: entry.written.length > 0,
          click: () =>
            void copyEntry(entry.id, 'written').catch(() =>
              console.error('[history] a dictation could not be copied'),
            ),
        },
        { type: 'separator' },
        {
          label: 'Delete',
          click: () =>
            void history
              .remove(entry.id)
              .catch(() => console.error('[history] a dictation could not be deleted')),
        },
      ])
      // Closed with or without a choice: a click's handler runs before this.
      menu.popup({ window, callback: () => setImmediate(() => resolve(chosen)) })
    })
  })

  // --- Cleanup ----------------------------------------------------------------------

  handleFromOwnPages(IPC.cleanupFacts, async (): Promise<CleanupFacts> => {
    const facts = await dictation.cleanupFacts()
    return { ...facts, typicalMs: usage.summary('cleaned').typicalMs }
  })

  handleFromOwnPages(IPC.cleanupChooseModel, async (_event, name): Promise<ModelChoiceResult> => {
    const rejected = (problem: string): ModelChoiceResult => ({
      status: 'rejected',
      chosen: settings.get().cleanupModel,
      problem,
    })
    if (name !== null && (typeof name !== 'string' || name.length > 160))
      return rejected('That model cannot be selected.')
    const mine = ++selection
    const revision = configuration
    const server = settings.get().ollamaUrl
    if (name !== null) {
      const facts = await dictation.cleanupFacts()
      if (mine !== selection || revision !== configuration || server !== settings.get().ollamaUrl)
        return { status: 'superseded', chosen: settings.get().cleanupModel }
      if (!facts.models.some((model) => model.name === name))
        return rejected('That model is not available on this Mac.')
    }
    if (!changeSettings({ cleanupModel: name })) return rejected(NOT_SAVED)
    configuration++
    parts.settingsChanged()
    return { status: 'applied', chosen: settings.get().cleanupModel }
  })

  handleFromOwnPages(IPC.cleanupStartOllama, (): void => doors.startOllama())

  handleFromOwnPages(IPC.cleanupTry, (_event, text): Promise<TryResult> =>
    dictation.tryCleanup(typeof text === 'string' ? text : ''),
  )

  // --- Privacy ----------------------------------------------------------------------

  const privacyFacts = (): PrivacyFacts => ({
    recognizer: dictation.speech.model.label,
    contacted: parts.ledger.list(),
    history: {
      keep: history.keep,
      count: history.count,
      onDisk: history.onDisk,
      bytes: history.bytesOnDisk(),
      left: history.leftOnDisk,
      disk: history.diskFacts(),
    },
    recordings: {
      saving: settings.get().evaluationRecording,
      ...recordingFacts(parts.evaluationDir),
    },
    log: { bytes: parts.logFile?.bytesOnDisk ?? 0 },
    counts: { bytes: usage.bytesOnDisk },
    problem: deleteProblem,
  })
  handleFromOwnPages(IPC.privacyFacts, privacyFacts)

  handleFromOwnPages(IPC.privacyReveal, (_event, kind): void => {
    if (kind === 'history' && (history.onDisk || history.leftOnDisk > 0)) {
      doors.openFolder(history.dir)
    } else if (kind === 'recordings') doors.openFolder(parts.evaluationDir)
    else if (kind === 'log' && parts.logFile) doors.showInFinder(parts.logFile.path)
    else if (kind === 'counts') doors.showInFinder(parts.usageFile)
  })

  /** Deletes one kind of stored thing. Returns how much went and how much would not. */
  const remove = async (kind: StoredKind): Promise<Omit<DeleteProblem, 'kind'>> => {
    switch (kind) {
      case 'history': {
        const result = await history.clear()
        // Files that are not listed and would not go are still what was asked to be deleted.
        return {
          deleted: result.deleted,
          failed: result.failed + result.failedFiles + Number(result.scanFailed),
          failedRows: result.failed,
          failedFiles: result.failedFiles,
          scanFailed: result.scanFailed,
        }
      }
      case 'recordings': {
        const result = deleteRecordings(parts.evaluationDir)
        // A folder that could not be looked into may still hold recordings: not done.
        return { ...result, failed: result.failed + Number(result.scanFailed) }
      }
      case 'log':
        return parts.logFile?.clear() === false
          ? { deleted: 0, failed: 1 }
          : { deleted: 1, failed: 0 }
      case 'counts':
        return (await usage.clear()) ? { deleted: 1, failed: 0 } : { deleted: 0, failed: 1 }
    }
  }

  handleFromOwnPages(IPC.privacyDelete, async (_event, kind): Promise<PrivacyFacts> => {
    const which =
      kind === 'everything' || STORED_KINDS.includes(kind as StoredKind)
        ? (kind as StoredKind | 'everything')
        : null
    if (!which) return privacyFacts()
    const counts = {
      history: history.count,
      recordings: recordingFacts(parts.evaluationDir).count,
      historyOnDisk: history.onDisk,
      historyLeft: unlistedFiles(),
    }
    if (!(await ask(deleteStoredQuestion(which, counts)))) return privacyFacts()
    deleteProblem = null
    try {
      if (which === 'everything') {
        const failed = await dictation.discardAll()
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send(IPC.privacyReset)
        if (failed > 0) deleteProblem = { kind: 'recordings', deleted: 0, failed }
      }
      for (const each of which === 'everything' ? STORED_KINDS : [which]) {
        let result: Omit<DeleteProblem, 'kind'>
        try {
          result = await remove(each)
        } catch {
          result = { deleted: 0, failed: 1 }
        }
        console.log(
          `[privacy] deleted ${each}: ${result.deleted}; could not delete ${result.failed}`,
        )
        if (result.failed > 0) deleteProblem ??= { kind: each, ...result }
      }
    } finally {
      if (which === 'everything') {
        for (const window of BrowserWindow.getAllWindows())
          window.webContents.send(IPC.privacyReset)
        dictation.resumeAfterDiscard()
      }
    }
    return privacyFacts()
  })

  // --- First run --------------------------------------------------------------------

  handleFromOwnPages(IPC.firstRunFinish, (_event, openAtLogin): void => {
    // The switch on the last step is the choice, both ways: switched off there, a login
    // item that was on is taken away. Where it cannot be set at all there is nothing to do.
    if (typeof openAtLogin === 'boolean' && parts.loginItem.get() !== null) {
      parts.loginItem.set(openAtLogin)
    }
    parts.setFirstRun(false)
    parts.closeHub()
  })
  handleFromOwnPages(IPC.firstRunAgain, (): void => parts.setFirstRun(true))

  return { privacyFacts, copyEntry }
}
