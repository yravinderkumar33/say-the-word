import type { Microphone } from '@shared/ipc'
import type { Settings } from './store/settings'

/**
 * Which microphone a dictation uses.
 *
 * The user can put microphones in an order of preference; the first one that is
 * connected is used. With no order, the system's default microphone is followed, which
 * is what an app that has been told nothing should do.
 */

/** The order of preference in force. A settings file from before there was one names a single microphone. */
export function rankedMicrophones(
  settings: Pick<Settings, 'microphoneOrder' | 'microphoneId'>,
): Microphone[] {
  if (settings.microphoneOrder.length > 0) return settings.microphoneOrder
  return settings.microphoneId ? [{ deviceId: settings.microphoneId, label: '' }] : []
}

/**
 * The microphone to open, by device id; null for the system default.
 *
 * `connected` is what the system offers now. When that is not known yet (the list has
 * not arrived), the first preference is asked for anyway: the capture falls back to
 * the default by itself if it is not there.
 */
export function microphoneToUse(
  ranked: readonly Microphone[],
  connected: readonly Microphone[],
): string | null {
  if (ranked.length === 0) return null
  if (connected.length === 0) return ranked[0]?.deviceId ?? null
  const present = new Set(connected.map((microphone) => microphone.deviceId))
  return ranked.find((microphone) => present.has(microphone.deviceId))?.deviceId ?? null
}

/** The order with this microphone moved to the front, or added there. */
export function withFirst(ranked: readonly Microphone[], first: Microphone): Microphone[] {
  return [first, ...ranked.filter((microphone) => microphone.deviceId !== first.deviceId)]
}

/**
 * An order given as device ids, turned into one that can be saved: each with its name,
 * taken from what is connected, or else from what was remembered. An id that is
 * neither is dropped: a page cannot put anything else in the settings.
 */
export function orderFrom(
  deviceIds: readonly string[],
  ranked: readonly Microphone[],
  connected: readonly Microphone[],
): Microphone[] {
  const known = new Map<string, Microphone>()
  for (const microphone of [...ranked, ...connected]) {
    // What is connected has its name now; that one wins.
    if (microphone.label || !known.has(microphone.deviceId))
      known.set(microphone.deviceId, microphone)
  }
  const order: Microphone[] = []
  for (const deviceId of deviceIds) {
    const microphone = known.get(deviceId)
    if (microphone && !order.some((item) => item.deviceId === deviceId)) order.push(microphone)
  }
  return order
}

/**
 * The remembered names brought up to date from what is connected. Returns null when
 * nothing changed, so that nothing is written for no reason.
 */
export function withFreshNames(
  ranked: readonly Microphone[],
  connected: readonly Microphone[],
): Microphone[] | null {
  let changed = false
  const fresh = ranked.map((microphone) => {
    const now = connected.find((item) => item.deviceId === microphone.deviceId)
    if (!now?.label || now.label === microphone.label) return microphone
    changed = true
    return { ...microphone, label: now.label }
  })
  return changed ? fresh : null
}
