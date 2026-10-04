import { findRetractionCues, findSpokenCommands, splitWords } from '../text/words'
import { checkCleanup, hasLeftTheTranscript, type GuardReason } from './guard'
import {
  identityKey,
  type LocalModelIdentity,
  type LocalOnlyGate,
  type LocalVerdict,
} from './local-only'
import { NUM_CTX, OllamaError, type OllamaClient } from './ollama-client'
import { PROMPT_PREFIX, buildMessages, estimateTokens, promptTokens } from './prompts'
import { applyRules, type DictionaryEntry } from './rules'

/**
 * The most time cleanup may take, counted from the moment the transcript is ready.
 * It is fixed: it does not grow with the transcript. A dictation too long to clean
 * inside it gets the rules-only text.
 */
export const CLEANUP_CEILING_MS = 4_000

/** Why the final text is what it is. `cleaned` is the only one that used the model's text. */
export type CleanupNote =
  | 'cleaned'
  /** Four words or fewer with nothing to correct: not worth a model. */
  | 'short'
  /** The model could not have finished inside the ceiling, or the text does not fit its context. */
  | 'tooLong'
  | 'noModel'
  | `notLocal:${Exclude<LocalVerdict, { local: true }>['reason']}`
  | 'timeout'
  | 'unreachable'
  | 'failed'
  | 'cancelled'
  | `guard:${GuardReason}`

export interface Refined {
  /** The recognizer's text, untouched. */
  raw: string
  /** After the rules: hesitations and stutters removed, dictionary applied. */
  rules: string
  /** The model's text, when the guard accepted it. */
  cleaned: string | null
  /** What to paste: `cleaned`, or `rules` when there is no accepted model text. */
  final: string
  note: CleanupNote
  /** How long cleanup took, model included. */
  cleanupMs: number
}

export interface RefinerDeps {
  client: Pick<OllamaClient, 'chat' | 'warm' | 'url'>
  gate: Pick<LocalOnlyGate, 'check' | 'block' | 'sawRedirect'>
  /** The chosen model, or null when none is. */
  model(): string | null
  dictionary(): readonly DictionaryEntry[]
  now?(): number
  ceilingMs?: number
  /** How long a warm-up may take. For tests; defaults to `WARM_TIMEOUT_MS`. */
  warmTimeoutMs?: number
}

/** Room left in the context beyond the prompt and the reply. */
const CONTEXT_MARGIN = 64
/**
 * How long a reply from a model counts. While it does, the model is taken to be loaded
 * and to run where that reply said it does, and it is not warmed up again.
 */
const WARM_FOR_MS = 5 * 60_000
/** Repeated replacements must not keep cleanup chasing a moving model indefinitely. */
const IDENTITY_ATTEMPTS = 3
/**
 * A warm-up is given up on after this long. Loading a model from cold took 4.7 s on the
 * development machine; a server that accepts the request and then says nothing must not
 * be waited on for good.
 */
export const WARM_TIMEOUT_MS = 20_000

/**
 * Turns a raw transcript into the text to paste in Cleaned mode: rules first, then the
 * model under a deadline, then the guard. Whatever goes wrong with the model, the
 * rules-only text is the answer, and it is always on time.
 */
export class Refiner {
  // Starting values measured on the development machine; replaced by what is observed.
  private firstTokenMs = 600
  private tokensPerSecond = 23
  /** Positive replies, by verified server, canonical name and digest. */
  private readonly answered = new Map<string, number>()
  /** Warm-ups on their way, for the same verified identity only. */
  private readonly warming = new Map<string, { promise: Promise<void>; signal: AbortSignal }>()
  private readonly now: () => number
  private readonly ceilingMs: number
  private readonly warmTimeoutMs: number

  constructor(private readonly deps: RefinerDeps) {
    this.now = deps.now ?? (() => performance.now())
    this.ceilingMs = deps.ceilingMs ?? CLEANUP_CEILING_MS
    this.warmTimeoutMs = deps.warmTimeoutMs ?? WARM_TIMEOUT_MS
  }

  /**
   * Called when a dictation starts: has the model loaded and its instructions read
   * while the user is still speaking. A model that is not local is never contacted.
   */
  prewarm(): void {
    const model = this.deps.model()
    if (model) {
      void this.deps.gate.check(model).then(
        (verdict) => (verdict.local ? this.warmUp(verdict.identity) : undefined),
        () => {},
      )
    }
  }

