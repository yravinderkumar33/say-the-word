import type { PasteOutcome, PasteResult } from '@shared/helper-protocol'
import {
  initialState,
  isRecording,
  transition,
  type CancelReason,
  type MachineEffect,
  type MachineEvent,
  type MachineState,
} from '../hotkeys/session-machine'
import { RecoveryBuffer, type RecoveryEntry, type SessionOutcome } from './recovery-buffer'

/** Where a paste may go, recorded by the helper when recording stops. */
export interface TargetInfo {
  targetId: number
  /** True when the focused field is treated as a password field. */
  secure: boolean
  /**
   * What says so: `element` (the field's own role) or `secureInput` (macOS Secure Input
   * is on in that app, which is all that can be known about it).
   */
  secureReason?: string | undefined
  /** The app in front, as the system names it. Shown beside the text in the app's own window. */
  appName?: string | undefined
}

export interface ProducedText {
  /** The recognizer's text, untouched. */
  raw: string
  /** The text to paste. */
  final: string
  /** Cleaned mode: the text after the rules, before the model. */
  rules?: string
  /** Cleaned mode: the model's text, when the guard accepted it. */
  cleaned?: string | null
  /** Cleaned mode: why the final text is what it is. */
  note?: string
}

/** Every stage of a session's text, as the recovery buffer keeps them. */
function stagesOf(produced: ProducedText | null): {
  rawText: string | null
  finalText: string | null
  rulesText: string | null
  cleanedText: string | null
  cleanupNote: string | null
} {
  return {
    rawText: produced?.raw ?? null,
    finalText: produced?.final ?? null,
    rulesText: produced?.rules ?? null,
    cleanedText: produced?.cleaned ?? null,
    cleanupNote: produced?.note ?? null,
  }
}

/** Undo or Retry was asked for a recording that is no longer held. Trying again cannot help. */
export class RecordingGoneError extends Error {
  constructor() {
    super('The recording is no longer held')
    this.name = 'RecordingGoneError'
  }
}

/** Identifies one session to the parts that work on it. */
export interface SessionHandle {
  readonly id: number
  /** Aborts when the session is cancelled. */
  readonly signal: AbortSignal
}

/** Things the pill tells the user. */
export type Notice =
  | { kind: 'stillProcessing' }
  /** `canUndo`: the recording is still held and can be processed after all. */
  | { kind: 'cancelled'; sessionId: number; reason: CancelReason; canUndo?: true }
  /** Something outside the user's control ended the session. Its text, if any, was kept. */
  | { kind: 'interrupted'; sessionId: number; hasText: boolean }
  | { kind: 'noSpeech'; sessionId: number }
  | { kind: 'targetChanged'; sessionId: number }
  /**
   * `because: 'secureInput'`: nothing says the field is a password field except that
   * Secure Input is on in its app, and that is what the user is told.
   */
  | { kind: 'secureField'; sessionId: number; because?: 'secureInput' }
  | { kind: 'pasteFailed'; sessionId: number }
  /** `canRetry`: the recording is still held and the decode can be tried again. */
  | { kind: 'failed'; sessionId: number; message: string; canRetry?: true }
  | { kind: 'nothingToPaste' }
  | { kind: 'copied' }

