import { describe, expect, it } from 'vitest'
import { LocalOnlyGate, type LocalVerdict } from '../../src/main/cleanup/local-only'
import {
  OllamaClient,
  OllamaError,
  type ChatRequest,
  type ChatResult,
  type WarmReply,
} from '../../src/main/cleanup/ollama-client'
import { PROMPT_PREFIX, buildMessages, relevantVocabulary } from '../../src/main/cleanup/prompts'
import { Refiner } from '../../src/main/cleanup/refiner'
import type { DictionaryEntry } from '../../src/main/cleanup/rules'

const reply = (content: string, extra: Partial<ChatResult> = {}): ChatResult => ({
  content,
  doneReason: 'stop',
  remote: false,
  firstTokenMs: 300,
  outputTokens: 20,
  generationMs: 500,
  loadMs: 0,
  ...extra,
})

function setup(
  options: {
    ceilingMs?: number
    dictionary?: DictionaryEntry[]
    /** Time passes as it really does, instead of standing still until a test moves it. */
    realClock?: boolean
    warmTimeoutMs?: number
  } = {},
) {
  const state = {
    model: 'qwen3.5:4b' as string | null,
    verdict: null as LocalVerdict | null,
    digest: 'first-digest',
    /** What the model answers, or how it fails. */
    answer: ((request: ChatRequest) =>
      Promise.resolve(reply(String(request.messages.at(-1)?.content)))) as (
      request: ChatRequest,
    ) => Promise<ChatResult>,
    clock: 0,
    url: 'http://127.0.0.1:11434',
    /** What the warm-up's reply says, or null when there is none. */
    warm: ((_signal?: AbortSignal) => Promise.resolve(LOCAL)) as (
      signal?: AbortSignal,
    ) => Promise<WarmReply | null>,
    /** How long the gate takes to answer, one entry per question; then at once. */
    checkTakesMs: [] as number[],
  }
  const calls = {
    chat: [] as ChatRequest[],
    checked: [] as string[],
    blocked: [] as string[],
    warmed: 0,
    warmedModels: [] as string[],
    warmSignals: [] as Array<AbortSignal | undefined>,
    redirects: 0,
    /** What the model was sent, in order: `warm` (instructions only) or `chat` (a transcript). */
    sent: [] as string[],
  }
  const refiner = new Refiner({
    client: {
      get url() {
        return state.url
      },
      chat: (request) => {
        calls.chat.push(request)
        calls.sent.push('chat')
        return state.answer(request)
      },
      warm: (model, _prefix, signal) => {
        calls.warmed += 1
        calls.warmedModels.push(model)
        calls.warmSignals.push(signal)
        calls.sent.push('warm')
        return state.warm(signal)
      },
    },
    gate: {
      // As the real gate does: a blocked model is refused from then on.
      check: async (model) => {
        calls.checked.push(model)
        const takes = state.checkTakesMs.shift() ?? 0
        if (takes > 0) await new Promise((resolve) => setTimeout(resolve, takes))
        return calls.blocked.includes(model)
          ? ({ local: false, reason: 'blocked' } as const)
          : (state.verdict ?? {
              local: true,
              identity: {
                server: state.url,
                model: model.includes(':') ? model : `${model}:latest`,
                digest: state.digest,
              },
            })
      },
      block: (model) => void calls.blocked.push(model),
      sawRedirect: () => void (calls.redirects += 1),
    },
    model: () => state.model,
    dictionary: () => options.dictionary ?? [],
    now: () => (options.realClock ? performance.now() : state.clock),
    ...(options.ceilingMs ? { ceilingMs: options.ceilingMs } : {}),
    ...(options.warmTimeoutMs ? { warmTimeoutMs: options.warmTimeoutMs } : {}),
  })
  const run = (raw: string, signal = new AbortController().signal) => refiner.refine(raw, signal)
  return { refiner, state, calls, run }
}

const LOCAL: WarmReply = { remote: false, redirected: false }
const REMOTE: WarmReply = { remote: true, redirected: false }

const answers =
  (content: string, extra: Partial<ChatResult> = {}) =>
  () =>
    Promise.resolve(reply(content, extra))
/** The transcript as the model was given it. */
const transcriptOf = (request: ChatRequest): string =>
  /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(String(request.messages.at(-1)?.content))?.[1] ??
  ''

const SPOKEN = 'um so lets meet thursday no wait friday at 3 pm and bring the the q3 report'
const CLEAN = 'So lets meet Friday at 3 PM and bring the Q3 report.'

