import type { PillRecovery, PillState } from '@shared/ipc'
import { isRecording, type MachineState } from '../hotkeys/session-machine'

type Gesture = MachineState['name']

export interface PillPresenterOptions {
  /** How long a message stays before the pill returns to rest. */
  recoveryMs: number
  /** How long a confirmation stays: there is nothing in it to read twice, or to press. */
  confirmMs: number
  /**
   * How long the microphone may take to open, or the text to arrive, before the pill
   * says more about it. Shorter waits pass without words, and without a Cancel button
   * that would only flash by.
   */
  slowMs: number
  /**
   * The longest a message waits under a pointer that stays on it. A recording kept for
   * Undo or Retry is held for as long as its message shows, and that must have an end
   * when nobody is there to move the pointer away.
   */
  maxHoldMs: number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  now(): number
  /** A message was dismissed or timed out, and with it any offer it carried. */
  onRecoveryGone?(): void
}

export const DEFAULT_PRESENTER_OPTIONS: PillPresenterOptions = {
  recoveryMs: 6_000,
  confirmMs: 2_000,
  slowMs: 1_000,
  maxHoldMs: 60_000,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
}

/** When a recording began and when it will be stopped, in milliseconds since the epoch. */
export interface RecordingClock {
  startedAt: number
  limitAt: number
}

/**
 * Decides what the pill shows, from what is known in the main process: the gesture
 * state, whether audio is actually flowing, how long a wait has lasted, and whether
 * there is something to tell the user.
 *
 * The rule that matters most: the pill says "listening" only once audio is flowing.
 * Between the key press and that moment it says "starting", so speech that would be
 * lost is never spoken into a pill that looks ready.
 */
export class PillPresenter {
  private gesture: Gesture = 'idle'
  private live = false
  private clock: RecordingClock | null = null
  /** The microphone has taken long enough to open that the pill says so. */
  private slow = false
  private slowTimer: unknown = null
  /** The text has taken long enough that Cancel is worth offering. */
  private long = false
  private longTimer: unknown = null
  private tidying = false
  private modelLoading = false
  private recovery: PillRecovery | null = null
  /** False until the message has been on show: its time is counted from then. */
  private recoveryShown = false
  private recoveryTimer: unknown = null
  /** When the message on show leaves, and what was left of its time when the pointer came. */
  private recoveryDue = 0
  private recoveryLeft: number | null = null
  private pointerOver = false
  /** Text that was not pasted is still there to be fetched: nothing has pasted or copied it since. */
  private waiting = false
  private last = ''

  constructor(
    private readonly send: (state: PillState) => void,
    private readonly options: PillPresenterOptions = DEFAULT_PRESENTER_OPTIONS,
  ) {}

  reset(): void {
    this.clearRecovery()
    this.clearSlow()
    this.clearLong()
    this.gesture = 'idle'
    this.live = false
    this.clock = null
    this.waiting = false
    this.tidying = false
    this.modelLoading = false
    this.push()
  }

  /**
   * A recording has begun: when, and when it will be stopped. Said before the gesture
   * changes, and also for a session that follows another with no pause between them (a
   * press just too late to be a double tap ends one recording and begins the next).
   */
  setRecording(clock: RecordingClock): void {
    this.clock = clock
    this.beginSession()
  }

  setGesture(gesture: Gesture): void {
    const wasRecording = isRecording(this.gesture)
    const nowRecording = isRecording(gesture)
    if (nowRecording && !wasRecording) this.beginSession()
    if (!nowRecording) {
      this.live = false
      this.clearSlow()
    }
    if (gesture === 'processing' && this.gesture !== 'processing') {
      this.long = false
      this.longTimer = this.options.setTimer(() => {
        this.longTimer = null
        this.long = true
        this.push()
      }, this.options.slowMs)
    }
    if (gesture !== 'processing') this.clearLong()
    this.gesture = gesture
    this.push()
  }

  /**
   * A new session: audio is not flowing yet, and any old message is out of date. The
   * text it offered is not: the mark stands in for the message, because this press may
   * turn out to be no dictation at all (a lone tap, Fn with an arrow key).
   */
  private beginSession(): void {
    this.live = false
    if (this.recovery?.canCopy) this.waiting = true
    this.clearRecovery()
    this.clearSlow()
    this.slowTimer = this.options.setTimer(() => {
      this.slowTimer = null
      this.slow = true
      this.push()
    }, this.options.slowMs)
  }

  /** Audio has started to flow for the session being recorded. */
  setLive(): void {
    if (!isRecording(this.gesture)) return
    this.live = true
    this.clearSlow()
    this.push()
  }

  /** Whether the text now being worked out is also tidied (Cleaned mode). */
  setTidying(tidying: boolean): void {
    this.tidying = tidying
    this.push()
  }

  /** The speech model is being loaded, which the text has to wait for. */
  setModelLoading(loading: boolean): void {
    this.modelLoading = loading
    this.push()
  }

