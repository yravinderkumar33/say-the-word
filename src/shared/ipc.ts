import { z } from 'zod'
import type { DictationKey } from './keycodes'

export { IPC } from './ipc-channels'
export {
  DEFAULT_OVERLAY_PREFS,
  HISTORY_KEEPS,
  HUB_PAGES,
  MOST_HISTORY_ROWS,
  STORED_KINDS,
} from './ipc-values'

// --- Capture -------------------------------------------------------------------------

export type CaptureCommand =
  | { kind: 'start'; session: number; deviceId: string | null }
  /** Stop after a short tail, send what is left, and tell the worker the session is over. */
  | { kind: 'stop'; session: number }
  /** Stop at once and send nothing more. */
  | { kind: 'cancel'; session: number }
  /** The session's text has arrived (or never will): its audio need not be kept any longer. */
  | { kind: 'release'; session: number }
  /** Undo or Retry: send the recording that is still held to the worker again. */
  | { kind: 'resend'; session: number }
  /** Tests only: behave as if the microphone had been unplugged. */
  | { kind: 'loseMicrophone'; session: number }

export const captureEventSchema = z.discriminatedUnion('kind', [
  /** Audio has started to flow. `openMs` is how long the microphone took to open. */
  z.object({ kind: z.literal('live'), session: z.number().int(), openMs: z.number() }),
  /** Capture is over and every frame has been sent. `micLost` means it ended on its own. */
  z.object({
    kind: z.literal('ended'),
    session: z.number().int(),
    frames: z.number().int(),
    micLost: z.boolean(),
  }),
  z.object({ kind: z.literal('failed'), session: z.number().int(), message: z.string() }),
  /** Asked to send a recording again, but it is no longer held. */
  z.object({ kind: z.literal('gone'), session: z.number().int() }),
])
export type CaptureEvent = z.infer<typeof captureEventSchema>

/**
 * The microphones the overlay page lists. Their names are written to the settings, so a
 * list longer than any Mac offers, or a name longer than any device has, is not taken:
 * as many as the order of preference may hold (`setMicrophoneOrder`).
 */
export const microphonesSchema = z
  .array(z.object({ deviceId: z.string().max(256), label: z.string().max(256) }))
  .max(64)
export type Microphone = z.infer<typeof microphonesSchema>[number]

// --- The pill ------------------------------------------------------------------------

/** `start`: the resting pill was clicked. `stop`: the stop button of a hands-free recording. */
export const pillActionSchema = z.enum(['copy', 'dismiss', 'cancel', 'start', 'stop', 'redo'])
export type PillAction = z.infer<typeof pillActionSchema>

/**
 * What kind of thing a message is. The pill gives each its own icon and weight, so
 * that the kind can be told without reading the words, and never by colour alone.
 *
 * - `plain`: nothing went wrong that needs attention (a cancel, no speech).
 * - `protected`: the app refused to paste on purpose, and the text is safe.
 * - `problem`: something failed.
 * - `note`: worth knowing, nothing to do.
 * - `confirm`: what was asked for has been done. Brief, and with no buttons.
 */
export type PillMessageKind = 'plain' | 'protected' | 'problem' | 'note' | 'confirm'

/** A short message on the pill, shown when there is something to say after the fact. */
export interface PillRecovery {
  message: string
  messageKind: PillMessageKind
  /** Offer a Copy button: the session left text behind. */
  canCopy: boolean
  /** Draw attention with a sound, for things the user would otherwise miss. */
  sound: boolean
  /**
   * Offer to transcribe the recording after all and paste it: `Undo` after a cancel,
   * `Retry` after a failed decode. Absent when the recording is no longer held.
   */
  redo?: 'Undo' | 'Retry'
  /**
   * The recording was stopped at the length limit, and what was said up to it was used
   * as if the key had been released. VoiceOver is told so from this, not from the words.
   */
  stoppedAtLimit?: boolean
}

/** What a dictation that takes more than a moment to become text is busy with. */
export type ProcessingHint = 'tidying' | 'loadingModel'

