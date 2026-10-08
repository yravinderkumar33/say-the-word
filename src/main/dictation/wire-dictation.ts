import { BrowserWindow, clipboard, powerMonitor } from 'electron'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  HELPER_PROTOCOL_VERSION,
  type PasteOutcome,
  type PasteResult,
} from '@shared/helper-protocol'
import {
  IPC,
  pillActionSchema,
  type CleanupFacts,
  type DictationMode,
  type ModelKeep,
  type OverlayPrefs,
  type PillAction,
  type PillCue,
  type PillRecovery,
  type PillState,
  type Practice,
  type SpeechState,
  type TryResult,
} from '@shared/ipc'
import { bindingsFor } from '@shared/keycodes'
import { LocalOnlyGate, type LocalVerdict } from '../cleanup/local-only'
import { findOllama, isInstalled } from '../cleanup/ollama-app'
import { OllamaClient, isLoopbackUrl } from '../cleanup/ollama-client'
import { Refiner, type CleanupNote } from '../cleanup/refiner'
import { applyDictionary, applyRules } from '../cleanup/rules'
import { describeHelperEvent, describeTarget, toMachineEvent } from '../hotkeys/route-helper-event'
import { isRecording, type MachineEvent } from '../hotkeys/session-machine'
import { RESTORE_DELAY_MS, type HelperBridge } from '../native/helper-bridge'
import { listenFromOwnPages } from '../security'
import type { SettingsStore } from '../store/settings'
import { modelToUse, modelsRoot } from '../stt/models-dir'
import type { SttHost } from '../stt/stt-host'
import { countWords } from '../text/words'
import { positionOverlay } from '../windows/overlay-window'
import { EvaluationSessions } from './evaluation-sessions'
import { EvaluationRecorder, evaluationDir } from './evaluation-recorder'
import { Pause } from './pause'
import {
  clipboardMessage,
  describeNotice,
  noteMessage,
  pillMessage,
  recordingEndedMessage,
} from './pill-messages'
import { DEFAULT_PRESENTER_OPTIONS, PillPresenter } from './pill-presenter'
import { modeOf, type RecoveryEntry } from './recovery-buffer'
import {
  SessionController,
  type ProducedText,
  type SessionHandle,
  type TargetInfo,
} from './session-controller'
import { SessionMetrics, formatTimings, type SessionTimings } from './session-metrics'
import { MAX_RECORDING_MS, SpeechService } from './speech-service'

/** How often to retry the event tap while waiting for the Accessibility grant. */
const TAP_RETRY_MS = 2_000

/** How long the helper holds the old clipboard after a paste, with room to spare. */
const RESTORE_SETTLE_MS = 2 * RESTORE_DELAY_MS

/** The reasons nobody may be looking at the screen. More than one can hold at once. */
type Away = 'sleep' | 'screen lock' | 'user switch'

/**
 * The time given to a click on the pill. Key events carry the helper's clock, which a
 * click has no reading of, and the rule that a tap right after locking means "never
 * mind" is about taps. A lock started by a click is therefore dated before every key
 * event, so the next press always stops it.
 */
const CLICK_TIME = Number.NEGATIVE_INFINITY

/**
 * A safeguard for automated tests, which post real key events: when set to a bundle id,
 * the app refuses to paste into any other app, so a test can never type into whatever
 * the person at the keyboard happens to be using.
 */
const PASTE_ONLY_INTO = process.env['WHISPER_FLOW_PASTE_ONLY_INTO'] || null

export interface DictationParts {
  helper: HelperBridge
  stt: SttHost
  overlay: BrowserWindow
  settings: SettingsStore
  /** False in tests that drive sessions through the debug control: no key tap is created. */
  shortcuts: boolean
  /** Called when something the tray or the Hub shows may have changed. */
  onStatusChange(): void
  /** Called with everything the pill is made to show: the menu offers the same things. */
  onPillChange?(state: PillState): void
  /** Called once for each dictation that left text. Counts only: never the words. */
  onDictation?(dictation: DictationCount): void
  /** The microphone a dictation is to use, by device id; null for the system default. */
  microphoneId(): string | null
  /**
   * A session's record was made or changed: the history is kept from these.
   * `ownWindow`: it was dictated into one of the app's own windows (a practice, a
   * try-out), which the history leaves out.
   */
  onRecorded?(entry: RecoveryEntry, facts: { ownWindow: boolean }): void
  /** Where a session's time went, once it is over. */
  onTimings?(sessionId: number, timings: SessionTimings): void
  /** A session's text was fetched after all: pasted with the shortcut, or copied. */
  onFetched?(sessionId: number, how: 'pasted' | 'copied'): void
  /** A session failed, with these words on the pill. */
  onFailed?(sessionId: number, message: string): void
  /** Puts text on the clipboard. Handed in so that a test can count it instead. */
  copy?(text: string): void
  /** `fetch` for Ollama and for the model download: the app writes down where each goes. */
  ollamaFetch?: typeof fetch
  downloadFetch?: typeof fetch
}

