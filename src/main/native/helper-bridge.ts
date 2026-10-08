import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { ZodType } from 'zod'
import {
  helperEventSchema,
  helperMessageSchema,
  helperReadySchema,
  installTapResultSchema,
  pasteResultSchema,
  permissionsResultSchema,
  targetResultSchema,
  type HelperEvent,
  type HelperReady,
  type HelperReply,
  type HelperRequest,
  type InstallTapResult,
  type PasteResult,
  type PermissionsResult,
  type TargetResult,
} from '@shared/helper-protocol'
import { createLineSplitter } from '@shared/jsonl'
import type { BindingConfig } from '@shared/keycodes'

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface HelperBridgeEvents {
  ready: [HelperReady]
  event: [HelperEvent]
  /** The helper process ended. It is restarted automatically unless `stop()` was called. */
  exit: [code: number | null]
}

const RESTART_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000]
/**
 * A paste gets longer to answer than other requests. Before it presses the keys the
 * helper reads the destination again (each read may wait 0.3 s on a busy app) and
 * saves the clipboard, which can wait on whichever app put something there.
 */
const PASTE_TIMEOUT_MS = 6_000
/**
 * How long after it was asked for a paste may still be carried out. The request tells
 * the helper the moment, and the helper does nothing to the clipboard or the keyboard
 * after it. Without this, a paste held up past the timeout above would be reported as a
 * failure and then land anyway, and whoever pasted again by hand would get the text
 * twice. It ends well before the timeout, so that the answer to a paste begun at the
 * last moment still arrives in time.
 */
export const PASTE_EXPIRY_MS = 4_000
/** How long after a paste the helper puts the old clipboard back. */
export const RESTORE_DELAY_MS = 500
/** How long a helper gets to leave by itself once its input has been closed. */
const EXIT_GRACE_MS = 2_000
/** After this long without a crash, the next restart starts from the shortest delay again. */
const STABLE_AFTER_MS = 60_000
/** The messages the helper sends on its own. One of these that does not parse is a mismatch. */
const MESSAGE_TYPES = new Set<string>([
  helperReadySchema.shape.type.value,
  ...helperEventSchema.options.map((option) => option.shape.type.value),
])
/** Why a request failed when its reply is in a shape this build does not know. */
const NOT_UNDERSTOOD = 'helper sent a reply this build does not understand'

export interface HelperBridgeOptions {
  /** Extra arguments for the helper process. Tests use this to run a stand-in. */
  args?: string[]
  /** Delay before each successive restart; the last value repeats. */
  restartDelaysMs?: number[]
  /** How long a helper gets to leave by itself once its input has been closed. */
  exitGraceMs?: number
}

/**
 * Runs the Swift helper as a child process and talks to it in JSON lines over stdio.
 *
 * The helper exits on its own when its stdin closes, so it cannot outlive the app.
 * If it dies unexpectedly it is restarted with a growing delay, and the shortcut
 * table is sent again once it is ready.
 */
export class HelperBridge extends EventEmitter<HelperBridgeEvents> {
  private child: ChildProcessWithoutNullStreams | null = null
  private readyInfo: HelperReady | null = null
  private nextRequestId = 1
  private nextPasteId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private bindings: BindingConfig[] | null = null
  private stopped = false
  /** True while the helper is being replaced on purpose, by `restart()`. */
  private replacing = false
  private restartTimer: NodeJS.Timeout | null = null
  private restartAttempt = 0
  private startedAt = 0
  /** Kinds of message already said in the log to be in a shape this build does not know. */
  private readonly misunderstood = new Set<string>()

  private readonly args: string[]
  private readonly restartDelaysMs: number[]
  private readonly exitGraceMs: number

  constructor(
    private readonly binaryPath: string,
    options: HelperBridgeOptions = {},
  ) {
    super()
    this.args = options.args ?? []
    this.restartDelaysMs = options.restartDelaysMs ?? RESTART_DELAYS_MS
    this.exitGraceMs = options.exitGraceMs ?? EXIT_GRACE_MS
  }

  get running(): boolean {
    return this.child !== null
  }

  /** The helper's `ready` message, or null until it has arrived. */
  get ready(): HelperReady | null {
    return this.readyInfo
  }

