import { appendFileSync, mkdirSync, renameSync, rmSync, statSync, truncateSync } from 'node:fs'
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

  /** How much the log takes up on disk, the one before it included. */
  get bytesOnDisk(): number {
    return sizeOf(this.path) + sizeOf(this.previousPath)
  }

  /**
   * Deletes the log and the one before it. The next line starts a new file. Returns
   * false when a file could not be removed.
   */
  clear(): boolean {
    let removed = true
    for (const path of [this.path, this.previousPath]) {
      try {
        rmSync(path, { force: true })
      } catch {
        removed = false
      }
    }
    this.bytes = sizeOf(this.path)
    return removed
  }

  write(text: string): void {
    const stamp = timestamp(this.now())
    // One entry may span lines (an error with its stack); each gets the time.
    const entry = text
      .split('\n')
      .map((line) => `${stamp} ${line}\n`)
      .join('')
    if (this.bytes > 0 && this.bytes + Buffer.byteLength(entry) > this.maxBytes) this.rotate()
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      appendFileSync(this.path, entry)
      this.bytes += Buffer.byteLength(entry)
    } catch {
      // A log that cannot be written must never take the app down with it. This line
      // is lost; the next one is tried again, because the cause may have passed.
    }
  }

  /** Moves the full file aside, to start afresh. */
  private rotate(): void {
    try {
      renameSync(this.path, this.previousPath)
    } catch (error) {
      // The file is gone (someone moved or deleted it): there is nothing to keep. Anything
      // else is in the way of the old file: it is removed and the move tried again, and
      // failing that the file is emptied where it is. A folder is not removed: it is not
      // the log's.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        try {
          rmSync(this.previousPath, { force: true })
          renameSync(this.path, this.previousPath)
        } catch {
          try {
            truncateSync(this.path)
          } catch {
            // Neither: the file stays full, and the next line tries again.
          }
        }
      }
    }
    // Counted from what is there: started afresh only if the file really was moved or emptied.
    this.bytes = sizeOf(this.path)
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

/**
 * An error nobody expected, as the log may keep it: what kind it is and where it was
 * thrown, without its message. The message can quote what the failing code was given
 * (`JSON.parse` quotes the text it could not read), and that can be what someone said.
 */
export function kindAndPlace(error: unknown): string {
  if (!(error instanceof Error)) return `something that is not an error (${typeof error})`
  const frames = (error.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
  return [error.name, ...frames].join('\n    ')
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