export interface SessionControllerDeps {
  /** Called when a session starts: opens the microphone. */
  startRecording(session: SessionHandle): void
  /**
   * Stops the recording and turns it into text. Resolves null when there was no speech.
   * Called at most once per session.
   */
  produceText(session: SessionHandle): Promise<ProducedText | null>
  /** Reads where a paste may go, for this session; null for paste-last, which is for none. */
  captureTarget(sessionId: number | null): Promise<TargetInfo>
  /** `sessionId`: the session whose own text this is; null for paste-last. */
  paste(request: { text: string; targetId: number; sessionId: number | null }): Promise<PasteResult>
  armEscape(armed: boolean): void
  writeClipboard(text: string): Promise<void>
  notify(notice: Notice): void
  /** Called whenever the gesture state changes, with the session it concerns. */
  onStateChange?(state: MachineState['name'], sessionId: number | null): void
  now(): number
  /**
   * Undo and Retry: turns the recording still held for a session into text. Without
   * it, neither is offered.
   */
  reproduceText?(session: SessionHandle): Promise<ProducedText | null>
  /**
   * The recording held for this session will not be asked for again. A recording is
   * held from the moment it stops until the controller says this: through the text
   * being worked out and pasted, and for as long as Undo or Retry is on offer.
   */
  forgetRecording?(sessionId: number): void
  /** Called with a session's record whenever it is made or changed: the history is kept from these. */
  onRecorded?(entry: RecoveryEntry): void
  /**
   * A session has ended, and its record says how: pasted, refused, failed, cancelled with
   * a message, or interrupted. Called after that record is made, so that what is added to
   * it (its timings) lands on something. Undo and Retry end a session again, and it is
   * called again then; a press that left no trace, and a session Delete Everything took,
   * never end in this sense.
   */
  onSessionOver?(sessionId: number): void
  /**
   * The text of an earlier session was fetched after all: pasted with the shortcut, or
   * copied. Not called for a session whose own paste went through.
   */
  onFetched?(sessionId: number, how: 'pasted' | 'copied'): void
  /** For the double-tap window. Defaults to `setTimeout`; tests pass their own. */
  setTimer?(run: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

interface Session {
  readonly generation: number
  readonly id: number
  readonly abort: AbortController
  /** The text being produced. Set when the recording stops. */
  text: Promise<ProducedText | null> | null
  /** True once the paste request has been sent: the point of no return. */
  pasting: boolean
}

/**
 * Runs dictation sessions. The gesture rules live in the state machine; this class
 * carries out its effects and enforces the rules about asynchronous work:
 *
 * - Every session has an id, and one session runs at a time.
 * - Cancel is terminal: a cancelled session never pastes, whatever arrives later.
 * - A result that belongs to a session that is no longer current is never pasted.
 * - Once the paste request has been sent, cancel no longer applies.
 * - A session that is interrupted from outside (the helper is lost, the Mac sleeps)
 *   never pastes either, but what was said is still transcribed and kept for recovery.
 */
export class SessionController {
  readonly recovery: RecoveryBuffer
  private state: MachineState = initialState
  private current: Session | null = null
  /** An interrupted session whose text is still being produced for recovery. */
  private salvaging: Session | null = null
  private nextSessionId = 1
  private tapTimer: unknown = null
  /** A cancelled or failed session whose recording is still held: Undo or Retry can use it. */
  private redoable: number | null = null
  private generation = 0
  /** How many deletions of everything are under way: dictation waits for all of them. */
  private discarding = 0
  private readonly pastes = new Set<Promise<PasteResult>>()
  get privacyBlocked(): boolean {
    return this.discarding > 0
  }
  get privacyGeneration(): number {
    return this.generation
  }
  /** Erases without invoking the cancellation path that intentionally salvages text. */
  async discardAll(): Promise<void> {
    this.discarding++
    this.generation++
    const ids = new Set(this.recovery.list().map((entry) => entry.sessionId))
    for (const session of [this.current, this.salvaging])
      if (session) {
        ids.add(session.id)
        session.abort.abort()
      }
    if (this.redoable !== null) ids.add(this.redoable)
    this.current = null
    this.salvaging = null
    this.redoable = null
    this.clearTapTimer()
    this.recovery.clear()
    this.state = initialState
    for (const id of ids) this.deps.forgetRecording?.(id)
    this.deps.armEscape(false)
    this.deps.onStateChange?.('idle', null)
    await Promise.allSettled([...this.pastes])
  }
  /** One deletion is over. Dictation resumes when no other is still under way. */
  resumeAfterDiscard(): void {
    this.discarding = Math.max(0, this.discarding - 1)
  }
  private trackedPaste(request: {
    text: string
    targetId: number
    sessionId: number | null
  }): Promise<PasteResult> {
    const promise = this.deps.paste(request)
    this.pastes.add(promise)
    void promise.finally(() => this.pastes.delete(promise)).catch(() => {})
    return promise
  }

  constructor(private readonly deps: SessionControllerDeps) {
    this.recovery = new RecoveryBuffer(undefined, (entry) => deps.onRecorded?.(entry))
  }

  get stateName(): MachineState['name'] {
    return this.state.name
  }

  dispatch(event: MachineEvent): void {
    if (this.discarding > 0) return
    const before = this.state.name
    const { state, effects } = transition(this.state, event)
    this.state = state
    // The double-tap window belongs to one state only.
    if (before === 'tapPending' && state.name !== 'tapPending') this.clearTapTimer()
    // Escape is ours only while a session is active; otherwise it belongs to the user's app.
    if ((before === 'idle') !== (state.name === 'idle')) {
      this.deps.armEscape(state.name !== 'idle')
    }
    for (const effect of effects) this.run(effect)
    if (before !== state.name) this.deps.onStateChange?.(state.name, this.current?.id ?? null)
  }

  /** The id of the session being recorded or processed, or null. */
  get currentSessionId(): number | null {
    return this.current?.id ?? null
  }

  /** The session whose text paste-last and copy-last would fetch: the last one that left any. */
  get lastTextSession(): number | null {
    return this.recovery.lastWithText()?.sessionId ?? null
  }

  /** True when the session left text behind that Copy or paste-last can still reach. */
  hasText(sessionId: number): boolean {
    return this.recovery.list().some((entry) => entry.sessionId === sessionId && entry.finalText)
  }

  /**
   * Undo or Retry: processes the recording still held for the last cancelled or failed
   * session, and pastes the text where the cursor is now.
   */
  redo(): void {
    const sessionId = this.redoable
    if (
      this.discarding > 0 ||
      sessionId === null ||
      this.state.name !== 'idle' ||
      !this.deps.reproduceText
    )
      return
    this.redoable = null
    const session: Session = {
      id: sessionId,
      generation: this.generation,
      abort: new AbortController(),
      text: null,
      pasting: false,
    }
    this.current = session
    session.text = this.deps.reproduceText(this.handle(session))
    this.dispatch({ type: 'redo' })
    void this.finish(session)
  }

  /** The offer to undo or retry has lapsed: the recording can be let go. */
  forgetRedo(): void {
    if (this.redoable === null) return
    this.deps.forgetRecording?.(this.redoable)
    this.redoable = null
  }

  /**
   * The recording could not start, or broke before it was complete (for example the
   * microphone would not open). The session ends as failed; nothing is pasted.
   *
   * That can still happen just after the key is released, while the recording is being
   * wound up: nothing will be sent to the recognizer then, and waiting for its text
   * would only end in a timeout. Once the paste has been sent it is too late to matter.
   */
  failRecording(sessionId: number, message: string): void {
    const session = this.current
    if (!session || session.id !== sessionId) return
    const windingUp = this.state.name === 'processing' && !session.pasting
    if (!isRecording(this.state.name) && !windingUp) return
    this.current = null
    session.abort.abort()
    this.deps.forgetRecording?.(sessionId)
    this.recovery.record({
      sessionId,
      endedAt: this.deps.now(),
      outcome: 'failed',
      rawText: null,
      finalText: null,
    })
    this.deps.notify({ kind: 'failed', sessionId, message })
    this.deps.onSessionOver?.(sessionId)
    this.dispatch({ type: 'sessionEnded' })
  }

  /**
   * The recording ended by itself (length limit, or the microphone went away).
   * What was captured is processed as if the key had been released.
   */
  endRecording(sessionId: number): void {
    if (this.current?.id !== sessionId || !isRecording(this.state.name)) return
    this.dispatch({ type: 'limitReached' })
  }

  private run(effect: MachineEffect): void {
    switch (effect.type) {
      case 'startSession': {
        // One recording at a time: an interrupted session still being transcribed gives way,
        // and so does the offer to bring an earlier one back.
        this.salvaging?.abort.abort()
        this.forgetRedo()
        const session: Session = {
          id: this.nextSessionId++,
          generation: this.generation,
          abort: new AbortController(),
          text: null,
          pasting: false,
        }
        this.current = session
        this.deps.startRecording(this.handle(session))
        return
      }
      case 'stopRecording':
        if (this.current) void this.finish(this.current)
        return
      case 'cancelSession':
        this.cancel(effect.reason, effect.silent)
        return
      case 'armTapTimeout': {
        this.clearTapTimer()
        const setTimer = this.deps.setTimer ?? ((run, ms) => setTimeout(run, ms))
        this.tapTimer = setTimer(() => {
          this.tapTimer = null
          this.dispatch({ type: 'tapTimeout' })
        }, effect.ms)
        return
      }
      case 'cueStillProcessing':
        this.deps.notify({ kind: 'stillProcessing' })
        return
      case 'pasteLast':
        void this.pasteLast()
        return
      case 'copyLast':
        void this.copyLast()
        return
    }
  }

  private clearTapTimer(): void {
    if (this.tapTimer === null) return
    const clearTimer = this.deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    clearTimer(this.tapTimer)
    this.tapTimer = null
  }

  private handle(session: Session): SessionHandle {
    return { id: session.id, signal: session.abort.signal }
  }

  private isCurrent(session: Session): boolean {
    return this.current === session
  }

  /** Stops the recording and starts producing its text, once per session. */
  private textOf(session: Session): Promise<ProducedText | null> {
    session.text ??= this.deps.produceText(this.handle(session))
    return session.text
  }

  private cancel(reason: CancelReason, silent: boolean): void {
    const session = this.current
    this.current = null
    if (!session) return
    // The paste has already been sent; there is nothing left to cancel.
    if (session.pasting) return

    if (reason === 'aborted') {
      void this.salvage(session)
      return
    }

    session.abort.abort()
    // A cancel the user made can be taken back while the recording is still held.
    const canUndo =
      !silent && Boolean(this.deps.reproduceText) && (reason === 'escape' || reason === 'tripleTap')
    if (canUndo) this.redoable = session.id
    else this.deps.forgetRecording?.(session.id)
    if (silent) return
    this.recordCancelled(session, null)
    this.deps.notify({
      kind: 'cancelled',
      sessionId: session.id,
      reason,
      ...(canUndo ? { canUndo: true as const } : {}),
    })
    this.deps.onSessionOver?.(session.id)
    // Text that still arrives is kept for recovery, and never pasted.
    session.text?.then(
      (produced) => {
        if (session.generation === this.generation && produced?.final)
          this.recovery.fill(session.id, stagesOf(produced))
      },
      () => {},
    )
  }

  /**
   * The session can no longer paste (the helper went away, the Mac went to sleep), but
   * what was said is still worth keeping: the recording is stopped and transcribed, and
   * the text goes to recovery.
   */
  private async salvage(session: Session): Promise<void> {
    this.salvaging = session
    let produced: ProducedText | null = null
    try {
      produced = await this.textOf(session)
    } catch {
      // Nothing could be recovered.
    }
    if (this.salvaging === session) this.salvaging = null
    if (session.generation !== this.generation) return
    this.recordCancelled(session, produced, true)
    // Nothing offers to run an interrupted session again.
    this.deps.forgetRecording?.(session.id)
    // A newer session has started since; its pill is not the place for this message.
    // The text is the session's, which an earlier attempt may have left (an Undo that
    // was interrupted in turn): Copy still reaches it.
    if (!session.abort.signal.aborted) {
      this.deps.notify({
        kind: 'interrupted',
        sessionId: session.id,
        hasText: this.hasText(session.id),
      })
    }
    this.deps.onSessionOver?.(session.id)
  }

  private recordCancelled(
    session: Session,
    produced: ProducedText | null,
    interrupted = false,
  ): void {
    this.recovery.record({
      sessionId: session.id,
      endedAt: this.deps.now(),
      outcome: 'cancelled',
      ...stagesOf(produced),
      ...(interrupted ? { interrupted: true as const } : {}),
    })
  }

  /** Recording has stopped: fix the destination, produce the text, paste it. */
  private async finish(session: Session): Promise<void> {
    let produced: ProducedText | null = null
    let outcome: SessionOutcome
    let failure: string | null = null
    let reachedText = false
    let secureInput = false
    let appName: string | null = null
    try {
      // The recording stops and the destination is fixed at the same moment, before
      // any processing delay.
      const text = this.textOf(session)
      text.catch(() => {}) // Reported below, or dropped along with a cancelled session.
      const target = await this.deps.captureTarget(session.id)
      if (!this.isCurrent(session)) return
      appName = target.appName ?? null

      reachedText = true
      produced = await text
      if (!this.isCurrent(session)) return

      if (!produced || produced.final.length === 0) {
        outcome = 'noSpeech'
      } else if (target.secure) {
        outcome = 'secureField'
        secureInput = target.secureReason === 'secureInput'
      } else {
        session.pasting = true
        const pasted = await this.trackedPaste({
          text: produced.final,
          targetId: target.targetId,
          sessionId: session.id,
        })
        outcome = toSessionOutcome(pasted.outcome)
        // The helper reads the destination again before it pastes, and may find Secure
        // Input on in it by then.
        secureInput = refusedForSecureInput(pasted)
      }
    } catch (error) {
      // A cancelled session's work is expected to fail; that is not a failure to report.
      if (!this.isCurrent(session) && !session.pasting) return
      outcome = 'failed'
      failure = error instanceof Error ? error.message : String(error)
      if (!produced && session.text) {
        // The paste is lost, but the text may not be: keep it if it arrives.
        produced = await session.text.catch(() => null)
        if (!this.isCurrent(session)) return
      }
      // The decode itself failed, and the recording is still held: it can be tried again.
      const worthRetrying = !(error instanceof RecordingGoneError)
      if (
        reachedText &&
        !produced &&
        !session.pasting &&
        worthRetrying &&
        this.deps.reproduceText
      ) {
        this.redoable = session.id
      }
    }

    if (session.generation !== this.generation) return
    this.recovery.record({
      sessionId: session.id,
      endedAt: this.deps.now(),
      outcome,
      ...stagesOf(produced),
      appName,
      ...(secureInput ? { secureInput: true as const } : {}),
    })
    // The session is over. Its recording was held until now, so that a cancel at any
    // point before this could still be taken back; it is let go unless Retry needs it.
    if (this.redoable !== session.id) this.deps.forgetRecording?.(session.id)
    this.announce(session.id, outcome, failure, secureInput)
    // Also when a cancel came while the paste was on its way: the gesture is over by now,
    // and only this says how the session ended.
    this.deps.onSessionOver?.(session.id)

    if (this.isCurrent(session)) {
      this.current = null
      this.dispatch({ type: 'sessionEnded' })
    }
  }

  private announce(
    sessionId: number,
    outcome: SessionOutcome,
    failure: string | null = null,
    secureInput = false,
  ): void {
    switch (outcome) {
      case 'secureField':
        this.deps.notify({
          kind: 'secureField',
          sessionId,
          ...(secureInput ? { because: 'secureInput' as const } : {}),
        })
        return
      case 'noSpeech':
      case 'targetChanged':
      case 'pasteFailed':
        this.deps.notify({ kind: outcome, sessionId })
        return
      case 'failed':
        this.deps.notify({
          kind: 'failed',
          sessionId,
          message: failure ?? 'Something went wrong',
          ...(this.redoable === sessionId ? { canRetry: true as const } : {}),
        })
        return
      default:
        return
    }
  }

  private async pasteLast(): Promise<void> {
    const generation = this.generation
    const entry = this.recovery.lastWithText()
    if (!entry?.finalText) {
      this.deps.notify({ kind: 'nothingToPaste' })
      return
    }
    try {
      // Paste-last is an explicit request, so the destination is wherever the user is now.
      // It is no session's own paste, whichever session may have begun meanwhile.
      const target = await this.deps.captureTarget(null)
      if (generation !== this.generation) return
      if (target.secure) {
        this.announce(entry.sessionId, 'secureField', null, target.secureReason === 'secureInput')
        return
      }
      const pasted = await this.trackedPaste({
        text: entry.finalText,
        targetId: target.targetId,
        sessionId: null,
      })
      if (generation !== this.generation) return
      if (pasted.outcome !== 'pasted') {
        this.announce(
          entry.sessionId,
          toSessionOutcome(pasted.outcome),
          null,
          refusedForSecureInput(pasted),
        )
      } else if (entry.outcome !== 'pasted') this.deps.onFetched?.(entry.sessionId, 'pasted')
    } catch {
      if (generation !== this.generation) return
      this.deps.notify({ kind: 'pasteFailed', sessionId: entry.sessionId })
    }
  }

  private async copyLast(): Promise<void> {
    const generation = this.generation
    const entry = this.recovery.lastWithText()
    if (!entry?.finalText) {
      this.deps.notify({ kind: 'nothingToPaste' })
      return
    }
    await this.deps.writeClipboard(entry.finalText)
    if (generation !== this.generation) return
    if (entry.outcome !== 'pasted') this.deps.onFetched?.(entry.sessionId, 'copied')
    this.deps.notify({ kind: 'copied' })
  }
}

function toSessionOutcome(outcome: PasteOutcome): SessionOutcome {
  return outcome === 'noPostAccess' || outcome === 'expired' ? 'pasteFailed' : outcome
}

/** The helper refused the paste on no more evidence than Secure Input being on in the app. */
function refusedForSecureInput(result: PasteResult): boolean {
  return result.outcome === 'secureField' && result.detail === 'secureInput'
}
