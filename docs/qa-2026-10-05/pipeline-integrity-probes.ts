/** Synthetic inputs only. Prints counts and case IDs, never transcript text. */
import assert from 'node:assert/strict'
import { checkCleanup } from '../../src/main/cleanup/guard'
import { Refiner } from '../../src/main/cleanup/refiner'

const cases = [
  {
    id: 'negative-number-sign-lost',
    input: 'The freezer should be set to -15 degrees today.',
    output: 'The freezer should be set to 15 degrees today.',
  },
  {
    id: 'currency-changed',
    input: 'Please send the contractor $500 by Friday morning.',
    output: 'Please send the contractor €500 by Friday morning.',
  },
  {
    id: 'percentage-marker-lost',
    input: 'Please apply a 5% discount to this invoice today.',
    output: 'Please apply a 5 discount to this invoice today.',
  },
]

async function main(): Promise<void> {
  for (const sample of cases) {
    assert.equal(checkCleanup({ ...sample, doneReason: 'stop' }).ok, true)
    const identity = { server: 'http://127.0.0.1:11434', model: 'qa:latest', digest: 'synthetic' }
    const refiner = new Refiner({
      client: {
        url: identity.server,
        warm: async () => ({ remote: false, redirected: false }),
        chat: async () => ({
          content: sample.output,
          doneReason: 'stop',
          remote: false,
          firstTokenMs: 1,
          totalMs: 2,
          outputTokens: 12,
          generationMs: 2,
          loadMs: 0,
        }),
      },
      gate: {
        check: async () => ({ local: true, identity }),
        block: () => {},
        sawRedirect: () => {},
      },
      model: () => identity.model,
      dictionary: () => [],
    })
    const result = await refiner.refine(sample.input, new AbortController().signal)
    assert.equal(result.note, 'cleaned')
    assert.equal(result.final, sample.output)
    assert.notEqual(result.final, result.raw)
    console.log(JSON.stringify({ case: sample.id, guardAccepted: true, refinerAccepted: true }))
  }
  console.log(JSON.stringify({ confirmedIntegrityFailures: cases.length }))

  // Try it allows 20 s, while a real dictation allows 4 s. A slow first token
  // learned there poisons the shared estimate even after selecting a faster model.
  let clock = 0
  let selected = 'slow:latest'
  let chats = 0
  const sentence = 'Please send the report to the team this morning.'
  const speedRefiner = new Refiner({
    client: {
      url: 'http://127.0.0.1:11434',
      warm: async () => ({ remote: false, redirected: false }),
      chat: async () => {
        chats += 1
        clock += 12_005
        return {
          content: sentence,
          doneReason: 'stop',
          remote: false,
          firstTokenMs: 12_000,
          totalMs: 12_005,
          outputTokens: 12,
          generationMs: 5,
          loadMs: 0,
        }
      },
    },
    gate: {
      check: async () => ({
        local: true,
        identity: {
          server: 'http://127.0.0.1:11434',
          model: selected,
          digest: selected,
        },
      }),
      block: () => {},
      sawRedirect: () => {},
    },
    model: () => selected,
    dictionary: () => [],
    now: () => clock,
  })
  const patient = await speedRefiner.refine(sentence, new AbortController().signal, {
    patient: true,
  })
  assert.equal(patient.note, 'cleaned')
  selected = 'fast:latest'
  const subsequent = await speedRefiner.refine(sentence, new AbortController().signal)
  assert.equal(subsequent.note, 'tooLong')
  const retried = await speedRefiner.refine(sentence, new AbortController().signal, {
    patient: true,
  })
  assert.equal(retried.note, 'tooLong')
  assert.equal(chats, 1)
  console.log(
    JSON.stringify({
      case: 'slow-try-disables-all-subsequent-model-cleanup',
      initialAccepted: true,
      subsequentNote: subsequent.note,
      differentModelPatientNote: retried.note,
      totalChatCalls: chats,
    }),
  )
}

void main()
