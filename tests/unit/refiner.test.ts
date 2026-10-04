import { describe, expect, it } from 'vitest'
import type { LocalVerdict } from '../../src/main/cleanup/local-only'
import {
  OllamaError,
  type ChatRequest,
  type ChatResult,
} from '../../src/main/cleanup/ollama-client'
import { PROMPT_PREFIX, buildMessages, relevantVocabulary } from '../../src/main/cleanup/prompts'
import { Refiner } from '../../src/main/cleanup/refiner'
import type { DictionaryEntry } from '../../src/main/cleanup/rules'

const reply = (content: string, extra: Partial<ChatResult> = {}): ChatResult => ({
  content,
  doneReason: 'stop',
  remote: false,
  firstTokenMs: 300,
  totalMs: 900,
  outputTokens: 20,
  generationMs: 500,
  loadMs: 0,
  ...extra,
})

function setup(options: { ceilingMs?: number; dictionary?: DictionaryEntry[] } = {}) {
  const state = {
    model: 'qwen3.5:4b' as string | null,
    verdict: { local: true } as LocalVerdict,
    /** What the model answers, or how it fails. */
    answer: ((request: ChatRequest) =>
      Promise.resolve(reply(String(request.messages.at(-1)?.content)))) as (
      request: ChatRequest,
    ) => Promise<ChatResult>,
    clock: 0,
  }
  const calls = {
    chat: [] as ChatRequest[],
    checked: [] as string[],
    blocked: [] as string[],
    warmed: 0,
  }
  const refiner = new Refiner({
    client: {
      chat: (request) => {
        calls.chat.push(request)
        return state.answer(request)
      },
      warm: () => {
        calls.warmed += 1
        return Promise.resolve()
      },
    },
    gate: {
      check: (model) => {
        calls.checked.push(model)
        return Promise.resolve(state.verdict)
      },
      block: (model) => void calls.blocked.push(model),
    },
    model: () => state.model,
    dictionary: () => options.dictionary ?? [],
    now: () => state.clock,
    ...(options.ceilingMs ? { ceilingMs: options.ceilingMs } : {}),
  })
  const run = (raw: string, signal = new AbortController().signal) => refiner.refine(raw, signal)
  return { refiner, state, calls, run }
}

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

  it.each([
    [new OllamaError('unreachable', 'connection refused'), 'unreachable'],
    [new OllamaError('stream', 'model runner has stopped'), 'failed'],
    [new Error('something else'), 'failed'],
  ])('uses the rules-only text when the request fails (%s)', async (error, note) => {
    const t = setup()
    t.state.answer = () => Promise.reject(error)

    expect(await t.run(SPOKEN)).toMatchObject({ note, cleaned: null })
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

      expect(t.calls.checked).toEqual(['qwen3.5:4b'])
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