describe('Refiner', () => {
  it('uses the model text when the guard accepts it, and keeps every stage', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN)

    expect(await t.run(SPOKEN)).toMatchObject({
      raw: SPOKEN,
      rules: 'So lets meet thursday no wait friday at 3 pm and bring the q3 report',
      cleaned: CLEAN,
      final: CLEAN,
      note: 'cleaned',
    })
  })

  it('gives the model the rules-only text, not the raw one', async () => {
    const t = setup({ dictionary: [{ from: 'kubernetes', to: 'Kubernetes' }] })
    t.state.answer = (request) => Promise.resolve(reply(transcriptOf(request)))

    const result = await t.run('uh deploy the the kubernetes cluster before the review today')

    expect(transcriptOf(t.calls.chat[0]!)).toBe(
      'Deploy the Kubernetes cluster before the review today',
    )
    expect(String(t.calls.chat[0]!.messages.at(-1)?.content)).toContain('Vocabulary: Kubernetes')
    expect(result.note).toBe('cleaned')
  })

  it('falls back to the rules-only text when the guard refuses', async () => {
    const t = setup()
    t.state.answer = answers('The meeting is at 10 AM on Friday in the main room.')

    expect(await t.run('um what time is the meeting tomorrow and where is it')).toMatchObject({
      cleaned: null,
      final: 'What time is the meeting tomorrow and where is it',
      note: 'guard:invented',
    })
  })

  it('does not ask a model about four words or fewer', async () => {
    const t = setup()

    expect(await t.run('Sounds good, thanks.')).toMatchObject({
      final: 'Sounds good, thanks.',
      note: 'short',
    })
    expect(t.calls.chat).toEqual([])
    expect(t.calls.checked).toEqual([])
  })

  it('but does ask about a short self-correction', async () => {
    const t = setup()
    t.state.answer = answers('At 3.')

    expect(await t.run('at 2 actually 3')).toMatchObject({ final: 'At 3.', note: 'cleaned' })
    t.state.answer = answers('Friday.')
    expect(await t.run('Thursday, no, Friday')).toMatchObject({ final: 'Friday.', note: 'cleaned' })
  })

  it('returns nothing to paste when the dictation was only a hesitation', async () => {
    const t = setup()

    expect((await t.run('Uh.')).final).toBe('')
  })

  it('uses the rules-only text when no model is chosen', async () => {
    const t = setup()
    t.state.model = null

    expect(await t.run(SPOKEN)).toMatchObject({ note: 'noModel', cleaned: null })
    expect(t.calls.chat).toEqual([])
  })

  it('never sends a transcript to a model that is not local', async () => {
    const t = setup()
    for (const reason of ['remote', 'notInstalled', 'unreachable', 'serverNotLocal'] as const) {
      t.state.verdict = { local: false, reason }
      expect((await t.run(SPOKEN)).note).toBe(`notLocal:${reason}`)
    }

    expect(t.calls.chat).toEqual([])
  })

  it('discards a reply that came from another machine, and blocks the model', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN, { remote: true })

    expect(await t.run(SPOKEN)).toMatchObject({ cleaned: null, note: 'notLocal:blocked' })
    expect(t.calls.blocked).toEqual(['qwen3.5:4b'])
  })

  it('does not start on a transcript the model could not finish in time', async () => {
    const t = setup()
    const long = Array.from({ length: 150 }, (_, index) => `word${index}`).join(' ')

    expect(await t.run(long)).toMatchObject({ note: 'tooLong', final: long })
    expect(t.calls.chat).toEqual([])
  })

  it('stops waiting at the deadline and uses the rules-only text', async () => {
    const t = setup({ ceilingMs: 2_500 })
    t.state.clock = performance.now()
    // A model that never answers; only the deadline ends the request.
    t.state.answer = (request) =>
      new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () =>
          reject(new OllamaError('aborted', 'The request was cancelled')),
        )
      })

    const started = performance.now()
    const result = await t.run('send the report to the team today please')

    expect(result).toMatchObject({ note: 'timeout', cleaned: null })
    // One second plus one and a half times the writing time, for eight words.
    expect(performance.now() - started).toBeLessThan(2_600)
    expect(performance.now() - started).toBeGreaterThan(1_000)
  })

  it('says how long a dictation would have allowed, so that a slower answer can be told as such', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN)

    const result = await t.run(SPOKEN)

    // One second plus one and a half times the time the model needs to write it.
    expect(result.allowedMs).toBeGreaterThan(1_000)
    expect(result.allowedMs).toBeLessThanOrEqual(4_000)
    // A text that is not sent to the model has the whole ceiling as its allowance.
    expect((await t.run('yes please')).allowedMs).toBe(4_000)
  })

  it('waits for a slow model when a sentence is only being tried, and reports the time it took', async () => {
    const t = setup({ ceilingMs: 1_200, realClock: true })
    // Slower than any dictation would wait for, and it does answer in the end.
    t.state.answer = (request) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(reply('Send the report to the team today, please.')),
          1_500,
        )
        request.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new OllamaError('aborted', 'The request was cancelled'))
        })
      })
    const sentence = 'send the report to the team today please'

    // A dictation gives up at its deadline and pastes the rules-only text.
    expect(await t.run(sentence)).toMatchObject({ note: 'timeout', cleaned: null })

    const tried = await t.refiner.refine(sentence, new AbortController().signal, { patient: true })

    expect(tried.note).toBe('cleaned')
    expect(tried.cleaned).toBe('Send the report to the team today, please.')
    expect(tried.cleanupMs).toBeGreaterThan(tried.allowedMs)
    expect(tried.tooLongForDictation).toBeUndefined()
  })

  it('says when a sentence that was tried is too long for any dictation', async () => {
    const t = setup()
    // Long enough that a model of the usual speed could not write it within the ceiling.
    const sentence = Array.from({ length: 12 }, () => 'send the quarterly report to the team').join(
      ' and ',
    )
    t.state.answer = (request) => Promise.resolve(reply(transcriptOf(request)))

    expect((await t.run(sentence)).note).toBe('tooLong')
    const tried = await t.refiner.refine(sentence, new AbortController().signal, { patient: true })
    expect(tried).toMatchObject({ note: 'cleaned', tooLongForDictation: true })
  })

  it('still warms the model up before a sentence that is being tried', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN)

    await t.refiner.refine(SPOKEN, new AbortController().signal, { patient: true })

    // The instructions first, and only then the sentence: as for any dictation.
    expect(t.calls.sent).toEqual(['warm', 'chat'])
  })

  it('caps the reply at a little more than the transcript', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN)
    await t.run(SPOKEN)

    const tokens = Math.ceil(
      'so lets meet thursday no wait friday at 3 pm and bring the q3 report'.length / 3.5,
    )
    expect(t.calls.chat[0]!.numPredict).toBe(Math.ceil(tokens * 1.3) + 24)
  })

  it('stops reading a reply that has clearly left the transcript', async () => {
    const t = setup()
    t.state.answer = (request) => {
      const keepGoing = request.onContent?.('I am sorry, but as an AI model I cannot')
      return Promise.resolve(reply('', { doneReason: keepGoing === false ? 'abandoned' : 'stop' }))
    }

    expect((await t.run(SPOKEN)).note).toBe('guard:invented')
  })

  it('takes no approval from a reply it gave up on', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN)
    await t.run(SPOKEN)
    t.state.clock = 4 * 60_000
    t.state.answer = (request) => {
      const keepGoing = request.onContent?.('I am sorry, but as an AI model I cannot')
      return Promise.resolve(reply('', { doneReason: keepGoing === false ? 'abandoned' : 'stop' }))
    }
    await t.run(SPOKEN)
    // Eight minutes after the last reply that finished: the approval has run out.
    t.state.clock = 8 * 60_000
    t.state.answer = answers(CLEAN)
    await t.run(SPOKEN)

    expect(t.calls.sent).toEqual(['warm', 'chat', 'chat', 'warm', 'chat'])
  })

  // "constructor" is a property of every plain object: looked up in one by what was
  // said, it once came back as a function and broke the comparison of words.
  it.each([[[]], [[{ from: 'cube ernetes', to: 'Kubernetes' }]]])(
    'cleans a transcript that says "constructor" (dictionary %j)',
    async (dictionary: DictionaryEntry[]) => {
      const t = setup({ dictionary })
      t.state.answer = answers('Call the constructor before the factory runs.')

      const result = await t.run('call the constructor before the factory runs')
      expect(result).toMatchObject({ note: 'cleaned' })
    },
  )

  it('still answers with the rules-only text when something inside it throws', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN)
    Object.defineProperty(t.state, 'model', {
      get: () => {
        throw new TypeError('a mistake of our own')
      },
    })

    const result = await t.run(SPOKEN)
    expect(result).toMatchObject({ note: 'failed', cleaned: null })
    expect(result.final).toBe(result.rules)
    expect(result.final.length).toBeGreaterThan(0)
  })

  it.each([
    [new OllamaError('unreachable', 'connection refused'), 'unreachable'],
    [new OllamaError('stream', 'model runner has stopped'), 'failed'],
    [new Error('something else'), 'failed'],
  ])('uses the rules-only text when the request fails (%s)', async (error, note) => {
    const t = setup()
    t.state.answer = () => Promise.reject(error)

    expect(await t.run(SPOKEN)).toMatchObject({ note, cleaned: null })
  })

  it('takes a redirect for a server that is not to be used, and says so', async () => {
    const t = setup()
    t.state.answer = () =>
      Promise.reject(new OllamaError('redirect', 'Ollama answered with a redirect'))

    expect(await t.run(SPOKEN)).toMatchObject({ note: 'notLocal:redirected', cleaned: null })
    expect(t.calls.redirects).toBe(1)
  })

  it('reports a cancelled session as cancelled, not as a failure', async () => {
    const t = setup()
    const cancel = new AbortController()
    t.state.answer = () => {
      cancel.abort()
      return Promise.reject(new OllamaError('aborted', 'The request was cancelled'))
    }

    expect((await t.run(SPOKEN, cancel.signal)).note).toBe('cancelled')
  })

  describe('warming the model up', () => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    it('checks that the model is local, then warms it once', async () => {
      const t = setup()
      t.refiner.prewarm()
      await settle()
      t.refiner.prewarm()
      await settle()

      // Resolve the current digest even when an earlier reply is still cached.
      expect(t.calls.checked).toEqual(['qwen3.5:4b', 'qwen3.5:4b', 'qwen3.5:4b'])
      expect(t.calls.warmed).toBe(1)

      t.state.clock += 6 * 60_000
      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmed).toBe(2)
    })

    it('never contacts a model that is not local, and does nothing with no model', async () => {
      const t = setup()
      t.state.verdict = { local: false, reason: 'remote' }
      t.refiner.prewarm()
      await settle()
      t.state.model = null
      t.refiner.prewarm()
      await settle()

      expect(t.calls.warmed).toBe(0)
    })

    it('blocks a model whose warm-up reply came from another machine', async () => {
      const t = setup()
      t.state.warm = () => Promise.resolve(REMOTE)
      t.state.answer = answers(CLEAN)

      t.refiner.prewarm()
      await settle()
      const result = await t.run(SPOKEN)

      expect(t.calls.blocked).toEqual(['qwen3.5:4b'])
      expect(result).toMatchObject({ note: 'notLocal:blocked', cleaned: null })
      expect(t.calls.chat).toEqual([])
    })

    it('does not send the transcript to a server that redirected the warm-up', async () => {
      const t = setup()
      t.state.warm = () => Promise.resolve({ remote: false, redirected: true })
      // As the real gate does once it has been told.
      t.state.answer = answers(CLEAN)

      t.refiner.prewarm()
      await settle()

      expect(t.calls.redirects).toBe(1)
      expect(t.calls.blocked).toEqual([])
      // Not warm: the next dictation asks again, in case the address has been put right.
      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmed).toBe(2)
    })

    it('holds the transcript back until a warm-up on its way has answered', async () => {
      const t = setup()
      let answer!: (reply: WarmReply) => void
      t.state.warm = () => new Promise((resolve) => (answer = resolve))
      t.state.answer = answers(CLEAN)

      t.refiner.prewarm()
      await settle()
      const result = t.run(SPOKEN)
      await settle()
      // The dictation is over and its text is ready, but nobody knows yet where the
      // model runs.
      expect(t.calls.chat).toEqual([])

      answer(REMOTE)

      expect(await result).toMatchObject({ note: 'notLocal:blocked', cleaned: null })
      expect(t.calls.chat).toEqual([])
    })

    it('sends the transcript once the warm-up has shown the model to be local', async () => {
      const t = setup()
      let answer!: (reply: WarmReply) => void
      t.state.warm = () => new Promise((resolve) => (answer = resolve))
      t.state.answer = answers(CLEAN)

      t.refiner.prewarm()
      await settle()
      const result = t.run(SPOKEN)
      await settle()
      answer(LOCAL)

      expect(await result).toMatchObject({ note: 'cleaned', final: CLEAN })
      expect(t.calls.chat).toHaveLength(1)
    })

    it('waits for a warm-up no longer than cleanup may take, and then sends nothing', async () => {
      const t = setup({ ceilingMs: 2_500 })
      t.state.clock = performance.now()
      // A server that took the warm-up and never answered it.
      t.state.warm = () => new Promise(() => {})
      t.state.answer = answers(CLEAN)
      t.refiner.prewarm()
      await settle()

      const started = performance.now()
      const result = await t.run('send the report to the team today please')

      expect(result).toMatchObject({ note: 'timeout', cleaned: null })
      expect(t.calls.chat).toEqual([])
      expect(performance.now() - started).toBeLessThan(2_600)
    })

    it('does not wait when the session is cancelled meanwhile', async () => {
      const t = setup()
      t.state.warm = () => new Promise(() => {})
      const cancel = new AbortController()
      t.refiner.prewarm()
      await settle()

      const result = t.run(SPOKEN, cancel.signal)
      await settle()
      cancel.abort()

      expect((await result).note).toBe('cancelled')
      expect(t.calls.chat).toEqual([])
    })

    it("starts a fresh warm-up when a cancelled session's request has not settled yet", async () => {
      const t = setup()
      let finishCancelled!: (reply: WarmReply | null) => void
      t.state.warm = () => new Promise((resolve) => (finishCancelled = resolve))
      const cancel = new AbortController()
      const first = t.run(SPOKEN, cancel.signal)
      await settle()
      cancel.abort()
      expect((await first).note).toBe('cancelled')

      t.state.warm = () => Promise.resolve(LOCAL)
      t.state.answer = answers(CLEAN)
      expect((await t.run(SPOKEN)).note).toBe('cleaned')
      expect(t.calls.sent).toEqual(['warm', 'warm', 'chat'])
      finishCancelled(null)
      await settle()
    })

    it('does not wait for the warm-up of another model, and asks the chosen one itself', async () => {
      const t = setup()
      // The model chosen first never answers its warm-up; the one chosen after does.
      t.state.warm = () => (t.calls.warmed === 1 ? new Promise(() => {}) : Promise.resolve(LOCAL))
      t.state.answer = answers(CLEAN)
      t.refiner.prewarm()
      await settle()

      t.state.model = 'gemma4:e4b'

      expect((await t.run(SPOKEN)).note).toBe('cleaned')
      expect(t.calls.warmedModels).toEqual(['qwen3.5:4b', 'gemma4:e4b'])
    })

    it('warms again when the model or the server is another one', async () => {
      const t = setup()
      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmed).toBe(1)

      t.state.model = 'gemma4:e4b'
      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmed).toBe(2)

      t.state.url = 'http://127.0.0.1:11500'
      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmed).toBe(3)

      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmed).toBe(3)
    })

    it("does not give a replacement digest the previous digest's warm approval", async () => {
      const t = setup()
      t.refiner.prewarm()
      await settle()
      t.state.digest = 'replacement-digest'
      t.state.warm = () => Promise.resolve(REMOTE)

      expect((await t.run(SPOKEN)).note).toBe('notLocal:blocked')
      expect(t.calls.warmed).toBe(2)
      expect(t.calls.chat).toEqual([])
    })

    it('warms a local replacement before sending it a transcript', async () => {
      const t = setup()
      t.state.answer = answers(CLEAN)
      t.refiner.prewarm()
      await settle()
      t.state.digest = 'replacement-digest'

      expect((await t.run(SPOKEN)).note).toBe('cleaned')
      expect(t.calls.sent).toEqual(['warm', 'warm', 'chat'])
    })

    it('shares warm evidence for tagged and untagged names of the same identity', async () => {
      const t = setup()
      t.state.model = 'gemma'
      t.state.answer = answers(CLEAN)
      t.refiner.prewarm()
      await settle()
      t.state.model = 'gemma:latest'

      expect((await t.run(SPOKEN)).note).toBe('cleaned')
      expect(t.calls.warmedModels).toEqual(['gemma:latest'])
      expect(t.calls.chat[0]?.model).toBe('gemma:latest')
    })

    it("does not join an old digest's in-flight warm-up for its replacement", async () => {
      const t = setup()
      let finishOriginal!: (reply: WarmReply) => void
      t.state.warm = () => new Promise((resolve) => (finishOriginal = resolve))
      t.refiner.prewarm()
      await settle()
      t.state.digest = 'replacement-digest'
      t.state.warm = () => Promise.resolve(REMOTE)

      expect((await t.run(SPOKEN)).note).toBe('notLocal:blocked')
      expect(t.calls.warmed).toBe(2)
      expect(t.calls.chat).toEqual([])
      finishOriginal(LOCAL)
      await settle()
    })

    it('rechecks a replacement made while the first warm-up was answering', async () => {
      const t = setup()
      t.state.warm = () => {
        if (t.calls.warmed > 1) return Promise.resolve(REMOTE)
        t.state.digest = 'replacement-digest'
        return Promise.resolve(LOCAL)
      }

      expect((await t.run(SPOKEN)).note).toBe('notLocal:blocked')
      expect(t.calls.sent).toEqual(['warm', 'warm'])
    })

    it('does not let a late prewarm approve another digest or another server', async () => {
      for (const changed of ['digest', 'server'] as const) {
        const t = setup()
        let finishOriginal!: (reply: WarmReply) => void
        t.state.warm = () => new Promise((resolve) => (finishOriginal = resolve))
        t.refiner.prewarm()
        await settle()
        if (changed === 'digest') t.state.digest = 'replacement-digest'
        else t.state.url = 'http://127.0.0.1:11500'
        finishOriginal(LOCAL)
        await settle()
        t.state.warm = () => Promise.resolve(REMOTE)

        expect((await t.run(SPOKEN)).note).toBe('notLocal:blocked')
        expect(t.calls.sent).toEqual(['warm', 'warm'])
      }
    })

    it('falls back after repeated identity changes without sending a transcript', async () => {
      const t = setup()
      t.state.warm = () => {
        t.state.digest = `replacement-${t.calls.warmed}`
        return Promise.resolve(LOCAL)
      }

      expect(await t.run(SPOKEN)).toMatchObject({ note: 'failed', cleaned: null })
      expect(t.calls.warmed).toBe(3)
      expect(t.calls.chat).toEqual([])
    })

    it('tries again at the next dictation when a warm-up got no reply', async () => {
      const t = setup()
      t.state.warm = () => Promise.resolve(null)
      t.refiner.prewarm()
      await settle()

      t.refiner.prewarm()
      await settle()

      expect(t.calls.warmed).toBe(2)
      expect(t.calls.blocked).toEqual([])
    })

    it('gives up on a warm-up that is never answered, and is then free to try again', async () => {
      const t = setup({ warmTimeoutMs: 60 })
      // A server that takes the request and says nothing, until the request is ended.
      t.state.warm = (signal) =>
        new Promise((resolve) => signal?.addEventListener('abort', () => resolve(null)))

      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmSignals[0]?.aborted).toBe(false)
      // While it is on its way, a second dictation does not start another.
      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmed).toBe(1)

      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(t.calls.warmSignals[0]?.aborted).toBe(true)
      t.refiner.prewarm()
      await settle()
      expect(t.calls.warmed).toBe(2)
    })
  })

  describe('the first thing a model is sent', () => {
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    it('is never the transcript: with no warm-up before it, one is made first', async () => {
      const t = setup()
      t.state.answer = answers(CLEAN)

      // An Undo long after the dictation, say: nothing warmed the model up.
      expect((await t.run(SPOKEN)).note).toBe('cleaned')

      expect(t.calls.sent).toEqual(['warm', 'chat'])
    })

    it('is not followed by the transcript when the first reply names another machine', async () => {
      const t = setup()
      t.state.warm = () => Promise.resolve(REMOTE)
      t.state.answer = answers(CLEAN)

      expect(await t.run(SPOKEN)).toMatchObject({ note: 'notLocal:blocked', cleaned: null })

      expect(t.calls.sent).toEqual(['warm'])
      expect(t.calls.blocked).toEqual(['qwen3.5:4b'])
    })

    it('is asked for again for a model chosen while the dictation was going on', async () => {
      const t = setup()
      t.state.answer = answers(CLEAN)
      t.refiner.prewarm()
      await settle()
      // The other model is picked in the menu before the key is released, and its
      // first reply names another machine.
      t.state.model = 'looks-local:latest'
      t.state.warm = () => Promise.resolve(REMOTE)

      expect((await t.run(SPOKEN)).note).toBe('notLocal:blocked')

      expect(t.calls.warmedModels).toEqual(['qwen3.5:4b', 'looks-local:latest'])
      expect(t.calls.chat).toEqual([])
    })

    it('is not followed by the transcript when it never came', async () => {
      const t = setup()
      // The model is listed as local, and every request to it fails.
      t.state.warm = () => Promise.resolve(null)
      t.state.answer = answers(CLEAN)
      t.refiner.prewarm()
      await settle()

      expect(await t.run(SPOKEN)).toMatchObject({ note: 'failed', cleaned: null })

      // Asked a second time when the text was ready, and still no transcript sent.
      expect(t.calls.sent).toEqual(['warm', 'warm'])
    })

    it('need not be asked for again while the model is in use', async () => {
      const t = setup()
      t.state.answer = answers(CLEAN)
      await t.run(SPOKEN)
      // Four minutes later the model answers a dictation; four minutes after that,
      // another. The last warm-up is eight minutes old, the last reply four.
      t.state.clock += 4 * 60_000
      await t.run(SPOKEN)
      t.state.clock += 4 * 60_000
      t.refiner.prewarm()
      await t.run(SPOKEN)

      expect(t.calls.sent).toEqual(['warm', 'chat', 'chat', 'chat'])
    })
  })

  describe('the time cleanup may take', () => {
    const SHORT_ENOUGH = 'send the report to the team today please'

    it('covers the wait for a warm-up and the question that follows it', async () => {
      const t = setup({ ceilingMs: 1_200, realClock: true })
      t.state.answer = answers(CLEAN)
      // The warm-up answers just inside the time there is, and the gate is then slow
      // to say whether the model may be used.
      t.state.warm = () => new Promise((resolve) => setTimeout(() => resolve(LOCAL), 900))
      t.state.checkTakesMs = [0, 900]

      const started = performance.now()
      const result = await t.run(SHORT_ENOUGH)
      const took = performance.now() - started

      expect(result).toMatchObject({ note: 'timeout', cleaned: null })
      expect(t.calls.chat).toEqual([])
      // The rules-only text is on time: 1.2 s, not 0.9 s and then another 0.9 s.
      expect(took).toBeLessThan(1_400)
      expect(result.cleanupMs).toBeLessThan(1_400)
    })

    it('is not overrun by a gate that is slow to answer', async () => {
      const t = setup({ ceilingMs: 1_200, realClock: true })
      t.state.answer = answers(CLEAN)
      await t.run(SHORT_ENOUGH)
      // The model has answered before; this time the gate takes two seconds.
      t.state.checkTakesMs = [2_000]

      const started = performance.now()
      const result = await t.run(SHORT_ENOUGH)

      expect(result.note).toBe('timeout')
      expect(performance.now() - started).toBeLessThan(1_400)
    })

    it('does not reset the cleanup deadline when the model is replaced during warm-up', async () => {
      const t = setup({ ceilingMs: 1_200, realClock: true })
      t.state.warm = (signal) =>
        new Promise((resolve) => {
          if (t.calls.warmed === 1) {
            setTimeout(() => {
              t.state.digest = 'replacement-digest'
              resolve(LOCAL)
            }, 900)
          } else {
            signal?.addEventListener('abort', () => resolve(null))
          }
        })

      const started = performance.now()
      expect((await t.run(SHORT_ENOUGH)).note).toBe('timeout')
      expect(performance.now() - started).toBeLessThan(1_400)
      expect(t.calls.warmed).toBe(2)
      expect(t.calls.chat).toEqual([])
      expect(t.calls.warmSignals[1]?.aborted).toBe(true)
    })
  })
})

