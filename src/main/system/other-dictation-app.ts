import { execFile } from 'node:child_process'

/**
 * Other apps that listen to the `Fn` key for dictation. Two apps on one key both start
 * at once, and each swallows presses meant for the other.
 *
 * The list holds only what has been seen to do so on a Mac this app was developed on.
 */
const KNOWN: ReadonlyArray<{ name: string; executable: string }> = [
  { name: 'Wispr Flow', executable: '/Wispr Flow.app/Contents/MacOS/Wispr Flow' },
]

/** The name of a known dictation app among these running programs (one path per line), or null. */
export function findDictationApp(processes: string): string | null {
  const running = processes.split('\n').map((line) => line.trim())
  return KNOWN.find((app) => running.some((path) => path.endsWith(app.executable)))?.name ?? null
}

const LOOK_EVERY_MS = 3_000

/**
 * Looks, now and then, for another dictation app among the running programs. It reads
 * their paths only. The answer is a few seconds old at most while someone is asking.
 */
export class OtherDictationApp {
  private found: string | null = null
  private lookedAt = Number.NEGATIVE_INFINITY
  private looking = false

  constructor(
    private readonly listProcesses: () => Promise<string> = runningPrograms,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** What was found when last looked. Asking starts another look when that is a while ago. */
  current(): string | null {
    if (!this.looking && this.now() - this.lookedAt >= LOOK_EVERY_MS) void this.look()
    return this.found
  }

  /** For tests, and for a debug command: says what is running without looking. */
  pretend(name: string | null): void {
    this.found = name
    this.lookedAt = Number.POSITIVE_INFINITY
  }

  private async look(): Promise<void> {
    this.looking = true
    try {
      this.found = findDictationApp(await this.listProcesses())
    } catch {
      // Not knowing is not a conflict.
      this.found = null
    } finally {
      this.lookedAt = this.now()
      this.looking = false
    }
  }
}

function runningPrograms(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', ['-axo', 'comm='], { maxBuffer: 4_000_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    )
  })
}
