/** A size on disk as a person reads it: `84 KB`, `1.2 MB`, `671 MB`, `1.9 GB`. */
export function bytes(count: number): string {
  // Rounded before the unit is chosen: 999,500 bytes is 1 MB, never 1000 KB.
  const rounded = Math.round(count)
  if (rounded < 1_000) return rounded === 1 ? '1 byte' : `${rounded} bytes`
  const kilobytes = Math.round(rounded / 1_000)
  if (kilobytes < 1_000) return `${kilobytes} KB`
  const megabytes = trim(rounded / 1_000_000)
  if (megabytes < 1_000) return `${megabytes} MB`
  return `${trim(rounded / 1_000_000_000)} GB`
}

/** One decimal under ten, none above: `1.2`, `7`, `84`. */
function trim(value: number): number {
  return value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
}

/** A duration in seconds, to two places under a second and one above: `0.43 s`, `1.1 s`. */
export function seconds(ms: number): string {
  return `${(ms / 1_000).toFixed(ms < 995 ? 2 : 1)} s`
}

/** The length of a recording as a clock shows it: `0:06`, `12:40`. */
export function clockLength(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

const whole = new Intl.NumberFormat('en-GB')

/** A whole number as the window writes it: `1,284`. */
export function wholeNumber(value: number): string {
  return whole.format(value)
}

/** A count with its noun: `1 dictation`, `412 dictations`, `1,284 words`. */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${wholeNumber(count)} ${count === 1 ? one : many}`
}

/** A time of day: `10:42`. */
export function timeOfDay(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}
