/**
 * The gesture state machine: which shortcut events start, stop and cancel a dictation.
 *
 * Pure: `transition` takes a state and an event and returns the next state plus the
 * effects to carry out. It knows nothing about audio, text or the helper, so every
 * rule is unit-tested with plain numbers for time.
 *
 * Two ways to dictate. Push-to-talk: hold the key, speak, release. Hands-free: the
 * recording is locked on and continues with no key held, until it is stopped. It is
 * locked by a double tap of the key, by the hands-free shortcut (Fn+Space), or by
 * clicking the pill.
 */

/** A hold shorter than this is a tap, not a dictation. Wispr Flow does not publish its value. */
export const TAP_THRESHOLD_MS = 300
/** A second press this soon after the first one began is a double tap. Wispr Flow's documented value. */
export const DOUBLE_TAP_WINDOW_MS = 500
/** A press this soon after locking is a third tap, and means "never mind". Wispr Flow's documented value. */
export const LOCK_CANCEL_WINDOW_MS = 500

export type MachineState =
  | { name: 'idle' }
  /** The key is down and the recording runs. */
  | { name: 'holding'; startedAt: number }
  /** The key was tapped. The recording runs on for a moment in case a second tap follows. */
  | { name: 'tapPending'; startedAt: number }
  /** Hands-free: the recording runs with no key held. */
  | { name: 'locked'; lockedAt: number }
  | { name: 'processing' }

export type MachineEvent =
  /** Push-to-talk key went down or up. `t` is the helper's event time in milliseconds. */
  | { type: 'pttDown'; t: number }
  | { type: 'pttUp'; t: number }
  /** The hands-free shortcut was pressed, or the resting pill was clicked. */
  | { type: 'handsFreeDown'; t: number }
  /** The double-tap window ran out with no second tap. */
  | { type: 'tapTimeout' }
  /** The pill's stop button. */
  | { type: 'stop' }
  /** Another key was pressed while push-to-talk was held (for example Fn+arrow). */
  | { type: 'interrupted' }
  /** Escape was pressed, or the pill's cancel button, while a session was active. */
  | { type: 'escape' }
  /** The recording reached its length limit, or ended by itself. */
  | { type: 'limitReached' }
  /** The session finished: pasted, recovered or failed. */
  | { type: 'sessionEnded' }
  /** Something outside the user's control ended the session: helper lost, sleep, lock. */
  | { type: 'abort' }
  | { type: 'pasteLast' }
  | { type: 'copyLast' }
  /** Undo or Retry: the held recording of the last session is processed after all. */
  | { type: 'redo' }

export type CancelReason =
  | 'quickTap'
  | 'interrupted'
  | 'escape'
  /** A third tap right after a double tap. */
  | 'tripleTap'
  | 'superseded'
  | 'aborted'

export type MachineEffect =
  | { type: 'startSession' }
  /** Recording is over; capture the destination and produce the text. */
  | { type: 'stopRecording' }
  /** `silent` cancels leave no trace; the others go to Recovery. */
  | { type: 'cancelSession'; reason: CancelReason; silent: boolean }
  /** Send `tapTimeout` after this long, unless the state changes first. */
  | { type: 'armTapTimeout'; ms: number }
  | { type: 'cueStillProcessing' }
  | { type: 'pasteLast' }
  | { type: 'copyLast' }

export interface Transition {
  state: MachineState
  effects: MachineEffect[]
}

export const initialState: MachineState = { name: 'idle' }

const IDLE: MachineState = { name: 'idle' }
const PROCESSING: MachineState = { name: 'processing' }

/** True while the microphone is (meant to be) open. */
export function isRecording(state: MachineState['name']): boolean {
  return state === 'holding' || state === 'tapPending' || state === 'locked'
}

export function transition(state: MachineState, event: MachineEvent): Transition {
  switch (state.name) {
    case 'idle':
      return fromIdle(state, event)
    case 'holding':
      return fromHolding(state, event)
    case 'tapPending':
      return fromTapPending(state, event)
    case 'locked':
      return fromLocked(state, event)
    case 'processing':
      return fromProcessing(state, event)
  }
}

function stay(state: MachineState, effects: MachineEffect[] = []): Transition {
  return { state, effects }
}