  start(): void {
    if (this.child) return
    this.stopped = false
    this.startedAt = Date.now()
    const child = spawn(this.binaryPath, this.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on(
      'data',
      createLineSplitter((line) => {
        // Node can hand over a helper's last output after its exit: a key press from a
        // helper that has gone must not start a session after the exit has ended one.
        if (this.child === child) this.handleLine(line)
      }),
    )
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => console.error(`[flow-helper] ${text.trimEnd()}`))
    child.stdin.on('error', () => {
      // The helper went away mid-write; `exit` reports it.
    })
    child.once('error', (error) => {
      console.error(`[flow-helper] failed to start: ${error.message}`)
      this.handleExit(child, null)
    })
    child.once('exit', (code) => this.handleExit(child, code))
  }

  /**
   * Replaces the running helper with a fresh process, at once.
   *
   * macOS answers some permission questions once per process and remembers the answer:
   * a helper that asked "may I post key events?" before Accessibility was granted goes
   * on hearing "no" for as long as it lives. A new process asks again.
   */
  restart(): void {
    if (this.stopped) return
    const child = this.child
    if (!child) {
      if (this.restartTimer) clearTimeout(this.restartTimer)
      this.restartTimer = null
      this.start()
      return
    }
    this.replacing = true
    child.stdin.end()
    this.endIfStillRunning(child)
  }

