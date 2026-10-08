import type { OverlayPrefs, PillState } from '@shared/ipc'
import { DEFAULT_OVERLAY_PREFS } from '@shared/ipc-values'
import { layoutOf, pillView, type PillSenses } from './pill-view'
import { playCue, type Cue } from './sounds'

/**
 * What the pill shows, kept outside React so the subscription to the main process is
 * made exactly once, and so sounds follow state changes whether or not anything renders.
 */
let state: PillState = { kind: 'resting', waiting: false }
const listeners = new Set<() => void>()

/** Loudness of the microphone, 0 to 1. Read every animation frame; never triggers a render. */
let level = 0

/** What only this page knows about the dictation in hand. */
let senses: PillSenses = { busy: false, quiet: false, microphone: null }

/** The settings this page acts on, as the main process last sent them. */
let prefs: OverlayPrefs = DEFAULT_OVERLAY_PREFS

export function getPillPrefs(): OverlayPrefs {
  return prefs
}

/** Plays a cue, if sounds are on, as loud as the setting says. */
function sound(cue: Cue): void {
  if (prefs.sounds) playCue(cue, prefs.volume)
}

/**
 * A click this soon after the pill changed what it shows is ignored. Each change puts
 * a different button where the last one was: the second click of a double-click on
 * Stop would land on Cancel, and one on Cancel would land on Undo and paste the text
 * that had just been cancelled.
 */
export const CLICK_GUARD_MS = 350
let changedAt = Number.NEGATIVE_INFINITY

/** How long the pill says that the last dictation is still being worked on. */
export const BUSY_MS = 1_600
let busyTimer: ReturnType<typeof setTimeout> | null = null

/**
 * A microphone that has given nothing louder than this since it went live is not
 * hearing anything: it is muted, or it is the wrong one. That is silence in the
 * signal itself, far below a quiet room: recordings of nobody speaking averaged
 * about -57 dB on the development Mac, and this is about -76 dB.
 */
export const QUIET_LEVEL = 0.001
/** How long that has to last before the pill says so. */
export const QUIET_AFTER_MS = 3_000
let heard = false
let quietTimer: ReturnType<typeof setTimeout> | null = null

/** True once the pill has shown the same thing for long enough to be clicked on purpose. */
export function acceptsClicks(now: number = performance.now()): boolean {
  return now - changedAt >= CLICK_GUARD_MS
}

/** The pill has just put its buttons somewhere else: clicks wait a moment. */
export function noteLayoutChange(): void {
  changedAt = performance.now()
}

/**
 * Where the buttons are for a state: worked out from what the pill draws for it, as the
 * pill itself does, before the pointer has rested on it. The clock and the name of the
 * key do not move anything.
 */
function layoutFor(pill: PillState): string {
  return layoutOf(
    pillView(pill, {
      ...senses,
      hover: false,
      now: 0,
      key: '',
      keySpoken: '',
      atRest: prefs.pillAtRest,
      pausedUntil: null,
    }),
  )
}

export function setLevel(next: number): void {
  level = next
  if (heard || next < QUIET_LEVEL) return
  heard = true
  clearQuietTimer()
  sense({ quiet: false })
}

export function getLevel(): number {
  return level
}

/** The microphone that was opened for the dictation in hand. */
export function setMicrophone(label: string | null): void {
  sense({ microphone: label })
}

export function getPillState(): PillState {
  return state
}

export function getPillSenses(): PillSenses {
  return senses
}

export function subscribeToPill(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

/** Changes what this page knows, and says so only when it is news. */
function sense(change: Partial<PillSenses>): void {
  const next = { ...senses, ...change }
  if (
    next.busy === senses.busy &&
    next.quiet === senses.quiet &&
    next.microphone === senses.microphone
  ) {
    return
  }
  senses = next
  notify()
}

export function initPillStore(): void {
  window.flow.onPillState((next) => {
    const previous = state
    state = next
    if (layoutFor(previous) !== layoutFor(next)) noteLayoutChange()
    soundFor(previous, next)
    follow(previous, next)
    notify()
  })
  window.flow.onPrefs((next) => {
    prefs = next
    notify()
  })
  window.flow.onPillCue((cue) => {
    if (cue === 'limitSoon') {
      // A minute before a long recording is stopped, the same sound as any other notice.
      sound('notice')
      return
    }
    sound('busy')
    if (state.kind !== 'processing') return
    // The pill says it in words too, for a moment, and gives a small shake.
    if (busyTimer) clearTimeout(busyTimer)
    busyTimer = setTimeout(() => sense({ busy: false }), BUSY_MS)
    sense({ busy: true })
  })
}

const isRecording = (pill: PillState): boolean =>
  pill.kind === 'starting' || pill.kind === 'listening'

/** Keeps what this page senses in step with the state: each belongs to one part of a dictation. */
function follow(previous: PillState, next: PillState): void {
  if (next.kind !== 'processing' && senses.busy) {
    if (busyTimer) clearTimeout(busyTimer)
    busyTimer = null
    senses = { ...senses, busy: false }
  }
  // A new recording: nothing has been heard yet.
  if (isRecording(next) && !isRecording(previous)) heard = false
  if (next.kind === 'listening' && previous.kind !== 'listening') {
    clearQuietTimer()
    if (!heard) {
      quietTimer = setTimeout(() => {
        quietTimer = null
        if (!heard) sense({ quiet: true })
      }, QUIET_AFTER_MS)
    }
  }
  if (next.kind !== 'listening') {
    clearQuietTimer()
    if (senses.quiet) senses = { ...senses, quiet: false }
  }
}

function clearQuietTimer(): void {
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = null
}

function soundFor(previous: PillState, next: PillState): void {
  if (next.kind === 'listening' && previous.kind === 'listening') {
    // Still listening, but now with no key held.
    if (next.handsFree && !previous.handsFree) sound('lock')
    return
  }
  if (next.kind === 'recovery' && previous.kind === 'recovery') {
    // One message taking the place of another: an alert still has to be heard.
    if (next.sound && next.message !== previous.message) sound('notice')
    return
  }
  if (next.kind === previous.kind) return
  // The start sound means "speak now", so it waits until audio is actually flowing.
  if (next.kind === 'listening') sound('start')
  else if (next.kind === 'processing' && previous.kind !== 'recovery') sound('stop')
  else if (next.kind === 'recovery' && next.sound) sound('notice')
}
