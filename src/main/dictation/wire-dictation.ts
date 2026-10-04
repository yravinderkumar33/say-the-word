import { clipboard, powerMonitor, type BrowserWindow } from 'electron'
import { HELPER_PROTOCOL_VERSION } from '@shared/helper-protocol'
import {
  IPC,
  pillActionSchema,
  type PillCue,
  type PillRecovery,
  type PillState,
  type SpeechState,
} from '@shared/ipc'
import { DEFAULT_BINDINGS } from '@shared/keycodes'
import { LocalOnlyGate, type LocalVerdict } from '../cleanup/local-only'
import { OllamaClient } from '../cleanup/ollama-client'
import { Refiner } from '../cleanup/refiner'
import { applyDictionary } from '../cleanup/rules'
import { describeHelperEvent, describeTarget, toMachineEvent } from '../hotkeys/route-helper-event'
import { isRecording } from '../hotkeys/session-machine'
import type { HelperBridge } from '../native/helper-bridge'
import { listenFromOwnPages } from '../security'
import type { SettingsStore } from '../store/settings'
import { modelToUse, modelsRoot } from '../stt/models-dir'
import type { SttHost } from '../stt/stt-host'
import { positionOverlay } from '../windows/overlay-window'
import { EvaluationRecorder, evaluationDir } from './evaluation-recorder'
import { clipboardMessage, describeNotice, pillMessage } from './pill-messages'
import { DEFAULT_PRESENTER_OPTIONS, PillPresenter } from './pill-presenter'
import {
  SessionController,
  type PasteOutcome,
  type ProducedText,
  type SessionHandle,
  type TargetInfo,
} from './session-controller'
import { SessionMetrics, formatTimings } from './session-metrics'
import { MAX_RECORDING_MS, SpeechService } from './speech-service'

/** How often to retry the event tap while waiting for the Accessibility grant. */
const TAP_RETRY_MS = 2_000

/** How long the helper holds the old clipboard after a paste, with room to spare. */
const RESTORE_SETTLE_MS = 1_000

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
}

export interface Dictation {
  controller: SessionController
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
  debug: DictationDebug
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
  const debug: DictationDebug = {
    textDelayMs: 0,
    maxRecordingMs: null,
    target: null,
    paste: null,
    failNextTranscript: false,
  }
  const metrics = new SessionMetrics()
  let tapInstalled = false
  let lastSession: number | null = null
  const away = new Set<Away>()
  /** A message about a session that ended while the user was away, shown on their return. */
  let heldForReturn: PillRecovery | null = null

  const toOverlay = (channel: string, payload: PillState | PillCue): void => {
    if (!overlay.isDestroyed()) overlay.webContents.send(channel, payload)
  }
  const presenter = new PillPresenter((state) => toOverlay(IPC.pillState, state), {
    ...DEFAULT_PRESENTER_OPTIONS,
    // The Undo or Retry button went with the message: the recording is let go.
    onRecoveryGone: () => controller.forgetRedo(),
  })
  const evaluation = new EvaluationRecorder(evaluationDir())

  // Cleaned mode. The address is read from the settings each time it is used.
  const ollama = new OllamaClient(settings.get().ollamaUrl)
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