  /**
   * A helper leaves when its input closes. One that is stuck does not notice, and
   * would hold its place (and its key tap) for good, so it is ended after a moment.
   */
  private endIfStillRunning(child: ChildProcessWithoutNullStreams): void {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, this.exitGraceMs)
    timer.unref()
    child.once('exit', () => clearTimeout(timer))
  }

  /** Ends the helper at once. For when the app is quitting and cannot wait for it. */
  kill(): void {
    this.stopped = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.child?.kill('SIGKILL')
  }

  /** Stops the helper for good. It exits when its stdin closes. */
  stop(): void {
    this.stopped = true
    this.replacing = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    if (!child) return
    child.stdin.end()
    this.endIfStillRunning(child)
  }

  whenReady(timeoutMs = 5_000): Promise<HelperReady> {
    if (this.readyInfo) return Promise.resolve(this.readyInfo)
    return new Promise((resolve, reject) => {
      const onReady = (info: HelperReady): void => {
        cleanup()
        resolve(info)
      }
      const onExit = (): void => {
        cleanup()
        reject(new Error('helper exited before it was ready'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`helper was not ready within ${timeoutMs} ms`))
      }, timeoutMs)
      const cleanup = (): void => {
        clearTimeout(timer)
        this.off('ready', onReady)
        this.off('exit', onExit)
      }
      this.once('ready', onReady)
      this.once('exit', onExit)
    })
  }

  // --- Requests -------------------------------------------------------------------

  ping(): Promise<{ pong: boolean }> {
    return this.request('ping')
  }

  /**
   * Sets the shortcut table. It is sent now if the helper is ready, and again every
   * time the helper (re)starts.
   */
  setBindings(bindings: BindingConfig[]): void {
    this.bindings = bindings
    if (this.readyInfo) this.sendBindings()
  }

  async armEscape(armed: boolean): Promise<void> {
    await this.request('armEscape', { armed })
  }

  /** Creates the key event tap. Fails quietly (tapInstalled false) without Accessibility. */
  async installTap(): Promise<InstallTapResult> {
    return this.parseReply('installTap', installTapResultSchema, await this.request('installTap'))
  }

  /** Records where a paste may go: the focused app, window and element right now. */
  async captureTarget(): Promise<TargetResult> {
    return this.parseReply('captureTarget', targetResultSchema, await this.request('captureTarget'))
  }

  /**
   * Pastes into the recorded destination, or refuses if focus has moved since. A paste
   * the helper cannot get to in time is not carried out late: see `PASTE_EXPIRY_MS`.
   */
  async paste(request: { text: string; targetId: number }): Promise<PasteResult> {
    const pasteId = this.nextPasteId++
    const result = await this.request(
      'paste',
      {
        // A lone half of a surrogate pair makes the helper's JSON reader drop the whole
        // line, and the paste would wait out its time for nothing. It becomes U+FFFD,
        // which is what `String.prototype.toWellFormed` does.
        text: request.text.replace(/\p{Surrogate}/gu, '\uFFFD'),
        targetId: request.targetId,
        pasteId,
        restoreDelayMs: RESTORE_DELAY_MS,
        expiresAt: Date.now() + PASTE_EXPIRY_MS,
      },
      PASTE_TIMEOUT_MS,
    )
    return this.parseReply('paste', pasteResultSchema, result)
  }

  async checkPermissions(): Promise<PermissionsResult> {
    return this.parseReply(
      'checkPermissions',
      permissionsResultSchema,
      await this.request('checkPermissions'),
    )
  }

  /** Shows the macOS prompt that leads the user to grant Accessibility. */
  async promptAccessibility(): Promise<boolean> {
    const result = (await this.request('promptAccessibility')) as { accessibilityTrusted?: unknown }
    return result.accessibilityTrusted === true
  }

  private request<T = unknown>(
    type: string,
    fields: Record<string, unknown> = {},
    timeoutMs = 3_000,
  ): Promise<T> {
    const child = this.child
    if (!child) return Promise.reject(new Error('helper is not running'))
    const id = this.nextRequestId++
    const message: HelperRequest = { ...fields, id, type }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`helper did not answer "${type}" within ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject, timer })
      child.stdin.write(`${JSON.stringify(message)}\n`)
    })
  }

  // --- Incoming -------------------------------------------------------------------

  private handleLine(line: string): void {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      return // Not JSON: stray output, ignored by design.
    }
    const parsed = helperMessageSchema.safeParse(json)
    if (!parsed.success) {
      this.reportMisunderstood(json)
      return
    }
    const message = parsed.data

    if (!('type' in message)) {
      this.settle(message)
    } else if (message.type === 'ready') {
      this.readyInfo = message
      this.sendBindings()
      this.emit('ready', message)
    } else {
      this.emit('event', message)
    }
  }

  /**
   * A message of a type this build knows, in a shape it does not: a helper from another
   * build. It is dropped, and said. A type this build does not know is dropped unsaid: a
   * newer helper may send it.
   */
  private reportMisunderstood(json: unknown): void {
    const type =
      typeof json === 'object' && json !== null ? (json as { type?: unknown }).type : null
    if (typeof type !== 'string' || !MESSAGE_TYPES.has(type)) return
    const schema: ZodType = type === 'ready' ? helperReadySchema : helperEventSchema
    this.sayMisunderstood(`a "${type}" message`, schema.safeParse(json).error?.issues ?? [])
  }

  /**
   * A reply as this build expects it. One in another shape fails in plain words: the
   * validator's own report, a page of JSON, would otherwise reach the pill and the history.
   */
  private parseReply<T>(type: string, schema: ZodType<T>, result: unknown): T {
    const parsed = schema.safeParse(result)
    if (parsed.success) return parsed.data
    this.sayMisunderstood(`the reply to "${type}"`, parsed.error.issues)
    throw new Error(NOT_UNDERSTOOD)
  }

  /**
   * Says in the log what this build did not understand, once for each kind of message
   * (a helper from another build sends the same ones again and again): the fields that
   * did not fit, and nothing of what they held.
   */
  private sayMisunderstood(what: string, issues: ReadonlyArray<{ path: PropertyKey[] }>): void {
    if (this.misunderstood.has(what)) return
    this.misunderstood.add(what)
    const fields = new Set(issues.map((issue) => issue.path.map(String).join('.') || 'all of it'))
    console.error(
      `[flow-helper] ${what} does not have the shape this build knows: ${[...fields].join(', ')}`,
    )
  }

  private sendBindings(): void {
    if (!this.bindings) return
    this.request('configure', { bindings: this.bindings }).catch((error: unknown) => {
      console.error('[flow-helper] could not set the shortcut table:', error)
    })
  }

  private settle(reply: HelperReply): void {
    const request = this.pending.get(reply.id)
    if (!request) return
    this.pending.delete(reply.id)
    clearTimeout(request.timer)
    if (reply.ok) {
      request.resolve(reply.result)
      return
    }
    // Said as the helper's, so that the pill puts it into plain words.
    request.reject(new Error(reply.error ? `helper: ${reply.error}` : 'helper reported an error'))
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== child) return
    this.child = null
    this.readyInfo = null
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('helper exited'))
    }
    this.pending.clear()
    const replacing = this.replacing
    this.replacing = false
    this.emit('exit', code)
    if (this.stopped) return
    if (replacing) this.start()
    else this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (Date.now() - this.startedAt >= STABLE_AFTER_MS) this.restartAttempt = 0
    const delays = this.restartDelaysMs
    const delay = delays[Math.min(this.restartAttempt, delays.length - 1)] ?? 30_000
    this.restartAttempt += 1
    console.error(`[flow-helper] exited; restarting in ${delay} ms`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopped) this.start()
    }, delay)
  }
}