export type PillState =
  /** `waiting`: a dictation was not pasted, and its text has not been fetched since. */
  | { kind: 'resting'; waiting: boolean }
  /**
   * The microphone has been requested but no audio is flowing yet. `slow`: it has been
   * a second, which is long enough to say so in words.
   */
  | { kind: 'starting'; slow: boolean }
  /**
   * `handsFree`: no key is held, so the pill offers Stop and Cancel. `startedAt` and
   * `limitAt` (milliseconds since the epoch) are when the recording began and when it
   * will be stopped, for the clock a hands-free recording shows.
   */
  | { kind: 'listening'; handsFree: boolean; startedAt: number; limitAt: number }
  /**
   * `long`: it has taken a second, so there is time to press Cancel and it is offered.
   * `hint`: what the wait is for, when that is known.
   */
  | { kind: 'processing'; long: boolean; hint: ProcessingHint | null }
  | ({ kind: 'recovery' } & PillRecovery)

/**
 * `busy`: the shortcut was pressed while the previous dictation is still being processed.
 * `limitSoon`: a recording has a minute left before it is stopped.
 */
export type PillCue = 'busy' | 'limitSoon'

// --- Smoke check ---------------------------------------------------------------------

export interface SmokeRequest {
  /** When present, the overlay sends this audio to the worker as one session. */
  audio: { session: number; samples: Float32Array } | null
}

export interface OverlaySmokeReport {
  /** `app:` in a packaged build, `http:` under the dev server. */
  pageProtocol: string
  workletLoaded: boolean
  probePosted: boolean
  /** Frames of the smoke recording sent to the worker; zero when none was supplied. */
  framesPosted: number
  error?: string
}

// --- The overlay's preferences -------------------------------------------------------

/**
 * The settings the overlay page acts on. They are sent to it when it loads and
 * whenever one of them changes.
 */
export interface OverlayPrefs {
  /** Whether the cues are played at all, and how loud: 0 to 1. */
  sounds: boolean
  volume: number
  /** False: nothing is drawn at rest. The pill appears with a dictation, or with something to say. */
  pillAtRest: boolean
  /** The key that starts a dictation. */
  key: DictationKey
  /** Dictation is paused until then (milliseconds since the epoch); null when it is not. */
  pausedUntil: number | null
}

// --- Hub -----------------------------------------------------------------------------

/**
 * Where speech recognition stands. `stopped` is normal: the model is unloaded after a
 * while without dictation, and loaded again on the next one.
 */
export type SpeechState = 'stopped' | 'modelMissing' | 'loading' | 'ready' | 'failed'

export interface AppStatus {
  versions: { app: string; electron: string; node: string; chrome: string }
  packaged: boolean
  helper: {
    running: boolean
    protocol: number | null
    /** Null while the helper is not running. */
    accessibilityTrusted: boolean | null
    /** True once the key event tap exists, which is when shortcuts start working. */
    tapInstalled: boolean | null
  }
  speech: {
    state: SpeechState
    modelDownloaded: boolean
    modelLabel: string
    /** Whose work the model is and on what terms: the terms ask that it be shown. */
    modelLicence: string
    /** Size of the download in bytes. */
    modelBytes: number
    /** How many languages the model recognizes. */
    modelLanguages: number
    /** The loaded engine's id, or null while no model is loaded. */
    engine: string | null
    /** Download progress from 0 to 1, or null when no download is running. */
    downloadProgress: number | null
    downloadError: string | null
  }
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
  /**
   * True while every dictation's recording and text are being written to disk
   * ("Save every dictation" in the menu). The window shows it on every page.
   */
  savingDictations: boolean
  mode: DictationMode
  /** What Cleaned mode will do right now, in the menu's words. Empty in Verbatim mode. */
  cleanup: string
  /** Ollama's app is on this Mac, so it can be started from here when it is not running. */
  ollamaInstalled: boolean
  /** The microphones the system offers. */
  microphones: Microphone[]
  /**
   * The order of preference, by device id: the first one that is connected is used.
   * Empty means the system's default microphone is followed. A microphone that is not
   * connected is remembered with the name it had.
   */
  microphoneOrder: Microphone[]
  /** The one a dictation would use now, by device id; null for the system default. */
  microphoneInUse: string | null
  dictationKey: DictationKey
  /** Dictation is paused until then (milliseconds since the epoch); null when it is not. */
  pausedUntil: number | null
  /** Another app that listens to the dictation key is running, by its name. */
  conflict: string | null
  /**
   * The steps of the first launch are to be shown: `first` on a new installation, `again`
   * when Settings asked for them once more, which starts them from the choices already
   * made. Null when they are not shown.
   */
  firstRun: 'first' | 'again' | null
  /** The newest dictations of the history, newest first. */
  recent: HistoryRow[]
  history: HistorySummary
  /** How often each way of dictating has ended in a paste since launch. Counts only. */
  practice: Practice
  usage: Usage
  preferences: Preferences
  /** Where "Buy me a coffee" leads, by host name; null while there is no such page. */
  supportHost: string | null
  /** Which of the pages in a browser the app can open: one is listed only when it exists. */
  links: { source: boolean; issues: boolean }
}

