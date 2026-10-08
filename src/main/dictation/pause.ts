/**
 * "Pause dictation for an hour": every shortcut is off until then, for a game or a
 * presentation in which the key means something else. It ends by itself, or when the
 * user resumes.
 *
 * Kept in memory only: an app that is started again is not paused.
 */
export interface PauseDeps {
  now(): number
  /** Called with the time the pause ends, and with null when it is over. */
  onChange(until: number | null): void
  setTimer?(run: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
}

export const PAUSE_MS = 60 * 60_000

export class Pause {
  private endsAt: number | null = null
  private timer: unknown = null

  constructor(private readonly deps: PauseDeps) {}

  /** When the pause ends, in milliseconds since the epoch; null while there is none. */
  get until(): number | null {
    return this.endsAt
  }

  get active(): boolean {
    return this.endsAt !== null
  }

  /** Starts a pause, or starts the one that is running over again. */
  start(ms: number = PAUSE_MS): void {
    this.endsAt = this.deps.now() + ms
    this.arm(ms)
    this.deps.onChange(this.endsAt)
  }

  /**
   * Holds the pause to the time it was said to end, which the windows show. A timer does
   * not count the time the Mac sleeps: after a wake the pause may be over already, or due
   * sooner than its timer says. Also called when the timer runs, early or not.
   */
  recheck(): void {
    if (this.endsAt === null) return
    const left = this.endsAt - this.deps.now()
    if (left > 0) this.arm(left)
    else this.end()
  }

  end(): void {
    if (this.endsAt === null) return
    this.clear()
    this.endsAt = null
    this.deps.onChange(null)
  }

  private arm(ms: number): void {
    this.clear()
    const setTimer = this.deps.setTimer ?? ((run, wait) => setTimeout(run, wait))
    this.timer = setTimer(() => {
      this.timer = null
      this.recheck()
    }, ms)
  }

  private clear(): void {
    if (this.timer === null) return
    const clearTimer = this.deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))
    clearTimer(this.timer)
    this.timer = null
  }
}

/** A time of day as the windows and the menu say it: `11:42`. */
export function clockTime(time: number): string {
  const date = new Date(time)
  const two = (value: number): string => String(value).padStart(2, '0')
  return `${two(date.getHours())}:${two(date.getMinutes())}`
}
