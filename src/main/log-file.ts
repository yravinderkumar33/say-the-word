import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { format } from 'node:util'

/** The file is started afresh when it reaches this size; the one before it is kept. */
const MAX_BYTES = 1_000_000

/**
 * The app's log on disk.
 *
 * Everything the app prints goes to the terminal that started it, and an app opened
 * from Finder has no terminal. Without a file, "it did not paste" leaves nothing to
 * look at afterwards. The file holds the same lines the terminal would show: key
 * events, states, which app a dictation went to, and why a paste was refused. It
 * never holds what was said.
 *
 * Lines are written synchronously. There are a handful per dictation, and a line
 * written this way is on disk even if the app stops right after it.
 */
export class LogFile {
  private bytes: number

  constructor(
    readonly path: string,
    private readonly maxBytes = MAX_BYTES,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.bytes = sizeOf(path)
  }

  /** The file the current one is moved to when it is full. */
  get previousPath(): string {
    return join(dirname(this.path), 'main.old.log')
  }

  write(text: string): void {
    const stamp = timestamp(this.now())
    // One entry may span lines (an error with its stack); each gets the time.
    const entry = text
      .split('\n')
      .map((line) => `${stamp} ${line}\n`)
      .join('')
    if (this.bytes > 0 && this.bytes + Buffer.byteLength(entry) > this.maxBytes) {
      try {
        renameSync(this.path, this.previousPath)
      } catch {
        // The file is gone (someone moved or deleted it): there is nothing to keep.
      }
      this.bytes = 0
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, entry)
      this.bytes += Buffer.byteLength(entry)
    } catch {
      // A log that cannot be written must never take the app down with it. This line
      // is lost; the next one is tried again, because the cause may have passed.
    }
  }
}

/**
 * Sends everything printed with `console.log` and `console.error` to the file as
 * well. Returns a function that undoes it.
 */
export function mirrorConsoleTo(file: LogFile): () => void {
  const original = { log: console.log, error: console.error, warn: console.warn }
  const mirror =
    (print: (...args: unknown[]) => void, prefix: string) =>
    (...args: unknown[]): void => {
      print(...args)
      file.write(prefix + format(...args))
    }
  console.log = mirror(original.log, '')
  console.warn = mirror(original.warn, 'warning: ')
  console.error = mirror(original.error, 'error: ')
  return () => {
    console.log = original.log
    console.warn = original.warn
    console.error = original.error
  }
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/** Local time, to the millisecond: `2026-10-03 22:07:05.142`. */
function timestamp(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.` +
    pad(date.getMilliseconds(), 3)
  )
}