  /**
   * Says something on the pill. A message that comes while the pill is busy with a
   * dictation is shown when that is over, and its time is counted from then: said to
   * nobody, it would be gone before it was seen.
   */
  showRecovery(recovery: PillRecovery): void {
    // A message that offered text and is put aside by another leaves the mark for it, as
    // one that is dismissed does. Whoever fetched that text said so first (`textTaken`),
    // and then there is no such message left here.
    if (this.recovery?.canCopy) this.waiting = true
    this.clearRecovery()
    this.recovery = recovery
    this.push()
  }

  /** True while a message is on the pill. */
  get showsRecovery(): boolean {
    return this.recovery !== null
  }

  dismissRecovery(): void {
    if (!this.recovery) return
    // The text the message offered is still there to be fetched, and the pill keeps a mark for it.
    if (this.recovery.canCopy) this.waiting = true
    this.clearRecovery()
    this.options.onRecoveryGone?.()
    this.push()
  }

  /**
   * The pointer is over a pill that can be clicked, or has left it. A message does not
   * leave from under a pointer that is on its way to one of its buttons: its time
   * stands still until the pointer goes.
   */
  setPointerOver(over: boolean): void {
    if (this.pointerOver === over) return
    this.pointerOver = over
    // A message still waiting to be shown looks at the pointer when its time starts.
    if (!this.recovery || !this.recoveryShown) return
    if (over && this.recoveryLeft === null) {
      this.hold(Math.max(0, this.recoveryDue - this.options.now()))
    } else if (!over && this.recoveryLeft !== null) {
      this.startRecoveryTimer(this.recoveryLeft)
    }
  }

  /** Stops the message's clock with this much of its time left, for as long as the pointer stays. */
  private hold(left: number): void {
    if (this.recoveryTimer !== null) this.options.clearTimer(this.recoveryTimer)
    this.recoveryLeft = left
    this.recoveryTimer = this.options.setTimer(() => {
      this.recoveryTimer = null
      this.dismissRecovery()
    }, this.options.maxHoldMs)
  }

  /**
   * The text that was not pasted has now been pasted or copied: there is nothing left
   * to fetch. The mark goes, and so does a message that was still offering that text.
   */
  textTaken(): void {
    this.waiting = false
    const shown = this.recovery
    if (shown?.canCopy) {
      if (shown.redo) {
        // Its offer to try again stands; only the text has been fetched.
        this.recovery = { ...shown, canCopy: false }
      } else {
        this.clearRecovery()
        this.options.onRecoveryGone?.()
      }
    }
    this.push()
  }

  /** The message has just come on show: its time starts, or waits under the pointer. */
  private startRecoveryClock(): void {
    if (!this.recovery || this.recoveryShown) return
    this.recoveryShown = true
    const stays =
      this.recovery.messageKind === 'confirm' ? this.options.confirmMs : this.options.recoveryMs
    // A message that appears under the pointer waits there, like one the pointer came to.
    if (this.pointerOver) this.hold(stays)
    else this.startRecoveryTimer(stays)
  }

  private startRecoveryTimer(ms: number): void {
    if (this.recoveryTimer !== null) this.options.clearTimer(this.recoveryTimer)
    this.recoveryLeft = null
    this.recoveryDue = this.options.now() + ms
    this.recoveryTimer = this.options.setTimer(() => {
      this.recoveryTimer = null
      this.dismissRecovery()
    }, ms)
  }

  private clearRecovery(): void {
    if (this.recoveryTimer !== null) this.options.clearTimer(this.recoveryTimer)
    this.recoveryTimer = null
    this.recoveryLeft = null
    this.recoveryShown = false
    this.recovery = null
  }

  private clearSlow(): void {
    if (this.slowTimer !== null) this.options.clearTimer(this.slowTimer)
    this.slowTimer = null
    this.slow = false
  }

  private clearLong(): void {
    if (this.longTimer !== null) this.options.clearTimer(this.longTimer)
    this.longTimer = null
    this.long = false
  }

  private state(): PillState {
    if (isRecording(this.gesture)) {
      if (!this.live) return { kind: 'starting', slow: this.slow }
      const startedAt = this.clock?.startedAt ?? this.options.now()
      return {
        kind: 'listening',
        handsFree: this.gesture === 'locked',
        startedAt,
        limitAt: this.clock?.limitAt ?? startedAt,
      }
    }
    if (this.gesture === 'processing') {
      // A model that is still loading is what the wait is for, whatever comes after it.
      const hint = this.long && this.modelLoading ? 'loadingModel' : this.tidying ? 'tidying' : null
      return { kind: 'processing', long: this.long, hint }
    }
    if (this.recovery) return { kind: 'recovery', ...this.recovery }
    return { kind: 'resting', waiting: this.waiting }
  }

  private push(): void {
    const state = this.state()
    if (state.kind === 'recovery') this.startRecoveryClock()
    const key = JSON.stringify(state)
    if (key === this.last) return
    this.last = key
    this.send(state)
  }
}
