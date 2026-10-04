import { findRetractionCues, findSpokenCommands, splitWords } from '../text/words'
import { checkCleanup, hasLeftTheTranscript, type GuardReason } from './guard'
import type { LocalOnlyGate, LocalVerdict } from './local-only'
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
  client: Pick<OllamaClient, 'chat' | 'warm'>
  gate: Pick<LocalOnlyGate, 'check' | 'block'>
  /** The chosen model, or null when none is. */
  model(): string | null
  dictionary(): readonly DictionaryEntry[]
  now?(): number
  ceilingMs?: number
}

/** Room left in the context beyond the prompt and the reply. */
const CONTEXT_MARGIN = 64
/** The model is not warmed again while the last warm-up is this recent. */
const WARM_FOR_MS = 5 * 60_000

/**
 * Turns a raw transcript into the text to paste in Cleaned mode: rules first, then the
 * model under a deadline, then the guard. Whatever goes wrong with the model, the
 * rules-only text is the answer, and it is always on time.
 */
export class Refiner {
  // Starting values measured on the development machine; replaced by what is observed.
  private firstTokenMs = 600
  private tokensPerSecond = 23
  private warmedAt = -Infinity
  private warming = false
  private readonly now: () => number
  private readonly ceilingMs: number

  constructor(private readonly deps: RefinerDeps) {
    this.now = deps.now ?? (() => performance.now())
    this.ceilingMs = deps.ceilingMs ?? CLEANUP_CEILING_MS
  }

  /**
   * Called when a dictation starts: has the model loaded and its instructions read
   * while the user is still speaking. A model that is not local is never contacted.
   */
  prewarm(): void {
    const model = this.deps.model()
    if (!model || this.warming || this.now() - this.warmedAt < WARM_FOR_MS) return
    this.warming = true
    void (async () => {
      try {
        if ((await this.deps.gate.check(model)).local) {
          await this.deps.client.warm(model, PROMPT_PREFIX)
          this.warmedAt = this.now()
        }
      } finally {
        this.warming = false
      }
    })()
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

    // Nothing has been sent yet. The model is only asked about, until it is known to be local.
    const verdict = await this.deps.gate.check(model)
    if (!verdict.local) return done(`notLocal:${verdict.reason}`)
    if (signal.aborted) return done('cancelled')

    const deadlineMs = Math.min(1_000 + 1.5 * writingMs, this.ceilingMs) - (this.now() - started)
    if (deadlineMs <= 0) return done('timeout')
    // A whole number of milliseconds: the timer accepts nothing else.
    const deadline = AbortSignal.timeout(Math.ceil(deadlineMs))

    try {
      const reply = await this.deps.client.chat({
        model,
        messages,
        numPredict,
        signal: AbortSignal.any([signal, deadline]),
        // Stop as soon as the reply has clearly left the transcript behind.
        onContent: (soFar) => !hasLeftTheTranscript(rules, soFar),
      })
      if (reply.remote) {
        // The reply says it came from another machine. It is discarded, and the model is not asked again.
        this.deps.gate.block(model)
        return done('notLocal:blocked')
      }
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
      if (deadline.aborted) return done('timeout')
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