  const speech = new SpeechService({
    stt,
    overlay,
    modelsRoot: modelsRoot(),
    model: modelToUse(),
    microphoneId: () => settings.get().microphoneId,
    maxRecordingMs: () => debug.maxRecordingMs ?? MAX_RECORDING_MS,
    evaluation: () => (settings.get().evaluationRecording ? evaluation : null),
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
      presenter.showRecovery({
        message:
          reason === 'limit' ? 'Stopped at the 20-minute limit' : 'The microphone disconnected',
        canCopy: false,
        sound: true,
      })
    },
    onLimitSoon: (session) => {
      if (controller.currentSessionId === session) toOverlay(IPC.pillCue, 'limitSoon')
    },
    onTranscript: (session, result) => {
      // Marks where recognition ends and cleanup begins, for a session that seems stuck.
      console.log(`[speech] heard (session ${session})`)
      metrics.decoded(session, result)
    },
    onStateChange: (state: SpeechState) => {
      console.log(`[speech] ${state}`)
      onStatusChange()
    },
  })

  const controller: SessionController = new SessionController({
    startRecording: (session) => {
      lastSession = session.id
      // Whoever starts a dictation is at the Mac, whatever was last heard about sleep
      // or the lock screen; a message kept for their return has been overtaken.
      away.clear()
      heldForReturn = null
      metrics.started(session.id, Date.now())
      speech.startRecording(session)
      // The model is loaded while the user is still speaking.
      if (settings.get().mode === 'cleaned') {
        ollama.setBaseUrl(settings.get().ollamaUrl)
        refiner.prewarm()
      }
    },
    produceText: async (session) => {
      metrics.released(session.id, Date.now())
      const heard = await speech.produceText(session)
      if (debug.textDelayMs > 0) await wait(debug.textDelayMs, session.signal)
      const produced = heard ? await shape(heard.raw, session) : null
      metrics.textReady(session.id, Date.now())
      return produced
    },
    reproduceText: async (session) => {
      const heard = await speech.reproduceText(session)
      return heard ? shape(heard.raw, session) : null
    },
    forgetRecording: (sessionId) => speech.forget(sessionId),
    captureTarget: async () => {
      if (debug.target) return debug.target()
      const target = await helper.captureTarget()
      console.log(describeTarget(target))
      if (PASTE_ONLY_INTO && target.bundleId !== PASTE_ONLY_INTO) {
        // An id the helper never issued: any paste with it is refused as "target changed".
        return { targetId: -1, secure: target.secure }
      }
      return target
    },
    paste: async (request) => {
      // Paste-last runs with no session; only a session's own paste is timed.
      const session = controller.currentSessionId
      if (session !== null) metrics.pasteSent(session, Date.now())
      const outcome = debug.paste ? debug.paste(session, request.text) : await realPaste(request)
      if (session !== null) metrics.pasteDone(session, Date.now())
      return outcome
    },
    armEscape: (armed) => {
      // If the helper is down there is no session to cancel anyway.
      helper.armEscape(armed).catch(() => {})
    },
    writeClipboard: (text) => {
      clipboard.writeText(text)
      return Promise.resolve()
    },
    notify: (notice) => {
      console.log(`[dictation] ${describeNotice(notice)}`)
      if (notice.kind === 'stillProcessing') {
        toOverlay(IPC.pillCue, 'busy')
        return
      }
      const pill = pillMessage(notice, (sessionId) => controller.hasText(sessionId))
      if (!pill) return
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
      presenter.setGesture(state)
      if (state === 'idle' && lastSession !== null) logTimings(lastSession)
      // Not at once: the helper is still holding the clipboard of the paste just made,
      // and one that is closed puts it back early, before the app in front has read it.
      if (state === 'idle' && refreshWhenIdle) setTimeout(refreshHelper, RESTORE_SETTLE_MS)
    },
    now: () => Date.now(),
  })

  async function realPaste(request: { text: string; targetId: number }): Promise<PasteOutcome> {
    const { outcome, detail } = await helper.paste(request)
    // Why a paste was refused (which part of the destination moved, which permission
    // check said no): what is needed to tell one rightly refused from one refused by
    // mistake.
    const why =
      outcome === 'targetChanged' && request.targetId === -1 && PASTE_ONLY_INTO
        ? 'not the app this test may paste into'
        : detail
    console.log(`[paste] ${outcome}${why ? ` (${why})` : ''}`)
    return outcome
  }

  /** One line per session, for the latency gates. Numbers only, never text. */
  function logTimings(session: number): void {
    const entry = controller.recovery.list().find((item) => item.sessionId === session)
    const timings = metrics.finish(session, entry?.outcome ?? 'none')
    if (timings) console.log(formatTimings(timings))
  }

  // --- The pill's buttons -----------------------------------------------------------

  listenFromOwnPages(IPC.pillAction, (payload) => {
    const action = pillActionSchema.safeParse(payload)
    if (!action.success) return
    console.log(`[pill] ${action.data}`)
    switch (action.data) {
      case 'copy':
        return controller.dispatch({ type: 'copyLast' })
      case 'cancel':
        return controller.dispatch({ type: 'escape' })
      case 'start':
        // A click on the resting pill starts a hands-free recording. A click that
        // arrives while a session is running came from a pill that was out of date.
        if (controller.stateName !== 'idle') return
        return controller.dispatch({ type: 'handsFreeDown', t: CLICK_TIME })
      case 'stop':
        return controller.dispatch({ type: 'stop' })
      case 'redo':
        // The message that offered it has done its job. Dismissed after the redo has
        // begun, because dismissing a message also withdraws its offer.
        controller.redo()
        return presenter.dismissRecovery()
      case 'dismiss':
        return presenter.dismissRecovery()
    }
  })

  // --- The helper -------------------------------------------------------------------

  helper.setBindings(DEFAULT_BINDINGS)

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
    if (machineEvent) controller.dispatch(machineEvent)
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
    helper.setBindings(DEFAULT_BINDINGS)
    if (away.size > 0 || !heldForReturn) return
    presenter.showRecovery(heldForReturn)
    heldForReturn = null
  }
  powerMonitor.on('resume', comeBack('sleep'))
  powerMonitor.on('unlock-screen', comeBack('screen lock'))
  powerMonitor.on('user-did-become-active', comeBack('user switch'))

  const tell = (message: string): void => {
    console.log(`[app] ${message}`)
    presenter.showRecovery({ message, canCopy: false, sound: true })
  }

  return { controller, speech, shortcutsActive: () => tapInstalled, cleanupStatus, tell, debug }
}

/** Waits, but no longer than the session lives. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
  })
}
