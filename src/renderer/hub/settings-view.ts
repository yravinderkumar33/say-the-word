import type { AppStatus, ModelKeep, SpeechState } from '@shared/ipc'
import { dictationKeyLabel, type DictationKey } from '@shared/keycodes'
import { microphoneName } from '@shared/microphone-name'

/** What the Settings page lists, worked out apart from the window so that it can be tested. */

export interface ShortcutRow {
  label: string
  caps: string[]
  /** Only the dictation key can be changed for now; the others are shown as they are. */
  changeable: boolean
}

/** The five shortcuts, as they are with this dictation key. */
export function shortcutRows(key: DictationKey): ShortcutRow[] {
  const cap = dictationKeyLabel(key)
  return [
    { label: 'Dictate (hold)', caps: [cap], changeable: true },
    { label: 'Hands-free', caps: key === 'fn' ? [cap, cap] : [cap, 'Space'], changeable: false },
    { label: 'Cancel', caps: ['esc'], changeable: false },
    { label: 'Paste last dictation', caps: ['⌘', '⌃', 'V'], changeable: false },
    { label: 'Copy last dictation', caps: ['⌘', '⌃', 'C'], changeable: false },
  ]
}

export interface MicrophoneRow {
  deviceId: string
  name: string
  connected: boolean
  /** A dictation would use this one now. */
  inUse: boolean
}

/** A microphone as the windows name it, by its place in a list when it has no name yet. */
function nameOf(label: string, index: number): string {
  // Names only become visible once the microphone has been allowed and opened once.
  return label ? microphoneName(label) : `Microphone ${index + 1}`
}

/** The value a microphone pop-up uses for "follow the system": a device id is never empty. */
export const SYSTEM_DEFAULT = ''

/** The choices of a microphone pop-up: the system's default, then each microphone the system offers. */
export function microphoneOptions(
  status: Pick<AppStatus, 'microphones'>,
): Array<{ value: string; label: string }> {
  return [
    { value: SYSTEM_DEFAULT, label: 'System default' },
    ...status.microphones.map((microphone, index) => ({
      value: microphone.deviceId,
      label: nameOf(microphone.label, index),
    })),
  ]
}

/**
 * The microphones in the order they are tried: first the ones the user has put in
 * order (also those not connected now, by the name they had), then the others the
 * system offers.
 */
export function microphoneRows(
  status: Pick<AppStatus, 'microphones' | 'microphoneOrder' | 'microphoneInUse'>,
): MicrophoneRow[] {
  const connected = new Map(status.microphones.map((item) => [item.deviceId, item]))
  const ranked = new Set(status.microphoneOrder.map((item) => item.deviceId))
  const row = (deviceId: string, label: string, index: number): MicrophoneRow => ({
    deviceId,
    name: nameOf(label, index),
    connected: connected.has(deviceId),
    inUse: status.microphoneInUse === deviceId,
  })
  return [
    ...status.microphoneOrder.map((item, index) =>
      row(item.deviceId, connected.get(item.deviceId)?.label || item.label, index),
    ),
    ...status.microphones
      .filter((item) => !ranked.has(item.deviceId))
      .map((item, index) => row(item.deviceId, item.label, status.microphoneOrder.length + index)),
  ]
}

/** A list with one of its items moved to another place. */
export function moved<Item>(list: readonly Item[], from: number, to: number): Item[] {
  const next = [...list]
  const [item] = next.splice(from, 1)
  if (item === undefined) return next
  next.splice(Math.min(next.length, Math.max(0, to)), 0, item)
  return next
}

/** Said under the Ollama address when the main process could not be asked to change it. */
export const ADDRESS_NOT_SAVED = 'The address could not be saved.'

export const MODEL_KEEPS: ReadonlyArray<{ value: ModelKeep; label: string }> = [
  { value: 'tenMinutes', label: '10 minutes' },
  { value: 'hour', label: '1 hour' },
  { value: 'always', label: 'Always' },
]

/** Whether the speech model is in memory, in a word. */
export function modelState(speech: { state: SpeechState; modelDownloaded: boolean }): {
  word: string
  loaded: boolean
} {
  if (speech.state === 'ready') return { word: 'Loaded', loaded: true }
  if (speech.state === 'loading') return { word: 'Loading…', loaded: false }
  if (speech.state === 'failed') return { word: 'Could not start', loaded: false }
  if (!speech.modelDownloaded) return { word: 'Not downloaded', loaded: false }
  // Let go after a while without dictation, and loaded again on the next one.
  return { word: 'Resting', loaded: false }
}