export type DictationMode = 'verbatim' | 'cleaned'

/** How long the speech model stays in memory after the last dictation. */
export type ModelKeep = 'tenMinutes' | 'hour' | 'always'

/** The settings the Settings page shows, as they are in force. */
export interface Preferences {
  sounds: boolean
  /** 0 to 1. */
  soundVolume: number
  pillAtRest: boolean
  showInDock: boolean
  /** Null where it cannot be set: a run from the source tree is not an app macOS can open at login. */
  openAtLogin: boolean | null
  modelKeep: ModelKeep
  ollamaUrl: string
}

/** What a page of the app may ask to have changed. Everything else is changed elsewhere. */
export interface PreferencePatch {
  sounds?: boolean
  soundVolume?: number
  pillAtRest?: boolean
  showInDock?: boolean
  modelKeep?: ModelKeep
  dictationKey?: DictationKey
  ollamaUrl?: string
  historyPaused?: boolean
}

/** The pages of the main window. */
export type HubPage = 'home' | 'history' | 'cleanup' | 'settings' | 'privacy' | 'about'

/** Whether a change was made, and when it was not, why, in words for the page. */
export type ChangeResult = ({ ok: true } | { ok: false; problem: string }) & {
  appliedVolume?: number
}
export interface ModelChoiceResult {
  status: 'applied' | 'superseded' | 'rejected'
  chosen: string | null
  problem?: string
}

/** The pages in a browser the app can open. A page of the app names the kind, never an address. */
export type ExternalLink = 'support' | 'source' | 'issues' | 'ollama'

/** How often each exercise of the first run has been done: a paste after each way of dictating. */
export interface Practice {
  /** The key held, then let go. */
  hold: number
  handsFree: number
  /** Cancelled, then brought back with Undo. */
  undo: number
}

/** Counts, never words: how much was dictated, and how long it usually takes. */
export interface Usage {
  wordsToday: number
  wordsThisWeek: number
  /** The usual time from releasing the key to the paste, in the current mode; null before there is one. */
  typicalMs: number | null
}

// --- History -------------------------------------------------------------------------

/**
 * How long dictations are kept. `session`: in memory only, gone when the app quits.
 * The others write each dictation to disk, which is asked for in a system dialog.
 */
export type HistoryKeep = 'session' | 'week' | 'month' | 'forever'

/** How a dictation ended. `pasted` is the ordinary case and is not said. */
export type HistoryOutcome =
  | 'pasted'
  | 'focusMoved'
  | 'passwordField'
  | 'secureInput'
  | 'notPasted'
  | 'cancelled'
  | 'interrupted'
  | 'noSpeech'
  | 'failed'

/** One dictation as a row of the list. It never leaves the app's own windows. */
export interface HistoryRow {
  id: string
  /** Milliseconds since the epoch, when the dictation ended. */
  endedAt: number
  /** The app the text was meant for, as the system names it; null when it was never read. */
  app: string | null
  /** The start of what was written, on one line. Empty when the dictation left no text. */
  text: string
  outcome: HistoryOutcome
  /** Not pasted at first, and fetched since: copied, or pasted with the shortcut. */
  fetched: 'copied' | 'pasted' | null
  mode: DictationMode
  /** Cleaned mode: why the text is what it is (`cleaned`, `unreachable`, `guard:…`). */
  note: string | null
  /** Why it failed, in the app's words, when it did. */
  failure: string | null
}

/** Where the time of a dictation went, in milliseconds. Null for a part that did not happen. */
export interface HistoryTimings {
  /** Releasing the key to the text being ready: recognizing, then tidying. */
  releaseToTextMs: number | null
  tidyMs: number | null
  /** The text being ready to the paste being done. */
  pasteMs: number | null
}

/** One dictation in full, for the page that opens a row. */
export interface HistoryEntry extends Omit<HistoryRow, 'text'> {
  /** What the recognizer heard, untouched. */
  heard: string
  /** What was pasted, or offered. */
  written: string
  /** How long the recording was. */
  audioMs: number | null
  timings: HistoryTimings
}

