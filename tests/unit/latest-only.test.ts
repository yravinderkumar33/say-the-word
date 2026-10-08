import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestOnly } from '../../src/main/latest-only'

/** Lets every pending promise callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A question whose answers the test gives by hand, in whatever order it likes. */
function setup() {
  const pending: Array<{ answer(value: string): void; fail(error: Error): void }> = []
  const acted: string[] = []
  const ask = latestOnly(
    () =>
      new Promise<string>((resolve, reject) => {
        pending.push({ answer: resolve, fail: reject })
      }),
    (answer) => acted.push(answer),
  )
  return { ask, pending, acted }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('latestOnly', () => {
  it('acts on the answer to a question asked once', async () => {
    const t = setup()
    t.ask()

    t.pending[0]!.answer('Cleaned with qwen3.5:4b')
    await settle()

    expect(t.acted).toEqual(['Cleaned with qwen3.5:4b'])
  })

  it('drops an answer that arrives after the question was asked again', async () => {
    const t = setup()
    // Cleaned mode is chosen while Ollama is slow to answer, then Verbatim.
    t.ask()
    t.ask()

    t.pending[1]!.answer('')
    await settle()
    // Only now does the answer about Cleaned mode come back.
    t.pending[0]!.answer('Cleaned with qwen3.5:4b')
    await settle()

    expect(t.acted).toEqual([''])
  })

  it('drops the older answer whichever of the two arrives first', async () => {
    const t = setup()
    t.ask()
    t.ask()

    t.pending[0]!.answer('about the old setting')
    await settle()
    expect(t.acted).toEqual([])

    t.pending[1]!.answer('about the new setting')
    await settle()
    expect(t.acted).toEqual(['about the new setting'])
  })

  it('acts on each answer when the questions do not overlap', async () => {
    const t = setup()
    t.ask()
    t.pending[0]!.answer('first')
    await settle()
    t.ask()
    t.pending[1]!.answer('second')
    await settle()

    expect(t.acted).toEqual(['first', 'second'])
  })

  it('does nothing when the question cannot be answered, and answers the next one', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = setup()
    t.ask()
    t.pending[0]!.fail(new Error('no answer'))
    await settle()
    expect(t.acted).toEqual([])
    expect(logged).toHaveBeenCalledTimes(1)

    t.ask()
    t.pending[1]!.answer('answered this time')
    await settle()
    expect(t.acted).toEqual(['answered this time'])
  })

  it('says in the log when acting on an answer fails, and leaves nothing unhandled', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const ask = latestOnly(
        () => Promise.resolve('Cleaned with qwen3.5:4b'),
        () => {
          throw new Error('the menu could not be drawn')
        },
      )
      ask()
      await settle()
    } finally {
      process.off('unhandledRejection', unhandled)
    }

    expect(unhandled).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('says nothing about a failure that a newer question has overtaken', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = setup()
    t.ask()
    t.ask()

    t.pending[0]!.fail(new Error('no answer'))
    await settle()

    expect(logged).not.toHaveBeenCalled()
  })
})
