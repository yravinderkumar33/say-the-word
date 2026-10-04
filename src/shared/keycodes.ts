/** macOS virtual key codes used in shortcuts. */
export const KEY = {
  fn: 63,
  space: 49,
  escape: 53,
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

/** Left and right keys are different key codes, so chords list both where either should work. */
function withEitherCommandAndControl(key: number): number[][] {
  return [
    [KEY.leftCommand, KEY.leftControl, key],
    [KEY.rightCommand, KEY.leftControl, key],
    [KEY.leftCommand, KEY.rightControl, key],
    [KEY.rightCommand, KEY.rightControl, key],
  ]
}

/**
 * The same defaults as Wispr Flow on macOS. Command Mode (Fn+Ctrl) joins this table
 * when that feature arrives.
 */
export const DEFAULT_BINDINGS: BindingConfig[] = [
  { id: 'ptt', chords: [[KEY.fn]] },
  // Space while Fn is held locks the recording on. The helper swallows that Space.
  { id: 'handsFree', chords: [[KEY.fn, KEY.space]] },
  { id: 'pasteLast', chords: withEitherCommandAndControl(KEY.v) },
  { id: 'copyLast', chords: withEitherCommandAndControl(KEY.c) },
]