describe('Cleaned mode against a model that only its own reply gives away', () => {
  const TRANSCRIPT = 'Please bring the report to the meeting today'

  /** Lists and details that say "local", and a reply that names another machine. */
  function setupServer() {
    const seen = { chats: 0, transcripts: 0 }
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const path = String(input)
      if (path.endsWith('/api/tags')) {
        return Promise.resolve(json({ models: [{ name: 'looks-local:latest', digest: 'd1' }] }))
      }
      if (path.endsWith('/api/show')) return Promise.resolve(json({ capabilities: ['completion'] }))
      seen.chats += 1
      if (String(init?.body).includes(TRANSCRIPT)) seen.transcripts += 1
      return Promise.resolve(
        new Response(
          `${JSON.stringify({
            done: true,
            done_reason: 'stop',
            remote_host: 'remote.test',
            message: { content: 'ok' },
          })}\n`,
        ),
      )
    }) as typeof fetch
    const client = new OllamaClient(undefined, fetchImpl)
    const gate = new LocalOnlyGate(client)
    const refiner = new Refiner({
      client,
      gate,
      model: () => 'looks-local',
      dictionary: () => [],
    })
    return { seen, gate, refiner }
  }

  it('sends no transcript once the warm-up reply has named another machine', async () => {
    const t = setupServer()
    expect((await t.gate.check('looks-local')).local).toBe(true)

    t.refiner.prewarm()
    const refined = await t.refiner.refine(TRANSCRIPT, new AbortController().signal)

    expect(t.seen.chats).toBe(1)
    expect(t.seen.transcripts).toBe(0)
    expect(refined).toMatchObject({ note: 'notLocal:blocked', cleaned: null, final: TRANSCRIPT })
    expect(await t.gate.check('looks-local')).toEqual({ local: false, reason: 'blocked' })
  })
})

