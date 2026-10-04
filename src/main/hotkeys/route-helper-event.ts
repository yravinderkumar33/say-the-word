import type { HelperEvent, TargetResult } from '@shared/helper-protocol'
import type { MachineEvent } from './session-machine'

/**
 * A log line for something the helper reported. It names the shortcut, never an
 * ordinary key: the helper does not report those in the first place.
 */
export function describeHelperEvent(event: HelperEvent): string {
  switch (event.type) {
    case 'bindingDown':
      return `[key] ${event.id} down`
    case 'bindingUp':
      return `[key] ${event.id} up${event.reason === 'released' ? '' : ` (${event.reason})`}`
    case 'interrupted':
      return `[key] another key was pressed while ${event.id} was held`
    case 'cancel':
      return '[key] escape'
    case 'tapState':
      return event.installed
        ? `[key] macOS switched the key tap off; it is back on (${event.reason})`
        : `[key] the key tap was taken down (${event.reason})`
    case 'pasteSettled':
      return `[paste] clipboard ${event.restored ? 'put back' : 'left as it is'}`
  }
}

/** A log line for a paste destination: which app, and what the helper could see of it. */
export function describeTarget(target: TargetResult): string {
  if (target.targetId === -1) return '[target] nothing is frontmost'
  const yesNo = (value: boolean | undefined): string =>
    value === undefined ? 'unknown' : value ? 'yes' : 'no'
  const secure = target.secure
    ? (target.secureReason ?? 'yes')
    : target.secureInputStuck
      ? 'no (Secure Input is stuck on, ignored)'
      : 'no'
  // An app with no bundle id is rare enough that its name is worth having.
  const app = target.bundleId ?? `unknown (${target.appName ?? 'no name'})`
  return (
    `[target] app=${app} element=${yesNo(target.hasElement)} ` +
    `window=${yesNo(target.hasWindow)} secure=${secure}`
  )
}

/**
 * Translates what the helper reports into the state machine's vocabulary.
 * Returns null for helper events that are not gestures (tap state, paste settled)
 * and for shortcuts this build does not act on.
 */
export function toMachineEvent(event: HelperEvent): MachineEvent | null {
  switch (event.type) {
    case 'bindingDown':
      if (event.id === 'ptt') return { type: 'pttDown', t: event.t }
      if (event.id === 'handsFree') return { type: 'handsFreeDown', t: event.t }
      if (event.id === 'pasteLast') return { type: 'pasteLast' }
      if (event.id === 'copyLast') return { type: 'copyLast' }
      return null
    case 'bindingUp':
      if (event.id !== 'ptt') return null
      // The tap lost track of the keyboard, so nobody knows whether Fn is still held.
      // Ending the session is the safe reading; treating it as a release could paste.
      return event.reason === 'released' ? { type: 'pttUp', t: event.t } : { type: 'abort' }
    case 'interrupted':
      return event.id === 'ptt' ? { type: 'interrupted' } : null
    case 'cancel':
      return { type: 'escape' }
    default:
      return null
  }
}
