import { describe, expect, it } from 'vitest'
import type { PasteOutcome } from '@shared/helper-protocol'
import { RecoveryBuffer, type RecoveryEntry } from '../../src/main/dictation/recovery-buffer'
import { SessionController, type ProducedText } from '../../src/main/dictation/session-controller'

/** Lets every pending promise callback run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A controller whose every dictation says `said`, and whose pastes end as `outcome` says. */
function setup(outcome: { value: PasteOutcome } = { value: 'pasted' }) {
  const recorded: RecoveryEntry[] = []
  const fetched: Array<[number, string]> = []
  let said = 'hello there'
  let clock = 0
  const controller = new SessionController({
    startRecording: () => {},
    produceText: (): Promise<ProducedText | null> =>
      Promise.resolve(said ? { raw: said, final: said } : null),
    captureTarget: () => Promise.resolve({ targetId: 1, secure: false, appName: 'Notes' }),
    paste: () => Promise.resolve({ outcome: outcome.value }),
    armEscape: () => {},
    writeClipboard: () => Promise.resolve(),
    notify: () => {},
    now: () => clock,
    onRecorded: (entry) => recorded.push(entry),
    onFetched: (sessionId, how) => fetched.push([sessionId, how]),
  })
  const dictate = async (text = 'hello there'): Promise<void> => {
    said = text
    controller.dispatch({ type: 'pttDown', t: (clock += 1_000) })
    controller.dispatch({ type: 'pttUp', t: (clock += 1_000) })
    await settle()
  }
  return { controller, recorded, fetched, dictate, outcome }
}

describe('what the history is kept from', () => {
  it('hears of every session as it is recorded, with the app it was meant for', async () => {
    const t = setup()

    await t.dictate()

    expect(t.recorded).toHaveLength(1)
    expect(t.recorded[0]).toMatchObject({
      sessionId: 1,
      outcome: 'pasted',
      finalText: 'hello there',
      appName: 'Notes',
    })
  })

  it('hears of a session that left no text, and of one that was cancelled', async () => {
    const t = setup()

    await t.dictate('')
    t.controller.dispatch({ type: 'pttDown', t: 10_000 })
    t.controller.dispatch({ type: 'escape' })

    expect(t.recorded.map((entry) => entry.outcome)).toEqual(['noSpeech', 'cancelled'])
  })

  it('does not hear of a tap that was no dictation at all', async () => {
    const t = setup()

    t.controller.dispatch({ type: 'pttDown', t: 0 })
    t.controller.dispatch({ type: 'pttUp', t: 100 })
    t.controller.dispatch({ type: 'tapTimeout' })
    await settle()

    expect(t.recorded).toEqual([])
  })

  it('hears when text that was not pasted is fetched with paste-last', async () => {
    const t = setup({ value: 'targetChanged' })
    await t.dictate()
    expect(t.recorded.at(-1)?.outcome).toBe('targetChanged')

    t.outcome.value = 'pasted'
    t.controller.dispatch({ type: 'pasteLast' })
    await settle()

    expect(t.fetched).toEqual([[1, 'pasted']])
  })

  it('hears when it is copied instead', async () => {
    const t = setup({ value: 'secureField' })
    await t.dictate()

    t.controller.dispatch({ type: 'copyLast' })
    await settle()

    expect(t.fetched).toEqual([[1, 'copied']])
  })

  it('says nothing of a fetch for a dictation that was pasted in the first place', async () => {
    const t = setup()
    await t.dictate()

    t.controller.dispatch({ type: 'pasteLast' })
    t.controller.dispatch({ type: 'copyLast' })
    await settle()

    expect(t.fetched).toEqual([])
  })
})

describe('the recovery buffer', () => {
  it('says so when a session is recorded, replaced, or given text late', () => {
    const changes: RecoveryEntry[] = []
    const buffer = new RecoveryBuffer(20, (entry) => changes.push(entry))
    const cancelled: RecoveryEntry = {
      sessionId: 3,
      endedAt: 1,
      outcome: 'cancelled',
      rawText: null,
      finalText: null,
    }

    buffer.record(cancelled)
    buffer.fill(3, { rawText: 'late words', finalText: 'Late words.' })
    buffer.record({ ...cancelled, endedAt: 2, outcome: 'failed' })

    expect(changes.map((entry) => [entry.outcome, entry.finalText])).toEqual([
      ['cancelled', null],
      ['cancelled', 'Late words.'],
      // An attempt that ends with no text does not take away what an earlier one left.
      ['failed', 'Late words.'],
    ])
  })
})