export interface HistoryQuery {
  /** Rows whose text or app holds these words. Empty for all. */
  search: string
  limit: number
}

export interface HistoryPage {
  rows: HistoryRow[]
  /** How many dictations the history holds, and how many of them match the search. */
  total: number
  matched: number
}

export interface HistoryDiskFacts {
  files: number
  bytes: number
  unreadableFiles: number
  scanFailed: boolean
}

export interface HistorySummary {
  disk?: HistoryDiskFacts
  keep: HistoryKeep
  paused: boolean
  count: number
  /** Goes up with every change, so that a page knows when to ask for the list again. */
  version: number
  /** The last write to disk, or the last deletion from it, failed: the list and the disk may differ. */
  diskProblem: boolean
  /**
   * How many days' files are on disk although the history is held in memory only. They
   * are not listed: the settings no longer say that they are kept, or they would not go.
   */
  leftOnDisk: number
  /**
   * How many dictations held in memory were lost since launch, because the process that
   * keeps the history stopped unexpectedly. Said on the History page: never silently.
   */
  lost?: number
  /** A dictation arrived when the room for those not yet saved was full, and was not kept. */
  overflowed?: boolean
}

// --- Cleanup -------------------------------------------------------------------------

export type OllamaState = 'running' | 'notRunning' | 'notInstalled'

/** Why a model is refused: it would run elsewhere, it is not there, or the address is not this Mac's. */
export type ModelRefusal =
  'remote' | 'blocked' | 'notInstalled' | 'notATextModel' | 'serverNotLocal' | 'redirected'

export interface CleanupModel {
  name: string
  /** Its size on disk, when Ollama says. */
  bytes: number | null
}

/** What the Cleanup page shows about Ollama and its models. */
export interface CleanupFacts {
  identity?: string
  ollama: OllamaState
  /** Where Ollama is looked for, as a host: `127.0.0.1`. */
  host: string
  /** That address is on this Mac. */
  local: boolean
  /** The models that run on this Mac and can write text. */
  models: CleanupModel[]
  /** The model chosen, or null for the rules only. */
  chosen: string | null
  /** Why the chosen model is not used. Null when it is used, or none is chosen. */
  refusal: ModelRefusal | null
  /** A model that does run on this Mac, to offer in place of one that is refused. */
  alternative: string | null
  /** The usual time from releasing the key to the text in Cleaned mode; null before there is one. */
  typicalMs: number | null
}

/** One sentence three ways, with the time each took. */
export interface TryResult {
  identity?: string
  verbatim: { text: string; ms: number }
  rules: { text: string; ms: number }
  /**
   * What the model made of it. `used` is false when a dictation would have fallen back
   * to the rules (`why` says so). Null when there is no model to try.
   */
  cleaned: { text: string; ms: number; model: string; used: boolean; why: string | null } | null
}

// --- Privacy -------------------------------------------------------------------------

/** One address the app has tried to reach since it was started. */
export interface Contact {
  host: string
  /**
   * What for. `other` is the development server the pages come from in a development run.
   * `refused` is an address a page of the app asked for: no page should, and none is let.
   */
  what: 'ollama' | 'speechModel' | 'other' | 'refused'
  /** The address is on this Mac. */
  local: boolean
  /** Something answered there. */
  answered: boolean
}

/** The kinds of thing the app keeps on this Mac. */
export type StoredKind = 'history' | 'recordings' | 'log' | 'counts'

/** A Delete that could not remove everything. */
export interface DeleteProblem {
  failedRows?: number
  failedFiles?: number
  scanFailed?: boolean
  kind: StoredKind
  deleted: number
  failed: number
}

/** The Privacy page's facts, read when they are asked for. */
export interface PrivacyFacts {
  /** The model that turns speech into text, by name. */
  recognizer: string
  contacted: Contact[]
  /** `left`: days' files on disk that are not listed, while the history is held in memory only. */
  history: {
    keep: HistoryKeep
    count: number
    onDisk: boolean
    bytes: number
    left: number
    disk?: HistoryDiskFacts
  }
  /** `scanFailed`: the folder could not be read, so what it holds is not known. */
  recordings: { saving: boolean; count: number; bytes: number; scanFailed?: boolean }
  log: { bytes: number }
  counts: { bytes: number }
  /** What the last Delete left behind, until it is tried again or the page is left. */
  problem: DeleteProblem | null
}