describe('the prompt', () => {
  it('puts nothing that varies before the last message', () => {
    const first = buildMessages('one transcript', ['Kubernetes'])
    const second = buildMessages('a different transcript entirely', [])

    expect(first.slice(0, -1)).toEqual(second.slice(0, -1))
    expect(first.slice(0, -1)).toEqual(PROMPT_PREFIX)
    expect(first.at(-1)).toEqual({
      role: 'user',
      content: '<transcript>\none transcript\n</transcript>',
    })
  })

  it('mentions only the dictionary terms this transcript could contain', () => {
    const vocabulary = ['Kubernetes', 'Priyanka', 'Terraform']

    expect(relevantVocabulary('deploy the kubernetis cluster for priyanka', vocabulary)).toEqual([
      'Kubernetes',
      'Priyanka',
    ])
    expect(buildMessages('ask Priyanka', vocabulary).at(-1)?.content).toBe(
      'Vocabulary: Priyanka\n<transcript>\nask Priyanka\n</transcript>',
    )
  })

  it('mentions at most twelve terms', () => {
    const vocabulary = Array.from({ length: 30 }, (_, index) => `term${index}`)
    const transcript = vocabulary.join(' ')

    expect(relevantVocabulary(transcript, vocabulary)).toHaveLength(12)
  })
})