/** How long the speech model stays in memory after the last dictation. Null: for as long as the app runs. */
const MODEL_KEEP_MS: Record<ModelKeep, number | null> = {
  tenMinutes: 10 * 60_000,
  hour: 60 * 60_000,
  always: null,
}

/** The longest sentence "Try it" takes: it is for a sentence, not for a document. */
const TRY_MAX_CHARS = 600

/** What is counted of a dictation: how many words it had, and how long the text took. */
export interface DictationCount {
  words: number
  mode: DictationMode
  /** From releasing the key to the paste being sent; null when it was not pasted. */
  releaseToPasteMs: number | null
}

/** Hooks for the automated tests. They change nothing unless a test sets them. */
export interface DictationDebug {
  /** Extra time before a session's text is handed on, to hold it in "processing". */
  textDelayMs: number
  /** A shorter recording limit, so a test can reach it. */
  maxRecordingMs: number | null
  /** Stands in for reading the paste destination from the frontmost app. */
  target: (() => TargetInfo) | null
  /** Stands in for the paste itself, so a test never types into the app in front. */
  paste: ((session: number | null, text: string) => PasteOutcome) | null
  /** Makes the next decode fail with the recording kept, so Retry can be tested. */
  failNextTranscript: boolean
  /** Stands in for "one of the app's own windows has the keyboard": a test's windows never do. */
  ownWindow: boolean | null
}

export interface Dictation {
  controller: SessionController
  privacyBlocked(): boolean
  privacyGeneration(): number
  discardAll(): Promise<number>
  resumeAfterDiscard(): void
  stopEvaluation(): Promise<number>
  speech: SpeechService
  /** True once the key event tap exists, which is when shortcuts start working. */
  shortcutsActive(): boolean
  /**
   * What Cleaned mode will do right now: one line for the tray (empty in Verbatim
   * mode), and the local models it could use.
   */
  cleanupStatus(): Promise<{ line: string; models: string[] }>
  /**
   * Says something on the pill, with the sound that goes with "what you asked for did
   * not happen". For things outside a dictation, such as a setting that would not save.
   */
  tell(message: string): void
  /** Does what the pill's button of that name does. */
  act(action: PillAction): void
  /** A shortcut was pressed. While dictation is paused, one that would start something is ignored. */
  shortcut(event: MachineEvent): void
  /** "Pause dictation": every shortcut is off until it ends. */
  pause: Pause
  /** How often each way of dictating has ended in a paste since launch. */
  practice(): Practice
  /** Ollama's state and the models that run on this Mac, for the Cleanup page. */
  cleanupFacts(): Promise<CleanupFacts>
  /** One sentence as Verbatim, with the rules only, and Cleaned, with the time each took. */
  tryCleanup(text: string): Promise<TryResult>
  /**
   * Says "Copied" on the pill, for a copy made from the window or the menu. `session` is
   * the session the text came from, when it is one of this launch: if it is the text
   * that paste-last would fetch, the mark for unpasted text goes with the copy.
   */
  copied(session: number | null): void
  /**
   * A setting the pipeline acts on has changed: the dictation key, the sounds, the
   * pill at rest, or how long the model stays in memory.
   */
  settingsChanged(): void
  debug: DictationDebug
}

/** Why a model's text was not used for a sentence that was tried, in the page's words. */
function whyNotUsed(note: CleanupNote): string {
  if (note === 'short') return 'Too short to need the model'
  if (note === 'tooLong') return 'Too long to tidy in time'
  if (note === 'timeout') return 'Too slow to use'
  if (note.startsWith('guard:')) return 'It changed more than Cleaned allows'
  if (note.startsWith('notLocal:')) return 'The model does not run on this Mac'
  return 'The model did not answer'
}

/** Why Cleaned mode is using the rules only, in the tray's words. */
const CLEANUP_PROBLEMS: Record<Exclude<LocalVerdict, { local: true }>['reason'], string> = {
  remote: 'the chosen model does not run on this Mac',
  blocked: 'the chosen model answered from another machine',
  notInstalled: 'the chosen model is not installed',
  notATextModel: 'the chosen model cannot write text',
  serverNotLocal: 'the Ollama address is not on this Mac',
  redirected: 'the Ollama address sends requests elsewhere',
  unreachable: 'Ollama is not running',
}

