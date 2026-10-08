/** A name longer than this is shortened in the middle, where it says least. */
const LONGEST_NAME = 28

/**
 * A microphone's name as the windows say it. The system's label carries things that
 * are not part of the name: "Default - " in front of whichever one is the default, and
 * a bracket at the end with how it is connected or its hardware ids.
 *
 * `MacBook Pro Microphone (Built-in)` becomes `MacBook Pro Microphone`.
 */
export function microphoneName(label: string): string {
  const name = label
    .replace(/^Default - /, '')
    .replace(/\s*\([^()]*\)\s*$/, '')
    .trim()
  return shortenInTheMiddle(name || label.trim(), LONGEST_NAME)
}

/** Keeps both ends of a long name, which is where one microphone differs from another. */
export function shortenInTheMiddle(text: string, longest: number): string {
  if (text.length <= longest) return text
  const kept = longest - 1
  const head = Math.ceil(kept / 2)
  return `${text.slice(0, head).trimEnd()}…${text.slice(text.length - (kept - head)).trimStart()}`
}
