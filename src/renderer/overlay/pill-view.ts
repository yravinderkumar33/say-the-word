import type { PillMessageKind, PillState } from '@shared/ipc'
import { microphoneName } from '@shared/microphone-name'

/** What only this page knows about the dictation in hand. */
export interface PillSenses {
  /** The shortcut was pressed while the last dictation is still being processed. */
  busy: boolean
  /** Nothing has been heard since the microphone went live, for three seconds. */
  quiet: boolean
  /** The microphone in use, as the system names it. Null before one has been opened. */
  microphone: string | null
}

/** What only the overlay page knows, beside the state the main process sends. */
export interface PillLocal extends PillSenses {
  /** The pointer has rested on the pill for half a second. */
  hover: boolean
  /** The time now in milliseconds since the epoch, for the clock of a hands-free recording. */
  now: number
  /** The key that starts a dictation, as it is printed on the keyboard. */
  key: string
  /** The same key as it is said aloud. */
  keySpoken: string
  /** False: nothing is drawn at rest. The pill appears with a dictation, or with something to say. */
  atRest: boolean
  /** Dictation is paused until then, as a time of day (`11:42`); null when it is not. */
  pausedUntil: string | null
}

/**
 * What the pill draws. Each shape has its own size and its own contents, and the pill
 * grows from one to the next.
 */
export type PillView =
  /** Nothing at all: the setting says the pill is shown only while dictating. */
  | { shape: 'hidden' }
  | { shape: 'rest'; waiting: boolean }
  | { shape: 'hint'; text: string }
  /** Text that was not pasted is waiting: the hint says how to fetch it, and offers Copy. */
  | { shape: 'waitingHint'; text: string }
  /** The microphone, with a key held: bars, and words when there is something to say. */
  | { shape: 'mic'; live: boolean; text: string | null }
  | { shape: 'handsFree'; clock: string; lastMinute: boolean }
  | { shape: 'processing'; text: string | null; busy: boolean; canCancel: boolean }
  | { shape: 'confirm'; text: string }
  | {
      shape: 'message'
      kind: Exclude<PillMessageKind, 'confirm'>
      text: string
      redo: 'Undo' | 'Retry' | null
      canCopy: boolean
    }

/** The last stretch of a recording, in which the clock counts down instead of up. */
const LAST_STRETCH_MS = 60_000
/** How often the time left is said aloud in that stretch. */
const SAID_EVERY_MS = 15_000

/** Minutes and seconds, as a clock shows them: `0:42`. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function pillView(state: PillState, local: PillLocal): PillView {
  switch (state.kind) {
    case 'resting':
      if (!local.atRest) return { shape: 'hidden' }
      if (!local.hover) return { shape: 'rest', waiting: state.waiting }
      if (state.waiting) {
        return {
          shape: 'waitingHint',
          // Every shortcut is off while dictation is paused: the hint does not promise one.
          text: local.pausedUntil
            ? `Unpasted dictation · paused until ${local.pausedUntil}`
            : 'Unpasted dictation · ⌘⌃V to paste',
        }
      }
      return {
        shape: 'hint',
        text: local.pausedUntil
          ? `Paused until ${local.pausedUntil} · resume in the menu bar`
          : `Hold ${local.key} to dictate · click for hands-free`,
      }
    case 'starting':
      return {
        shape: 'mic',
        live: false,
        text: state.slow ? 'Waiting for the microphone…' : null,
      }
    case 'listening': {
      if (!state.handsFree) {
        return {
          shape: 'mic',
          live: true,
          text: local.quiet ? noSound(local.microphone) : null,
        }
      }
      const left = state.limitAt - local.now
      const lastMinute = left <= LAST_STRETCH_MS
      return {
        shape: 'handsFree',
        clock: lastMinute ? `${clock(left)} left` : clock(local.now - state.startedAt),
        lastMinute,
      }
    }
    case 'processing':
      return {
        shape: 'processing',
        text: local.busy
          ? 'Still on the last dictation'
          : state.hint === 'loadingModel'
            ? 'Loading the speech model…'
            : state.hint === 'tidying'
              ? 'Tidying'
              : null,
        busy: local.busy,
        canCancel: state.long,
      }
    case 'recovery':
      if (state.messageKind === 'confirm') return { shape: 'confirm', text: state.message }
      return {
        shape: 'message',
        kind: state.messageKind,
        text: state.message,
        redo: state.redo ?? null,
        canCopy: state.canCopy,
      }
  }
}

function noSound(microphone: string | null): string {
  return microphone ? `No sound from ${microphoneName(microphone)}` : 'No sound from the microphone'
}

/** True when the pill has something to click: itself at rest, or a button. */
export function isClickable(view: PillView, paused = false): boolean {
  switch (view.shape) {
    case 'rest':
    case 'hint':
      // A click starts a hands-free dictation, which there is none of while paused.
      return !paused
    case 'waitingHint':
    case 'handsFree':
    case 'message':
      return true
    case 'processing':
      return view.canCancel
    case 'hidden':
    case 'mic':
    case 'confirm':
      return false
  }
}