const cancel = (reason: CancelReason, silent: boolean): Transition => ({
  state: IDLE,
  effects: [{ type: 'cancelSession', reason, silent }],
})
const stop = (): Transition => ({ state: PROCESSING, effects: [{ type: 'stopRecording' }] })

function fromIdle(state: MachineState, event: MachineEvent): Transition {
  switch (event.type) {
    case 'pttDown':
      return { state: { name: 'holding', startedAt: event.t }, effects: [{ type: 'startSession' }] }
    case 'handsFreeDown':
      return { state: { name: 'locked', lockedAt: event.t }, effects: [{ type: 'startSession' }] }
    case 'pasteLast':
      return stay(state, [{ type: 'pasteLast' }])
    case 'copyLast':
      return stay(state, [{ type: 'copyLast' }])
    case 'redo':
      // No recording: straight to processing what is already held.
      return stay(PROCESSING)
    default:
      return stay(state)
  }
}

function fromHolding(
  state: Extract<MachineState, { name: 'holding' }>,
  event: MachineEvent,
): Transition {
  switch (event.type) {
    case 'pttUp': {
      if (event.t - state.startedAt >= TAP_THRESHOLD_MS) return stop()
      // A tap. The recording runs on until the double-tap window closes.
      const left = Math.max(0, state.startedAt + DOUBLE_TAP_WINDOW_MS - event.t)
      return {
        state: { name: 'tapPending', startedAt: state.startedAt },
        effects: [{ type: 'armTapTimeout', ms: left }],
      }
    }
    case 'handsFreeDown':
      // Space while the key is held: the recording is locked on, and the key can be let go.
      return stay({ name: 'locked', lockedAt: event.t })
    case 'limitReached':
      return stop()
    case 'interrupted':
      return cancel('interrupted', true)
    case 'escape':
      return cancel('escape', false)
    case 'abort':
      return cancel('aborted', false)
    case 'sessionEnded':
      // The session failed while recording (for example the microphone would not open).
      return stay(IDLE)
    default:
      return stay(state)
  }
}

function fromTapPending(
  state: Extract<MachineState, { name: 'tapPending' }>,
  event: MachineEvent,
): Transition {
  switch (event.type) {
    case 'pttDown':
      if (event.t - state.startedAt <= DOUBLE_TAP_WINDOW_MS) {
        return stay({ name: 'locked', lockedAt: event.t })
      }
      // Too late to be a double tap: the tap is forgotten and this press starts afresh.
      return {
        state: { name: 'holding', startedAt: event.t },
        effects: [
          { type: 'cancelSession', reason: 'quickTap', silent: true },
          { type: 'startSession' },
        ],
      }
    case 'handsFreeDown':
      return stay({ name: 'locked', lockedAt: event.t })
    case 'tapTimeout':
    case 'escape':
    case 'abort':
      // A lone tap is nothing: no text, no message.
      return cancel('quickTap', true)
    case 'sessionEnded':
      return stay(IDLE)
    default:
      return stay(state)
  }
}

function fromLocked(
  state: Extract<MachineState, { name: 'locked' }>,
  event: MachineEvent,
): Transition {
  switch (event.type) {
    case 'pttDown':
    case 'handsFreeDown':
      // A press ends hands-free. Right after locking it is a third tap, which cancels.
      return event.t - state.lockedAt < LOCK_CANCEL_WINDOW_MS ? cancel('tripleTap', false) : stop()
    case 'stop':
    case 'limitReached':
      return stop()
    case 'escape':
      return cancel('escape', false)
    case 'abort':
      return cancel('aborted', false)
    case 'sessionEnded':
      return stay(IDLE)
    default:
      // The release of the key that locked it, or typing while dictating hands-free.
      return stay(state)
  }
}

function fromProcessing(state: MachineState, event: MachineEvent): Transition {
  switch (event.type) {
    case 'pttDown':
      return stay(state, [{ type: 'cueStillProcessing' }])
    case 'escape':
      return cancel('escape', false)
    case 'abort':
      return cancel('aborted', false)
    case 'pasteLast':
      return {
        state: IDLE,
        effects: [
          { type: 'cancelSession', reason: 'superseded', silent: false },
          { type: 'pasteLast' },
        ],
      }
    case 'copyLast':
      return stay(state, [{ type: 'copyLast' }])
    case 'sessionEnded':
      return stay(IDLE)
    default:
      return stay(state)
  }
}
