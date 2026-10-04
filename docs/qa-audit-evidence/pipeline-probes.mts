// Synthetic QA probes. Run with the command in pipeline-readme.md.
// Only the redirect probe opens sockets, both on ephemeral 127.0.0.1 ports.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { OllamaClient } from '../../src/main/cleanup/ollama-client.ts'
import { LocalOnlyGate } from '../../src/main/cleanup/local-only.ts'
import { Refiner } from '../../src/main/cleanup/refiner.ts'

// `capabilities` is optional in upstream ListModelResponse. Exercise a server
// that omits it, rather than claiming all current Ollama servers omit it.
const fixtureModel = {
  name: 'qa-local:latest',
  digest: 'qa-digest',
  details: { parameter_size: '1B' },
}
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
let chatCalls = 0
let transcriptRequests = 0
const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
  const path = String(input)
  if (path.endsWith('/api/tags')) return json({ models: [fixtureModel] })
  if (path.endsWith('/api/show')) return json({ capabilities: ['completion'] })
  if (path.endsWith('/api/chat')) {
    chatCalls += 1
    const request = JSON.parse(String(init?.body))
    if (
      request.messages.some((m: { content: string }) =>
        m.content.includes('Please bring the report to the meeting today'),
      )
    )
      transcriptRequests += 1
    return new Response(
      JSON.stringify({
        done: true,
        done_reason: 'stop',
        remote_host: 'remote.test',
        message: { content: 'qa' },
      }) + '\n',
    )
  }
  throw new Error('unexpected')
}
const client = new OllamaClient(undefined, fetchImpl as typeof fetch)
const gate = new LocalOnlyGate(client)
const allowed = await gate.check('qa-local')
assert.equal(allowed.local, true)
const choices = await gate.localTextModels()
assert.equal(choices.length, 0)
console.log(
  'CONFIRMED model picker: valid local completion model is accepted by check(), but localTextModels() returns zero choices when optional /api/tags capabilities is absent',
)
const refiner = new Refiner({ client, gate, model: () => 'qa-local', dictionary: () => [] })
refiner.prewarm()
await new Promise((resolve) => setTimeout(resolve, 10))
assert.equal(chatCalls, 1)
assert.equal((await gate.check('qa-local')).local, true)
await refiner.refine('Please bring the report to the meeting today', new AbortController().signal)
assert.equal(transcriptRequests, 1)
console.log(
  'CONFIRMED warm privacy: remote_host in warm-up response is ignored; next refine sends transcript (then blocks model only after response)',
)

let forwarded = false
const sink = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) body += chunk
  forwarded = body.includes('QA_SYNTHETIC_MARKER')
  res.setHeader('content-type', 'application/x-ndjson')
  res.end(JSON.stringify({ done: true, done_reason: 'stop', message: { content: 'ok' } }) + '\n')
})
let sinkPort = 0
const origin = createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.end(JSON.stringify({ models: [fixtureModel] }))
    return
  }
  if (req.url === '/api/show') {
    res.end(JSON.stringify({ capabilities: ['completion'] }))
    return
  }
  res.writeHead(307, { Location: `http://127.0.0.1:${sinkPort}/redirected-chat` })
  res.end()
})
try {
  sink.listen(0, '127.0.0.1')
  await once(sink, 'listening')
  sinkPort = (sink.address() as { port: number }).port
  origin.listen(0, '127.0.0.1')
  await once(origin, 'listening')
  const url = `http://127.0.0.1:${(origin.address() as { port: number }).port}`
  const redirectedClient = new OllamaClient(url)
  assert.equal((await new LocalOnlyGate(redirectedClient).check('qa-local')).local, true)
  await redirectedClient.chat({
    model: 'qa-local',
    numPredict: 1,
    messages: [{ role: 'user', content: 'QA_SYNTHETIC_MARKER' }],
    signal: AbortSignal.timeout(2_000),
  })
  assert.equal(forwarded, true)
  console.log(
    'CONFIRMED redirect privacy: validated loopback server 307 forwards entire chat body to an unvalidated second origin; no user data or external host was contacted',
  )
} finally {
  origin.closeAllConnections()
  sink.closeAllConnections()
  origin.close()
  sink.close()
}
