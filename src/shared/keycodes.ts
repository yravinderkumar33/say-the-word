/** macOS virtual key codes used in shortcuts. */
export const KEY = {
  fn: 63,
  space: 49,
  leftCommand: 55,
  rightCommand: 54,
  leftControl: 59,
  rightControl: 62,
  leftOption: 58,
  rightOption: 61,
  c: 8,
  v: 9,
} as const

export type BindingId = 'ptt' | 'handsFree' | 'pasteLast' | 'copyLast'

export interface BindingConfig {
  id: BindingId
  /** Each chord is the exact set of keys that triggers the binding. */
  chords: number[][]
}

/**
 * The key that starts a dictation. `fn` is the key with the globe on newer keyboards;
 * `ctrlOption` is for keyboards without one, and for when another app has taken `Fn`.
 */
export type DictationKey = 'fn' | 'ctrlOption'
export const DICTATION_KEYS: readonly DictationKey[] = ['fn', 'ctrlOption']

/** Left and right keys are different key codes, so chords list both where either should work. */
function withEitherCommandAndControl(key: number): number[][] {
  return [
    [KEY.leftCommand, KEY.leftControl, key],
    [KEY.rightCommand, KEY.leftControl, key],
    [KEY.leftCommand, KEY.rightControl, key],
    [KEY.rightCommand, KEY.rightControl, key],
  ]
}

/** Control and Option held together, whichever of each: with `extra` keys added to every pair. */
function controlAndOption(...extra: number[]): number[][] {
  return [KEY.leftControl, KEY.rightControl].flatMap((control) =>
    [KEY.leftOption, KEY.rightOption].map((option) => [control, option, ...extra]),
  )
}

/**
 * The shortcut table for a dictation key. Paste-last and copy-last are the same for
 * both. Command Mode (Fn+Ctrl) joins this table when that feature arrives.
 */
export function bindingsFor(key: DictationKey): BindingConfig[] {
  const dictation: BindingConfig[] =
    key === 'fn'
      ? [
          { id: 'ptt', chords: [[KEY.fn]] },
          // Space while Fn is held locks the recording on. The helper swallows that Space.
          { id: 'handsFree', chords: [[KEY.fn, KEY.space]] },
        ]
      : [
          { id: 'ptt', chords: controlAndOption() },
          { id: 'handsFree', chords: controlAndOption(KEY.space) },
        ]
  return [
    ...dictation,
    { id: 'pasteLast', chords: withEitherCommandAndControl(KEY.v) },
    { id: 'copyLast', chords: withEitherCommandAndControl(KEY.c) },
  ]
}

/** The dictation key as it is printed on the keyboard: what a keycap in the window shows. */
export function dictationKeyLabel(key: DictationKey): string {
  return key === 'fn' ? 'Fn' : '⌃⌥'
}

/** The dictation key as it is said aloud, for VoiceOver. */
export function dictationKeySpoken(key: DictationKey): string {
  return key === 'fn' ? 'Fn' : 'Control Option'
}

/**
 * A key or a group of keys as it is said aloud: VoiceOver would read `Fn` letter by
 * letter and `⌘⌃V` as symbols.
 */
export function spokenKeys(caps: readonly string[]): string {
  return caps
    .map((cap) => SPOKEN[cap] ?? cap)
    .join(' ')
    .trim()
}

const SPOKEN: Record<string, string> = {
  Fn: 'Fn key',
  '⌃⌥': 'Control Option',
  '⌘': 'Command',
  '⌃': 'Control',
  '⌥': 'Option',
  '⇧': 'Shift',
  esc: 'Escape',
  Space: 'Space',
}