  /**
   * Sends the model its instructions and nothing else, unless it has answered lately.
   * Resolves when that is over, however it ended; a warm-up of the same model on the
   * same server that is already on its way is joined, not repeated.
   *
   * The reply is the first thing the model itself says, and it can say that it came
   * from another machine although every list called the model local. If it does, the
   * model is blocked here and now. A server that answers with a redirect is set aside
   * the same way. Either way no transcript is sent: see `refine`.
   */
  private warmUp(identity: LocalModelIdentity, signal?: AbortSignal): Promise<void> {
    const key = identityKey(identity)
    if (identity.server !== this.deps.client.url || signal?.aborted) return Promise.resolve()
    if (this.hasAnswered(key)) return Promise.resolve()
    const underWay = this.warming.get(key)
    if (underWay && !underWay.signal.aborted) return underWay.promise

    const timeout = AbortSignal.timeout(this.warmTimeoutMs)
    const lifetime = signal ? AbortSignal.any([signal, timeout]) : timeout
    const promise = this.askForFirstReply(identity, key, lifetime).finally(() => {
      if (this.warming.get(key)?.promise === promise) this.warming.delete(key)
    })
    this.warming.set(key, { promise, signal: lifetime })
    return promise
  }

  private async askForFirstReply(
    identity: LocalModelIdentity,
    key: string,
    lifetime: AbortSignal,
  ): Promise<void> {
    try {
      if (identity.server !== this.deps.client.url || lifetime.aborted) return
      const reply = await this.deps.client.warm(identity.model, PROMPT_PREFIX, lifetime)
      if (!reply) return
      if (reply.redirected) this.deps.gate.sawRedirect(identity.server)
      else if (reply.remote) this.deps.gate.block(identity.model, identity.server)
      else if (!lifetime.aborted && identity.server === this.deps.client.url) {
        // A name may have been replaced while the warm-up was in flight. That reply
        // cannot approve the replacement, including when this was only a prewarm.
        const current = await within(
          this.deps.gate.check(identity.model),
          this.warmTimeoutMs,
          lifetime,
        )
        if (
          current?.local &&
          identityKey(current.identity) === key &&
          identity.server === this.deps.client.url &&
          !lifetime.aborted
        ) {
          this.answered.set(key, this.now())
        }
      }
    } catch {
      // A warm-up that fails teaches nothing, and nothing is sent on the strength of it.
    }
  }

  /** True while a reply from this model on this server, from this machine, still counts. */
  private hasAnswered(key: string): boolean {
    const at = this.answered.get(key)
    return at !== undefined && this.now() - at < WARM_FOR_MS
  }