/**
 * What decides where the pill's buttons are. A click that comes just after it changes
 * is ignored: it was aimed at whatever was there before. The pill store and the pill
 * both go by this.
 */
export function layoutOf(view: PillView): string {
  switch (view.shape) {
    case 'rest':
      return `rest:${view.waiting}`
    case 'hint':
      // Words only: a click on the hint does what a click on the pill it grew from does.
      return 'rest:false'
    case 'processing':
      return `processing:${view.canCancel}`
    case 'message':
      // Its buttons, and its words, which decide how wide it is and so where they sit.
      return `message:${view.redo}:${view.canCopy}:${view.text}`
    case 'confirm':
      return `confirm:${view.text}`
    case 'mic':
      return 'mic'
    default:
      return view.shape
  }
}

/**
 * What VoiceOver says for the pill, or nothing when saying it would only be noise.
 *
 * The pill's window cannot take the keyboard, so every sentence that mentions
 * something to do names the key or the menu item that does it, in words and not in
 * symbols: `⌘⌃C` would be read as three signs.
 */
export function spokenFor(state: PillState, local: PillLocal): string {
  switch (state.kind) {
    case 'resting':
      // Rest is not news. Text left waiting is, once: when the message that offered it has gone.
      if (!state.waiting) return ''
      // While dictation is paused the shortcut is off, and the menu's item is what fetches it.
      return local.pausedUntil
        ? 'Unpasted dictation. Paste Last Dictation is in the menu bar menu.'
        : 'Unpasted dictation. Command Control V to paste.'
    case 'starting':
      // A normal start lasts a tenth of a second, and the "speak now" sound covers it.
      return state.slow ? 'Waiting for the microphone.' : ''
    case 'listening': {
      // Not said: the sound says "speak now", and a voice would be recorded with the dictation.
      if (!state.handsFree) return local.quiet ? `${noSound(local.microphone)}.` : ''
      const left = state.limitAt - local.now
      if (left > LAST_STRETCH_MS) return `Hands-free. Press ${local.keySpoken} to stop.`
      // In quarters of a minute, so that it is not said afresh every second.
      const seconds = Math.max(1, Math.ceil(left / SAID_EVERY_MS)) * (SAID_EVERY_MS / 1_000)
      return `${seconds} seconds left.`
    }
    case 'processing': {
      if (local.busy) return 'Still writing the last dictation.'
      const what =
        state.hint === 'loadingModel'
          ? 'Loading the speech model.'
          : state.hint === 'tidying'
            ? 'Tidying the text.'
            : // Said only when it takes longer than a second.
              state.long
              ? 'Writing the text.'
              : ''
      // From a second on, the pill offers Cancel, and so does the menu: a pointer is not
      // needed to stop it.
      return state.long ? `${what} Cancel Dictation is in the menu bar menu.` : what
    }
    case 'recovery': {
      let said = `${state.message}.`
      if (state.redo) said += ` ${state.redo} is in the menu bar menu.`
      if (state.canCopy) said += ' Command Control C copies it.'
      // What was said up to the limit was used as if the key had been released.
      if (state.stoppedAtLimit) said += ' Your text was pasted.'
      return said
    }
  }
}
