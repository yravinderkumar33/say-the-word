import type { PillRecovery, PillState } from '@shared/ipc'
import { isRecording, type MachineState } from '../hotkeys/session-machine'

type Gesture = MachineState['name']

export interface PillPresenterOptions {
  /** How long a recovery message stays before the pill returns to rest. */
  recoveryMs: number
  setTimer(run: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** A message was dismissed or timed out, and with it any offer it carried. */
  onRecoveryGone?(): void
}

export const DEFAULT_PRESENTER_OPTIONS: PillPresenterOptions = {
  recoveryMs: 6_000,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

/**
 * Decides what the pill shows, from three facts: the gesture state, whether audio is
 * actually flowing, and whether there is something to tell the user.
 *
 * The rule that matters most: the pill says "listening" only once audio is flowing.
 * Between the key press and that moment it says "starting", so speech that would be
 * lost is never spoken into a pill that looks ready.
 */
export class PillPresenter {
  private gesture: Gesture = 'idle'
  private live = false
  private recovery: PillRecovery | null = null
  private recoveryTimer: unknown = null
  private last = ''

  constructor(
    private readonly send: (state: PillState) => void,
    private readonly options: PillPresenterOptions = DEFAULT_PRESENTER_OPTIONS,
  ) {}

  setGesture(gesture: Gesture): void {
    if (isRecording(gesture) && !isRecording(this.gesture)) {
      // A new session: audio is not flowing yet, and any old message is out of date.
      this.live = false
      this.clearRecovery()
    }
    if (!isRecording(gesture)) this.live = false
    this.gesture = gesture
    this.push()
  }

  /** Audio has started to flow for the session being recorded. */
  setLive(): void {
    if (!isRecording(this.gesture)) return
    this.live = true
    this.push()
  }

  showRecovery(recovery: PillRecovery): void {
    this.clearRecovery()
    this.recovery = recovery
    this.recoveryTimer = this.options.setTimer(
      () => this.dismissRecovery(),
      this.options.recoveryMs,
    )
    this.push()
  }

  dismissRecovery(): void {
    if (!this.recovery) return
    this.clearRecovery()
    this.options.onRecoveryGone?.()
    this.push()
  }

  private clearRecovery(): void {
    if (this.recoveryTimer !== null) this.options.clearTimer(this.recoveryTimer)
    this.recoveryTimer = null
    this.recovery = null
  }

  private state(): PillState {
    if (isRecording(this.gesture)) {
      return this.live
        ? { kind: 'listening', handsFree: this.gesture === 'locked' }
        : { kind: 'starting' }
    }
    if (this.gesture === 'processing') return { kind: 'processing' }
    if (this.recovery) return { kind: 'recovery', ...this.recovery }
    return { kind: 'resting' }
  }

  private push(): void {
    const state = this.state()
    const key = JSON.stringify(state)
    if (key === this.last) return
    this.last = key
    this.send(state)
  }
}