/** Connects the helper's shortcut events, the microphone, the recognizer and the pill. */
export function wireDictation(parts: DictationParts): Dictation {
  const { helper, stt, overlay, settings, shortcuts, onStatusChange } = parts
  /** Sessions whose words have been counted. */
  const counted = new Set<number>()
  const debug: DictationDebug = {
    textDelayMs: 0,
    maxRecordingMs: null,
    target: null,
    paste: null,
    failNextTranscript: false,
    ownWindow: null,
  }
  /** True when the keyboard is in one of the app's own windows: a practice, or a sentence being tried. */
  const inOwnWindow = (): boolean => debug.ownWindow ?? BrowserWindow.getFocusedWindow() !== null
  /** How long a recording may run. A test may set a shorter limit, so that it can reach it. */
  const recordingLimitMs = (): number => debug.maxRecordingMs ?? MAX_RECORDING_MS
  const metrics = new SessionMetrics()
  let tapInstalled = false
  /** The newest session begun: Delete Everything takes every session up to it (ids only grow). */
  let lastSession: number | null = null
  const away = new Set<Away>()
  /** A message about a session that ended while the user was away, shown on their return. */
  let heldForReturn: PillRecovery | null = null
  /** Sessions that were locked on (hands-free), brought back with Undo, or dictated into our own window. */
  const handsFree = new Set<number>()
  const undone = new Set<number>()
  const ownWindow = new Set<number>()
  const practised: Practice = { hold: 0, handsFree: 0, undo: 0 }
  /** What the pill last offered, so that pressing it is known for an Undo or a Retry. */
  let offered: 'Undo' | 'Retry' | null = null
  /** Forgets what was noted about sessions long over. */
  const forgetOld = (session: number): void => {
    for (const noted of [handsFree, undone, ownWindow]) {
      for (const id of noted) if (id < session - 8) noted.delete(id)
    }
  }

  const toOverlay = (channel: string, payload: PillState | PillCue | OverlayPrefs): void => {
    if (!overlay.isDestroyed()) overlay.webContents.send(channel, payload)
  }
  const presenter = new PillPresenter(
    (state) => {
      offered = state.kind === 'recovery' ? (state.redo ?? null) : null
      toOverlay(IPC.pillState, state)
      parts.onPillChange?.(state)
    },
    {
      ...DEFAULT_PRESENTER_OPTIONS,
      // The Undo or Retry button went with the message: the recording is let go.
      onRecoveryGone: () => controller.forgetRedo(),
    },
  )
  const evaluation = new EvaluationRecorder(evaluationDir())
  const evaluationSessions = new EvaluationSessions(evaluation, stt)
  let purgedThrough = 0

  // Every shortcut is off while dictation is paused: the table the helper is given is empty.
  const sendBindings = (): void =>
    helper.setBindings(pause.active ? [] : bindingsFor(settings.get().dictationKey))
  const pushPrefs = (): void => {
    const { sounds, soundVolume, pillAtRest, dictationKey } = settings.get()
    toOverlay(IPC.overlayPrefs, {
      sounds,
      volume: soundVolume,
      pillAtRest,
      key: dictationKey,
      pausedUntil: pause.until,
    })
  }
  const pause: Pause = new Pause({
    now: () => Date.now(),
    onChange: (until) => {
      console.log(`[dictation] ${until === null ? 'resumed' : 'paused'}`)
      // A dictation under way cannot be finished without its shortcuts: its text is kept.
      if (until !== null && controller.stateName !== 'idle') controller.dispatch({ type: 'abort' })
      sendBindings()
      pushPrefs()
      onStatusChange()
    },
  })

  // Cleaned mode. The address is read from the settings each time it is used.
  const ollama = new OllamaClient(settings.get().ollamaUrl, parts.ollamaFetch)
  const gate = new LocalOnlyGate(
    ollama,
    () => Date.now(),
    () => settings.get().allowRemoteOllama,
  )
  const refiner = new Refiner({
    client: ollama,
    gate,
    model: () => settings.get().cleanupModel,
    dictionary: () => settings.get().dictionary,
  })

  /** Turns what was heard into what is pasted, according to the mode. */
  async function shape(raw: string, session: SessionHandle): Promise<ProducedText> {
    const { mode, dictionary, ollamaUrl } = settings.get()
    if (mode === 'verbatim') return { raw, final: applyDictionary(raw, dictionary) }
    ollama.setBaseUrl(ollamaUrl)
    const refined = await refiner.refine(raw, session.signal)
    metrics.cleaned(session.id, refined.note, refined.cleanupMs)
    // Ollama may have started or stopped since the tray last looked.
    onStatusChange()
    return {
      raw,
      rules: refined.rules,
      cleaned: refined.cleaned,
      final: refined.final,
      note: refined.note,
    }
  }

  async function cleanupStatus(): Promise<{ line: string; models: string[] }> {
    const { mode, cleanupModel, ollamaUrl } = settings.get()
    if (mode !== 'cleaned') return { line: '', models: [] }
    ollama.setBaseUrl(ollamaUrl)
    const models = await gate.localTextModels().then(
      (found) => found.map((model) => model.name),
      () => [],
    )
    if (!cleanupModel) return { line: 'Cleaned: rules only (no model chosen)', models }
    const verdict = await gate.check(cleanupModel)
    const line = verdict.local
      ? `Cleaned with ${cleanupModel}`
      : `Cleaned: rules only (${CLEANUP_PROBLEMS[verdict.reason]})`
    return { line, models }
  }

  async function cleanupFacts(): Promise<CleanupFacts & { identity: string }> {
    const { cleanupModel, ollamaUrl } = settings.get()
    ollama.setBaseUrl(ollamaUrl)
    const local = isLoopbackUrl(ollamaUrl)
    let host = ollamaUrl
    try {
      host = new URL(ollamaUrl).hostname.replace(/^\[|\]$/g, '')
    } catch {
      // Shown as it was typed.
    }
    // Only an address on this Mac is asked anything, unless the user allowed another.
    const reachable = local || settings.get().allowRemoteOllama
    const running = reachable && (await ollama.version()) !== null
    const models = running
      ? await gate.localTextModels().then(
          (found) => found.map((model) => ({ name: model.name, bytes: model.bytes })),
          () => [],
        )
      : []
    const verdict = running && cleanupModel ? await gate.check(cleanupModel) : null
    // Ollama not answering is said by the line about Ollama, not as a fault of the model.
    const refusal =
      verdict && !verdict.local && verdict.reason !== 'unreachable' ? verdict.reason : null
    return {
      identity: JSON.stringify([
        ollamaUrl,
        cleanupModel,
        verdict?.local ? verdict.identity.digest : null,
        running,
        refusal,
      ]),
      ollama: running ? 'running' : isInstalled(findOllama()) ? 'notRunning' : 'notInstalled',
      host,
      local,
      models,
      chosen: cleanupModel,
      refusal,
      alternative: refusal
        ? (models.find((model) => model.name !== cleanupModel)?.name ?? null)
        : null,
      typicalMs: null,
    }
  }

  /** Only the latest sentence tried is worth an answer: an older one still on its way is dropped. */
  let trying: AbortController | null = null
  async function tryCleanup(text: string): Promise<TryResult> {
    if (controller.privacyBlocked)
      return { verbatim: { text: '', ms: 0 }, rules: { text: '', ms: 0 }, cleaned: null }
    trying?.abort()
    const mine = new AbortController()
    trying = mine
    const { dictionary, cleanupModel, ollamaUrl } = settings.get()
    const sentence = text.trim().slice(0, TRY_MAX_CHARS)
    const timed = <Value>(run: () => Value): { value: Value; ms: number } => {
      const started = performance.now()
      const value = run()
      return { value, ms: performance.now() - started }
    }
    const verbatim = timed(() => applyDictionary(sentence, dictionary))
    const rules = timed(() => applyRules(sentence, dictionary))
    const facts = await cleanupFacts()
    const result: TryResult = {
      identity: facts.identity,
      verbatim: { text: verbatim.value, ms: verbatim.ms },
      rules: { text: rules.value, ms: rules.ms },
      cleaned: null,
    }
    if (!cleanupModel || sentence.length === 0) return result

    ollama.setBaseUrl(ollamaUrl)
    const refined = await refiner.refine(sentence, mine.signal, { patient: true })
    // Nothing answered at the address: there is no model to show a result for.
    if (refined.note === 'unreachable' || refined.note === 'notLocal:unreachable') return result
    if (refined.note === 'noModel' || refined.note === 'cancelled') return result
    const used =
      refined.note === 'cleaned' &&
      !refined.tooLongForDictation &&
      refined.cleanupMs <= refined.allowedMs
    result.cleaned = {
      text: refined.cleaned ?? '',
      ms: refined.cleanupMs,
      model: cleanupModel,
      used,
      // A dictation this long would not have asked the model at all. A text that came,
      // and came too late for a dictation, is said to be too slow.
      why: used
        ? null
        : refined.tooLongForDictation
          ? whyNotUsed('tooLong')
          : refined.note === 'cleaned'
            ? 'Too slow to use'
            : whyNotUsed(refined.note),
    }
    return result
  }

  const speech = new SpeechService({
    stt,
    overlay,
    modelsRoot: modelsRoot(),
    model: modelToUse(),
    microphoneId: () => parts.microphoneId(),
    idleUnloadMs: () => MODEL_KEEP_MS[settings.get().modelKeep],
    ...(parts.downloadFetch ? { fetchImpl: parts.downloadFetch } : {}),
    maxRecordingMs: recordingLimitMs,
    evaluation: (session) => evaluationSessions.forSession(session),
    failNextTranscript: () => {
      const fail = debug.failNextTranscript
      debug.failNextTranscript = false
      return fail
    },
    onLive: (session, openMs) => {
      if (controller.currentSessionId !== session) return
      metrics.live(session, Date.now(), openMs)
      presenter.setLive()
    },
    onRecordingFailed: (session, message) => controller.failRecording(session, message),
    onRecordingEnded: (session, reason) => {
      if (controller.currentSessionId !== session || !isRecording(controller.stateName)) return
      console.log(`[dictation] recording ended by itself (session ${session}): ${reason}`)
      // What was captured is handled like a normal stop; the message says why it stopped.
      controller.endRecording(session)
      presenter.showRecovery(recordingEndedMessage(reason))
    },
    onLimitSoon: (session) => {
      if (controller.currentSessionId === session) toOverlay(IPC.pillCue, 'limitSoon')
    },
    onTranscript: (session, result) => {
      if (session <= purgedThrough) return
      // Marks where recognition ends and cleanup begins, for a session that seems stuck.
      console.log(`[speech] heard (session ${session})`)
      metrics.decoded(session, result)
    },
    onStateChange: (state: SpeechState) => {
      console.log(`[speech] ${state}`)
      presenter.setModelLoading(state === 'loading')
      onStatusChange()
    },
  })

  const controller: SessionController = new SessionController({
    startRecording: (session) => {
      lastSession = session.id
      forgetOld(session.id)
      // A sentence being tried on the Cleanup page gives way: the dictation has the model.
      trying?.abort()
      // Whoever starts a dictation is at the Mac, whatever was last heard about sleep
      // or the lock screen; a message kept for their return has been overtaken.
      away.clear()
      heldForReturn = null
      const startedAt = Date.now()
      metrics.started(session.id, startedAt)
      presenter.setRecording({ startedAt, limitAt: startedAt + recordingLimitMs() })
      if (inOwnWindow()) ownWindow.add(session.id)
      evaluationSessions.begin(
        session.id,
        settings.get().evaluationRecording,
        ownWindow.has(session.id),
      )
      speech.startRecording(session)
      // The model is loaded while the user is still speaking.
      if (settings.get().mode === 'cleaned') {
        ollama.setBaseUrl(settings.get().ollamaUrl)
        refiner.prewarm()
      }
    },
    produceText: async (session) => {
      metrics.released(session.id, Date.now())
      presenter.setTidying(settings.get().mode === 'cleaned')
      const heard = await speech.produceText(session)
      // Waits, but no longer than the session lives.
      if (debug.textDelayMs > 0) {
        await sleep(debug.textDelayMs, undefined, { signal: session.signal }).catch(() => {})
      }
      if (session.id <= purgedThrough) return null
      const produced = heard ? await shape(heard.raw, session) : null
      if (session.id <= purgedThrough) return null
      metrics.textReady(session.id, Date.now())
      return produced
    },
    reproduceText: async (session) => {
      presenter.setTidying(settings.get().mode === 'cleaned')
      const heard = await speech.reproduceText(session)
      return heard ? shape(heard.raw, session) : null
    },
    forgetRecording: (sessionId) => {
      // Saved, if it is, before the speech process is told to let the recording go:
      // it handles the two in the order they are sent.
      void evaluationSessions.release(sessionId)
      speech.forget(sessionId)
    },
    captureTarget: async (session) => {
      // One of the app's own windows has the keyboard: a practice, or a sentence being
      // tried. It is dictated into like any other app, and left out of the history and of
      // the saved recordings. Where the keyboard was when the recording began counts as
      // well (see `startRecording`): a dictation begun in a practice stays a practice.
      // Paste-last reads a destination for no session.
      if (session !== null && inOwnWindow()) {
        ownWindow.add(session)
        void evaluationSessions.exclude(session)
      }
      if (debug.target) return debug.target()
      const target = await helper.captureTarget()
      console.log(describeTarget(target))
      if (PASTE_ONLY_INTO && target.bundleId !== PASTE_ONLY_INTO) {
        // An id the helper never issued: any paste with it is refused as "target changed".
        return { targetId: -1, secure: target.secure }
      }
      return target
    },
    paste: async ({ text, targetId, sessionId: session }) => {
      const generation = controller.privacyGeneration
      // Paste-last pastes for no session; only a session's own paste is timed.
      if (session !== null) metrics.pasteSent(session, Date.now())
      const result = debug.paste
        ? { outcome: debug.paste(session, text) }
        : await realPaste({ text, targetId })
      if (generation !== controller.privacyGeneration) return result
      if (session !== null) metrics.pasteDone(session, Date.now())
      // Whatever text was waiting to be fetched has now been pasted, or is older than this.
      if (result.outcome === 'pasted') presenter.textTaken()
      if (result.outcome === 'pasted' && session !== null) {
        // Which way of dictating this was, for the exercises of the first run.
        if (undone.has(session)) practised.undo += 1
        else if (handsFree.has(session)) practised.handsFree += 1
        else practised.hold += 1
      }
      return result
    },
    onRecorded: (entry) => {
      if (entry.sessionId <= purgedThrough) return
      evaluationSessions.note(entry)
      parts.onRecorded?.(entry, { ownWindow: ownWindow.has(entry.sessionId) })
    },
    // Once its record says how it ended: the timings then land on its row in the history.
    onSessionOver: (sessionId) => {
      if (sessionId > purgedThrough) logTimings(sessionId)
    },
    onFetched: (sessionId, how) => parts.onFetched?.(sessionId, how),
    armEscape: (armed) => {
      // If the helper is down there is no session to cancel anyway.
      helper.armEscape(armed).catch(() => {})
    },
    writeClipboard: async (text) => {
      if (parts.copy) parts.copy(text)
      else {
        await clipboard
          .writeText(text)
          .catch(() => console.error('[app] the clipboard could not be written'))
      }
    },
    notify: (notice) => {
      console.log(`[dictation] ${describeNotice(notice)}`)
      if (notice.kind === 'stillProcessing') {
        toOverlay(IPC.pillCue, 'busy')
        return
      }
      const pill = pillMessage(notice, (sessionId) => controller.hasText(sessionId))
      if (!pill) return
      if (notice.kind === 'copied') presenter.textTaken()
      if (notice.kind === 'failed') parts.onFailed?.(notice.sessionId, pill.message)
      // A session ended by sleep or the lock screen reports its text a moment later,
      // to a screen nobody can see, and a message lasts six seconds. It is kept for
      // when they are back.
      if (notice.kind === 'interrupted' && away.size > 0) heldForReturn = pill
      else presenter.showRecovery(pill)
    },
    onStateChange: (state, sessionId) => {
      console.log(`[state] ${state}${sessionId === null ? '' : ` (session ${sessionId})`}`)
      // The pill follows the display the pointer is on.
      if (state === 'holding' || state === 'locked') positionOverlay(overlay)
      // Noted as the recording begins, and not only when the destination is read: a
      // practice that is cancelled or interrupted while the key is held never gets that
      // far, and "Nothing here is kept" is said of it too.
      if ((state === 'holding' || state === 'locked') && sessionId !== null && inOwnWindow()) {
        ownWindow.add(sessionId)
      }
      if (state === 'locked' && sessionId !== null) handsFree.add(sessionId)
      presenter.setGesture(state)
      // Not at once: the helper is still holding the clipboard of the paste just made,
      // and one that is closed puts it back early, before the app in front has read it.
      if (state === 'idle' && refreshWhenIdle) setTimeout(refreshHelper, RESTORE_SETTLE_MS)
    },
    now: () => Date.now(),
  })

  async function realPaste(request: { text: string; targetId: number }): Promise<PasteResult> {
    const result = await helper.paste(request)
    const { outcome, detail } = result
    // Why a paste was refused (which part of the destination moved, which permission
    // check said no): what is needed to tell one rightly refused from one refused by
    // mistake.
    const why =
      outcome === 'targetChanged' && request.targetId === -1 && PASTE_ONLY_INTO
        ? 'not the app this test may paste into'
        : detail
    console.log(`[paste] ${outcome}${why ? ` (${why})` : ''}`)
    return result
  }

  /**
   * One line per session, for the latency gates, and its words counted. Numbers only,
   * never text.
   */
  function logTimings(session: number): void {
    const entry = controller.recovery.list().find((item) => item.sessionId === session)
    const timings = metrics.finish(session, entry?.outcome ?? 'none')
    if (timings) {
      console.log(formatTimings(timings))
      parts.onTimings?.(session, timings)
    }
    count(session, entry?.outcome === 'pasted' ? (timings?.releaseToPasteMs ?? null) : null)
  }

  /**
   * Counts the words of a dictation that left text, once: Undo and Retry run a session
   * a second time.
   */
  function count(session: number, releaseToPasteMs: number | null): void {
    // A practice in the app's own windows is not dictating: it counts for nothing.
    if (ownWindow.has(session)) return
    const entry = controller.recovery.list().find((item) => item.sessionId === session)
    if (!entry?.finalText || counted.has(session)) return
    counted.add(session)
    for (const id of counted) if (id < session - 8) counted.delete(id)
    parts.onDictation?.({
      words: countWords(entry.finalText),
      mode: modeOf(entry, settings.get().mode),
      releaseToPasteMs,
    })
  }

  // --- The pill's buttons -----------------------------------------------------------

  /**
   * What the pill's buttons do. The menu-bar menu offers the same things, for hands
   * that are on the keyboard: the pill itself can only be reached with the pointer.
   */
  function act(action: PillAction): void {
    console.log(`[pill] ${action}`)
    switch (action) {
      case 'copy':
        return controller.dispatch({ type: 'copyLast' })
      case 'cancel':
        return controller.dispatch({ type: 'escape' })
      case 'start':
        // A click on the resting pill starts a hands-free recording. A click that
        // arrives while a session is running came from a pill that was out of date.
        if (controller.stateName !== 'idle' || pause.active) return
        return controller.dispatch({ type: 'handsFreeDown', t: CLICK_TIME })
      case 'stop':
        return controller.dispatch({ type: 'stop' })
      case 'redo': {
        // The message that offered it has done its job. Dismissed after the redo has
        // begun, because dismissing a message also withdraws its offer.
        const wasUndo = offered === 'Undo'
        controller.redo()
        const session = controller.currentSessionId
        if (wasUndo && session !== null) undone.add(session)
        return presenter.dismissRecovery()
      }
      case 'dismiss':
        return presenter.dismissRecovery()
    }
  }

  listenFromOwnPages(IPC.pillAction, (payload) => {
    const action = pillActionSchema.safeParse(payload)
    if (action.success) act(action.data)
  })

  // A message does not leave from under the pointer: the page says when it is over the pill.
  listenFromOwnPages(IPC.overlayInteractive, (payload) =>
    presenter.setPointerOver(payload === true),
  )
  // A page that has just loaded, or has gone, has no pointer over anything. One that
  // has just loaded knows none of the settings it acts on either.
  overlay.webContents.on('did-finish-load', () => {
    presenter.setPointerOver(false)
    pushPrefs()
  })
  overlay.webContents.on('render-process-gone', () => presenter.setPointerOver(false))

  // --- The helper -------------------------------------------------------------------

  sendBindings()

  /** The presses that start something. While dictation is paused they do nothing. */
  const STARTS = new Set<MachineEvent['type']>([
    'pttDown',
    'handsFreeDown',
    'pasteLast',
    'copyLast',
  ])
  const shortcut = (event: MachineEvent): void => {
    if (pause.active && STARTS.has(event.type)) return
    controller.dispatch(event)
  }

  helper.on('event', (event) => {
    console.log(describeHelperEvent(event))
    if (event.type === 'tapState') {
      setTapInstalled(event.installed)
      if (!event.installed) onTapLost()
    }
    if (event.type === 'pasteSettled' && !event.restored) {
      // The paste went through and took the clipboard with it. Said only when the pill
      // has nothing else to say: a new dictation, or a message about one, comes first.
      const lost = clipboardMessage(event.reason)
      if (lost && controller.stateName === 'idle' && !presenter.showsRecovery) {
        presenter.showRecovery(lost)
      }
    }
    const machineEvent = toMachineEvent(event)
    if (machineEvent) shortcut(machineEvent)
  })

  /**
   * The helper took its key tap down, which it does when Accessibility is withdrawn.
   * No key release will be reported now, so a session in progress ends (its text is
   * kept), and the wait for the permission starts again. When it comes back the helper
   * is replaced once more, as after the first grant.
   */
  function onTapLost(): void {
    controller.dispatch({ type: 'abort' })
    helperRefreshed = false
    if (shortcuts) ensureTap()
  }

  // Without the helper nobody would report the key release, so an active session ends
  // here: what was said is kept for recovery, and never pasted.
  helper.on('exit', (code) => {
    console.log(`[helper] exited (code ${code ?? 'none'})`)
    setTapInstalled(false)
    controller.dispatch({ type: 'abort' })
  })

  helper.on('ready', (ready) => {
    console.log(
      `[helper] ready: accessibility=${ready.accessibilityTrusted} keyTap=${ready.tapInstalled}`,
    )
    if (ready.protocol !== HELPER_PROTOCOL_VERSION) {
      // A helper from another build: its messages may not be understood, and are then dropped.
      console.error(
        `[helper] it speaks protocol ${ready.protocol} and this app speaks ${HELPER_PROTOCOL_VERSION}: ` +
          'shortcuts and pasting may not work',
      )
    }
    setTapInstalled(ready.tapInstalled)
    if (!ready.tapInstalled && shortcuts) ensureTap()
  })

  // macOS answers some permission questions once per process and remembers the answer.
  // A helper that was running before Accessibility was granted may hold a remembered
  // "no", so it is replaced by a fresh one as soon as the grant shows. Once is enough,
  // and never under a session, which the replacement would end.
  let helperRefreshed = false
  let refreshWhenIdle = false
  function refreshHelper(): void {
    if (helperRefreshed || tapInstalled === false) return
    if (controller.stateName !== 'idle') {
      refreshWhenIdle = true
      return
    }
    helperRefreshed = true
    refreshWhenIdle = false
    console.log('[helper] Accessibility was granted while it was running: starting a fresh one')
    helper.restart()
  }

  function setTapInstalled(installed: boolean): void {
    if (tapInstalled === installed) return
    tapInstalled = installed
    if (installed) console.log('[dictation] shortcuts active')
    onStatusChange()
  }

  /**
   * The tap can only be created once Accessibility is granted, and the grant can arrive
   * at any moment, so keep asking until it works. A newer wait ends an older one.
   */
  let tapWait = 0
  function ensureTap(): void {
    const wait = ++tapWait
    let attempts = 0
    const ask = (): void => {
      if (wait !== tapWait) return
      helper.installTap().then(
        (result) => {
          if (wait !== tapWait) return
          if (result.tapInstalled) {
            setTapInstalled(true)
            refreshHelper()
            return
          }
          if (attempts++ === 0) console.log('[dictation] waiting for the Accessibility permission')
          setTimeout(ask, TAP_RETRY_MS)
        },
        () => {
          // No answer. A helper that has exited starts a new wait when it is back; one
          // that was only slow to answer is asked again.
          if (wait === tapWait && helper.running) setTimeout(ask, TAP_RETRY_MS)
        },
      )
    }
    ask()
  }

  // --- Sleep, lock, user switch -----------------------------------------------------

  // A session cannot outlive any of these: the key release would never be seen.
  const leave = (reason: Away) => (): void => {
    if (controller.stateName !== 'idle') console.log(`[dictation] interrupted by ${reason}`)
    away.add(reason)
    controller.dispatch({ type: 'abort' })
  }
  powerMonitor.on('suspend', leave('sleep'))
  powerMonitor.on('lock-screen', leave('screen lock'))
  powerMonitor.on('user-did-resign-active', leave('user switch'))

  // Keys released while the Mac was away were never seen. Sending the shortcut table
  // again clears the helper's idea of which keys are down, so none is stuck. And what
  // there was to say about a session that ended while nobody was looking is said now.
  const comeBack = (reason: Away) => (): void => {
    away.delete(reason)
    // A pause whose time ran out while the Mac slept ends now.
    pause.recheck()
    sendBindings()
    if (away.size > 0 || !heldForReturn) return
    presenter.showRecovery(heldForReturn)
    heldForReturn = null
  }
  powerMonitor.on('resume', comeBack('sleep'))
  powerMonitor.on('unlock-screen', comeBack('screen lock'))
  powerMonitor.on('user-did-become-active', comeBack('user switch'))

  const tell = (message: string): void => {
    console.log(`[app] ${message}`)
    presenter.showRecovery(noteMessage(message))
  }

  let keyInForce = settings.get().dictationKey
  const settingsChanged = (): void => {
    if (settings.get().dictationKey !== keyInForce) {
      keyInForce = settings.get().dictationKey
      sendBindings()
    }
    trying?.abort()
    pushPrefs()
    speech.keepLoaded()
  }

  return {
    controller,
    privacyBlocked: () => controller.privacyBlocked,
    privacyGeneration: () => controller.privacyGeneration,
    stopEvaluation: () => evaluationSessions.stop(),
    discardAll: async () => {
      // Every session begun so far, also one that is neither current nor recorded yet: an
      // interrupted session whose text is still being worked out.
      purgedThrough = Math.max(
        purgedThrough,
        ...controller.recovery.list().map((entry) => entry.sessionId),
        controller.currentSessionId ?? 0,
        lastSession ?? 0,
      )
      // A result still on its way for one of these sessions is not kept when it arrives.
      stt.discardThrough(purgedThrough)
      trying?.abort()
      heldForReturn = null
      // Every saving is called off first, at once: letting the recordings go below would
      // otherwise save the sessions that have just ended.
      const purging = evaluationSessions.purge()
      const discard = controller.discardAll()
      presenter.reset()
      const failed = await purging
      await discard
      presenter.reset()
      return failed
    },
    resumeAfterDiscard: () => controller.resumeAfterDiscard(),
    speech,
    shortcutsActive: () => tapInstalled,
    cleanupStatus,
    tell,
    act,
    shortcut,
    pause,
    practice: () => ({ ...practised }),
    cleanupFacts,
    tryCleanup,
    copied: (session) => {
      // The text the mark stands for has been fetched this way: the mark goes, as it
      // does for a copy made with the shortcut. A copy of an older dictation leaves it.
      if (session !== null && controller.lastTextSession === session) presenter.textTaken()
      const pill = pillMessage({ kind: 'copied' }, () => false)
      if (pill) presenter.showRecovery(pill)
    },
    settingsChanged,
    debug,
  }
}
