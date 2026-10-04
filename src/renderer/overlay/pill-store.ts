import type { PillState } from '@shared/ipc'
import { playCue } from './sounds'

/**
 * What the pill shows, kept outside React so the subscription to the main process is
 * made exactly once, and so sounds follow state changes whether or not anything renders.
 */
let state: PillState = { kind: 'resting' }
const listeners = new Set<() => void>()

/** Loudness of the microphone, 0 to 1. Read every animation frame; never triggers a render. */
let level = 0

/**
 * A click this soon after the pill changed what it shows is ignored. Each change puts
 * a different button where the last one was: the second click of a double-click on
 * Stop would land on Cancel, and one on Cancel would land on Undo and paste the text
 * that had just been cancelled.
 */
export const CLICK_GUARD_MS = 350
let changedAt = Number.NEGATIVE_INFINITY

/** True once the pill has shown the same thing for long enough to be clicked on purpose. */
export function acceptsClicks(now: number = performance.now()): boolean {
  return now - changedAt >= CLICK_GUARD_MS
}

/** What decides where the buttons are: the state, and for a message, its words. */
function layoutOf(pill: PillState): string {
  if (pill.kind === 'listening') return `listening:${pill.handsFree}`
  if (pill.kind === 'recovery') return `recovery:${pill.message}`
  return pill.kind
}

export function setLevel(next: number): void {
  level = next
}

export function getLevel(): number {
  return level
}

export function getPillState(): PillState {
  return state
}

export function subscribeToPill(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function initPillStore(): void {
  window.flow.onPillState((next) => {
    const previous = state
    state = next
    if (layoutOf(previous) !== layoutOf(next)) changedAt = performance.now()
    soundFor(previous, next)
    for (const listener of listeners) listener()
  })
  window.flow.onPillCue((cue) => {
    // A minute before a long recording is stopped, the same sound as any other notice.
    playCue(cue === 'busy' ? 'busy' : 'notice')
  })
}

function soundFor(previous: PillState, next: PillState): void {
  if (next.kind === 'listening' && previous.kind === 'listening') {
    // Still listening, but now with no key held.
    if (next.handsFree && !previous.handsFree) playCue('lock')
    return
  }
  if (next.kind === 'recovery' && previous.kind === 'recovery') {
    // One message taking the place of another: an alert still has to be heard.
    if (next.sound && next.message !== previous.message) playCue('notice')
    return
  }
  if (next.kind === previous.kind) return
  // The start sound means "speak now", so it waits until audio is actually flowing.
  if (next.kind === 'listening') playCue('start')
  else if (next.kind === 'processing' && previous.kind !== 'recovery') playCue('stop')
  else if (next.kind === 'recovery' && next.sound) playCue('notice')
}
