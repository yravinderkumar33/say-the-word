// Current-source sign-off probes. Synthetic protocol responses only: no sockets,
// microphone, clipboard, focus changes, settings writes, or transcript output.
import assert from 'node:assert/strict'
import { OllamaClient } from '../../src/main/cleanup/ollama-client.ts'
import { LocalOnlyGate } from '../../src/main/cleanup/local-only.ts'
import { Refiner } from '../../src/main/cleanup/refiner.ts'

const synthetic = 'Please bring the report to the meeting today'
const json = (value: unknown): Response => new Response(JSON.stringify(value))
type Scenario =
  | 'baseline-remote'
  | 'changed-digest'
  | 'changed-during-warm'
  | 'empty-warm'
  | 'incomplete-warm'
  | 'malformed-warm'
  | 'incomplete-remote-warm'
  | 'local-length-warm'

async function probe(scenario: Scenario): Promise<void> {
  let digest = 'one'
  let warmRequests = 0
  let transcriptRequests = 0
  let showRequests = 0
  const sent: string[] = []
  const client = new OllamaClient(undefined, (async (input, init) => {
    assert.equal(init?.redirect, 'manual')
    if (String(input).endsWith('/api/tags')) {
      return json({ models: [{ name: 'qa:latest', digest }] })
    }
    if (String(input).endsWith('/api/show')) {
      showRequests += 1
      return json({ capabilities: ['completion'] })
    }
    assert.equal(String(input).endsWith('/api/chat'), true)
    const request = JSON.parse(String(init?.body)) as {
      messages: Array<{ content: string }>
    }
    const isTranscript = request.messages.some((message) => message.content.includes(synthetic))
    if (isTranscript) {
      transcriptRequests += 1
      sent.push(`${digest}:transcript`)
    } else {
      warmRequests += 1
      sent.push(`${digest}:warm`)
    }
    if (scenario === 'empty-warm' && !isTranscript) return new Response('')
    if (scenario === 'incomplete-warm' && !isTranscript) {
      return new Response(
        `${JSON.stringify({ done: false, message: { role: 'assistant', content: 'x' } })}\n`,
      )
    }
    if (scenario === 'malformed-warm' && !isTranscript) {
      return new Response(
        `${JSON.stringify({ done: 'true', message: { role: 'assistant', content: 'x' } })}\n`,
      )
    }
    const remote =
      scenario === 'baseline-remote' ||
      scenario === 'incomplete-remote-warm' ||
      (scenario.startsWith('changed-') && digest === 'two')
    const response = new Response(
      `${JSON.stringify({
        done: scenario !== 'incomplete-remote-warm',
        done_reason: scenario === 'local-length-warm' && !isTranscript ? 'length' : 'stop',
        ...(remote ? { remote_host: 'inert.test' } : {}),
        message: { role: 'assistant', content: isTranscript ? synthetic : 'x' },
      })}\n`,
    )
    if (scenario === 'changed-during-warm') digest = 'two'
    return response
  }) as typeof fetch)
  const gate = new LocalOnlyGate(client)
  const refiner = new Refiner({ client, gate, model: () => 'qa', dictionary: () => [] })

  // Original F11: capabilities omitted from tags, present in show. Now passes.
  assert.equal((await gate.localTextModels()).length, 1)
  assert.equal((await gate.localTextModels()).length, 1)
  assert.equal(showRequests, 1)

  if (scenario === 'changed-digest') {
    refiner.prewarm()
    // All fixture responses resolve synchronously; drain the promise continuations.
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(warmRequests, 1)
    digest = 'two'
  }
  const result = await refiner.refine(synthetic, new AbortController().signal)
  const incomplete = ['empty-warm', 'incomplete-warm', 'malformed-warm'].includes(scenario)
  const local = scenario === 'local-length-warm'
  assert.equal(result.note, local ? 'cleaned' : incomplete ? 'failed' : 'notLocal:blocked')
  assert.equal(warmRequests, scenario.startsWith('changed-') ? 2 : 1)
  // R2/R3 closure: all rejected warm-ups leave the transcript on this machine.
  assert.equal(transcriptRequests, local ? 1 : 0)
  if (scenario.startsWith('changed-')) assert.deepEqual(sent, ['one:warm', 'two:warm'])
  console.log(JSON.stringify({ scenario, warmRequests, transcriptRequests, showRequests, sent }))
}

for (const scenario of [
  'baseline-remote',
  'changed-digest',
  'changed-during-warm',
  'empty-warm',
  'incomplete-warm',
  'malformed-warm',
  'incomplete-remote-warm',
  'local-length-warm',
] as const) {
  await probe(scenario)
}

// Original F02: every request asks fetch not to follow redirects, and the redirect
// response is rejected. Actual two-origin forwarding is covered by the unit suite.
let redirectRequests = 0
const redirectingClient = new OllamaClient(undefined, (async (_input, init) => {
  assert.equal(init?.redirect, 'manual')
  redirectRequests += 1
  return new Response(null, { status: 307, headers: { Location: 'https://inert.test/unused' } })
}) as typeof fetch)
await assert.rejects(redirectingClient.models(), { kind: 'redirect' })
await assert.rejects(redirectingClient.show('qa'), { kind: 'redirect' })
await assert.rejects(
  redirectingClient.chat({
    model: 'qa',
    numPredict: 1,
    messages: [{ role: 'system', content: 'synthetic instructions' }],
  }),
  { kind: 'redirect' },
)
assert.equal(await redirectingClient.version(), null)
assert.deepEqual(await redirectingClient.warm('qa', []), {
  remote: false,
  redirected: true,
})
assert.equal(redirectRequests, 5)
console.log(JSON.stringify({ scenario: 'redirect-refusal', redirectRequests, passed: true }))