  async refine(raw: string, signal: AbortSignal): Promise<Refined> {
    const started = this.now()
    const dictionary = this.deps.dictionary()
    const rules = applyRules(raw, dictionary)
    const done = (note: CleanupNote, cleaned: string | null = null): Refined => ({
      raw,
      rules,
      cleaned,
      final: cleaned ?? rules,
      note,
      cleanupMs: Math.round(this.now() - started),
    })

    const words = splitWords(rules)
    const nothingToCorrect =
      findRetractionCues(words).length === 0 && findSpokenCommands(words).length === 0
    if (words.length <= 4 && nothingToCorrect) return done('short')

    const model = this.deps.model()
    if (!model) return done('noModel')

    // The reply is about as long as the transcript. Can it be written in time?
    const vocabulary = dictionary.map((entry) => entry.to)
    const messages = buildMessages(rules, vocabulary)
    const expectedTokens = estimateTokens(rules)
    const numPredict = Math.ceil(expectedTokens * 1.3) + 24
    const writingMs = (expectedTokens / this.tokensPerSecond) * 1_000
    if (this.firstTokenMs + writingMs > this.ceilingMs) return done('tooLong')
    if (promptTokens(messages) + numPredict > NUM_CTX - CONTEXT_MARGIN) return done('tooLong')

    // Everything from here on, the waiting included, has to fit into this.
    const budgetMs = Math.min(1_000 + 1.5 * writingMs, this.ceilingMs)
    const left = (): number => budgetMs - (this.now() - started)
    const preparation = AbortSignal.timeout(Math.max(1, Math.ceil(left())))
    const lifetime = AbortSignal.any([signal, preparation])

    // The transcript is never the first thing a model is sent. Its first reply, to a
    // request that holds the instructions and nothing else, says where it really runs,
    // and until that reply has come from this machine nothing more is sent. Usually the
    // warm-up at key-down has settled this by now; if it is still on its way it is
    // waited for, and if there was none (the model was chosen during the dictation, or
    // this is an Undo long after) it is made now.
    let verdict = await within(this.deps.gate.check(model), left(), lifetime)
    if (signal.aborted) return done('cancelled')
    if (verdict === null) return done('timeout')
    let verified: LocalModelIdentity | null = null
    for (let attempt = 0; attempt < IDENTITY_ATTEMPTS; attempt += 1) {
      if (!verdict.local) return done(`notLocal:${verdict.reason}`)
      const identity = verdict.identity
      const key = identityKey(identity)
      if (identity.server !== this.deps.client.url) return done('failed')
      if (this.hasAnswered(key)) {
        verified = identity
        break
      }
      const settled = await within(
        this.warmUp(identity, lifetime).then(() => true),
        left(),
        lifetime,
      )
      if (signal.aborted) return done('cancelled')
      if (settled === null) return done('timeout')

      // Resolve the name again immediately before allowing any transcript. A changed
      // identity needs its own warm-up, within the time already reserved for cleanup.
      verdict = await within(this.deps.gate.check(model), left(), lifetime)
      if (signal.aborted) return done('cancelled')
      if (verdict === null) return done('timeout')
      if (!verdict.local) return done(`notLocal:${verdict.reason}`)
      if (identityKey(verdict.identity) !== key) {
        this.answered.delete(key)
        continue
      }
      if (!this.hasAnswered(key)) return done('failed')
      verified = verdict.identity
      break
    }
    if (!verified || verified.server !== this.deps.client.url) return done('failed')
    const key = identityKey(verified)

    const deadlineMs = left()
    if (deadlineMs <= 0 || lifetime.aborted) return done('timeout')
    // A whole number of milliseconds: the timer accepts nothing else.
    const deadline = AbortSignal.timeout(Math.ceil(deadlineMs))

    try {
      const reply = await this.deps.client.chat({
        model: verified.model,
        messages,
        numPredict,
        signal: AbortSignal.any([lifetime, deadline]),
        // Stop as soon as the reply has clearly left the transcript behind.
        onContent: (soFar) => !hasLeftTheTranscript(rules, soFar),
      })
      if (reply.remote) {
        // The reply says it came from another machine. It is discarded, and the model is not asked again.
        this.deps.gate.block(verified.model, verified.server)
        this.answered.delete(key)
        return done('notLocal:blocked')
      }
      // A reply from this machine: the model stays answered-for while it is in use.
      this.answered.set(key, this.now())
      if (reply.doneReason === 'abandoned') return done('guard:invented')
      this.learnSpeed(reply)

      const cleaned = reply.content.trim()
      const judged = checkCleanup({
        input: rules,
        output: cleaned,
        doneReason: reply.doneReason,
        vocabulary,
      })
      return judged.ok ? done('cleaned', cleaned) : done(`guard:${judged.reason}`)
    } catch (error) {
      if (signal.aborted) return done('cancelled')
      if (lifetime.aborted || deadline.aborted) return done('timeout')
      if (error instanceof OllamaError && error.kind === 'redirect') {
        // The server wanted the request taken somewhere else. It was not.
        this.deps.gate.sawRedirect(verified.server)
        return done('notLocal:redirected')
      }
      return done(
        error instanceof OllamaError && error.kind === 'unreachable' ? 'unreachable' : 'failed',
      )
    }
  }

  /** Remembers how fast this model really is, for the next "can it finish in time?". */
  private learnSpeed(reply: {
    firstTokenMs: number | null
    outputTokens: number | null
    generationMs: number | null
    loadMs: number | null
  }): void {
    // A request that had to load the model says nothing about the usual wait.
    if (reply.firstTokenMs !== null && (reply.loadMs ?? 0) < 200) {
      this.firstTokenMs = 0.7 * this.firstTokenMs + 0.3 * reply.firstTokenMs
    }
    if (reply.outputTokens && reply.generationMs && reply.outputTokens >= 8) {
      const measured = reply.outputTokens / (reply.generationMs / 1_000)
      this.tokensPerSecond = 0.7 * this.tokensPerSecond + 0.3 * measured
    }
  }
}

/**
 * Waits for a promise, but no longer than `ms`, and no longer than the session lives.
 * Resolves with its value, or null when the time ran out, the session ended, or the
 * promise failed. The promise itself is left to finish on its own.
 */
function within<Value>(
  promise: Promise<Value>,
  ms: number,
  signal: AbortSignal,
): Promise<Value | null> {
  if (ms <= 0 || signal.aborted) return Promise.resolve(null)
  return new Promise((resolve) => {
    const finish = (value: Value | null): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const onAbort = (): void => finish(null)
    const timer = setTimeout(() => finish(null), Math.ceil(ms))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(finish, () => finish(null))
  })
}