describe('verified identity estimates (QA-09)', () => {
  it('patient comparison bypasses a slow estimate; another model/digest/server has its own estimate', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN, { outputTokens: 1, generationMs: 900000, firstTokenMs: 900000 })
    await t.run(SPOKEN)
    expect((await t.run(SPOKEN)).note).toBe('tooLong')
    t.state.answer = answers(CLEAN)
    expect(
      (await t.refiner.refine(SPOKEN, new AbortController().signal, { patient: true })).note,
    ).toBe('cleaned')
    t.state.digest = 'new-digest'
    expect((await t.run(SPOKEN)).note).toBe('cleaned')
    t.state.model = 'other:latest'
    expect((await t.run(SPOKEN)).note).toBe('cleaned')
    t.state.url = 'http://127.0.0.1:9000'
    expect((await t.run(SPOKEN)).note).toBe('cleaned')
  })
  it('allows one normal-deadline remeasurement after thirty seconds', async () => {
    const t = setup()
    t.state.answer = answers(CLEAN, { outputTokens: 1, generationMs: 900000, firstTokenMs: 900000 })
    await t.run(SPOKEN)
    expect((await t.run(SPOKEN)).note).toBe('tooLong')
    t.state.clock = 30001
    t.state.answer = answers(CLEAN)
    expect((await t.run(SPOKEN)).note).toBe('cleaned')
    expect(t.calls.chat).toHaveLength(2)
  })
  it('a short text waits no longer than it is allowed for a model that is still loading', async () => {
    const t = setup({ realClock: true })
    // The model was unloaded: answering the warm-up takes three seconds.
    t.state.warm = () => new Promise((resolve) => setTimeout(() => resolve(LOCAL), 3_000))
    const began = performance.now()
    const refined = await t.run(SPOKEN)

    expect(refined.note).toBe('timeout')
    // Its own allowance (about 1.9 s for this sentence), not the whole ceiling.
    expect(performance.now() - began).toBeLessThan(2_500)
    expect(refined.allowedMs).toBeLessThan(2_500)
    expect(t.calls.chat).toHaveLength(0)
  })
  it('a text too long for any model of the usual speed is refused at once, and nothing is asked', async () => {
    const t = setup()
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
    expect((await t.run(long)).note).toBe('tooLong')
    // Not once, and not after a while: no model is ever kept waiting for it.
    t.state.clock = 120_000
    expect((await t.run(long)).note).toBe('tooLong')
    expect(t.calls.checked).toHaveLength(0)
    expect(t.calls.chat).toHaveLength(0)
  })
  it('a model measured again and still too slow is measured again later each time', async () => {
    const t = setup({ ceilingMs: 1_000 })
    const said = 'um so this is the plan'
    const tidy = 'So this is the plan.'
    t.state.answer = answers(tidy, { outputTokens: 1, generationMs: 900000, firstTokenMs: 900000 })
    await t.run(said)
    expect((await t.run(said)).note).toBe('tooLong')
    // Thirty seconds on it is measured again, and does not answer within the ceiling.
    t.state.answer = (request) =>
      new Promise((_resolve, reject) =>
        request.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
      )
    t.state.clock = 30_001
    expect((await t.run(said)).note).toBe('timeout')
    // Thirty seconds after that is too soon now; sixty is not.
    t.state.clock = 60_002
    expect((await t.run(said)).note).toBe('tooLong')
    t.state.clock = 90_002
    t.state.answer = answers(tidy)
    expect((await t.run(said)).note).toBe('cleaned')
    // Answered in time: what was measured before is replaced, not averaged with it.
    expect((await t.run(said)).note).toBe('cleaned')
  })
  it('bounds the estimate cache and expires observations after five minutes', async () => {
    const t = setup()
    for (let i = 0; i < 20; i++) {
      t.state.digest = String(i)
      await t.run(SPOKEN)
    }
    expect(t.refiner['speeds'].size).toBe(16)
    t.state.answer = answers(CLEAN, { outputTokens: 1, generationMs: 900000 })
    await t.run(SPOKEN)
    t.state.clock = 300001
    t.state.answer = answers(CLEAN)
    expect((await t.run(SPOKEN)).note).toBe('cleaned')
  })
})
