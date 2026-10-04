import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OllamaClient,
  OllamaError,
  hasRemoteFields,
  isLoopbackUrl,
} from '../../src/main/cleanup/ollama-client'

type Handler = (request: IncomingMessage, response: ServerResponse, body: string) => void

let server: Server | null = null

/** A stand-in Ollama server on a loopback port, answering as the test tells it to. */
async function serve(handlers: Record<string, Handler>): Promise<OllamaClient> {
  server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString()))
    request.on('end', () => {
      const handler = handlers[request.url ?? '']
      if (handler) handler(request, response, body)
      else response.writeHead(404).end(JSON.stringify({ error: 'not found' }))
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return new OllamaClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
}

afterEach(async () => {
  server?.closeAllConnections()
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)))
  server = null
})

const line = (object: unknown): string => `${JSON.stringify(object)}\n`
const piece = (content: string): string => line({ message: { role: 'assistant', content } })
const done = (extra: Record<string, unknown> = {}): string =>
  line({
    message: { role: 'assistant', content: '' },
    done: true,
    done_reason: 'stop',
    eval_count: 12,
    eval_duration: 400_000_000,
    load_duration: 5_000_000,
    ...extra,
  })

/** Sends the chunks as they are, a moment apart, so a line can arrive in two halves. */
function stream(chunks: string[], end = true): Handler {
  return (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/x-ndjson' })
    let index = 0
    const next = (): void => {
      if (index < chunks.length) {
        response.write(chunks[index++])
        setTimeout(next, 5)
      } else if (end) {
        response.end()
      }
    }
    next()
  }
}

const request = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], numPredict: 40 }

describe('chat', () => {
  it('joins the reply, even when a line arrives in two halves', async () => {
    const whole = piece('Hello ') + piece('there') + piece('.') + done()
    const client = await serve({
      '/api/chat': stream([whole.slice(0, 30), whole.slice(30, 77), whole.slice(77)]),
    })

    const result = await client.chat(request)

    expect(result).toMatchObject({
      content: 'Hello there.',
      doneReason: 'stop',
      remote: false,
      outputTokens: 12,
      generationMs: 400,
      loadMs: 5,
    })
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0)
  })

  it('sends what the contract requires: no thinking, a fixed context, no penalties', async () => {
    let sent: Record<string, unknown> = {}
    const client = await serve({
      '/api/chat': (incoming, response, body) => {
        sent = JSON.parse(body) as Record<string, unknown>
        stream([piece('ok'), done()])(incoming, response, body)
      },
    })

    await client.chat(request)

    expect(sent).toMatchObject({
      model: 'm',
      stream: true,
      think: false,
      keep_alive: '30m',
      options: {
        num_ctx: 4096,
        num_predict: 40,
        temperature: 0,
        presence_penalty: 0,
        repeat_penalty: 1,
      },
    })
  })

  it('discards thinking and keeps only the answer', async () => {
    const client = await serve({
      '/api/chat': stream([
        line({ message: { role: 'assistant', content: '', thinking: 'Let me think about this' } }),
        piece('Answer.'),
        done(),
      ]),
    })

    expect((await client.chat(request)).content).toBe('Answer.')
  })

  it('reports a failure that arrives after the reply has started', async () => {
    const client = await serve({
      '/api/chat': stream([piece('Half a sen'), line({ error: 'model runner has stopped' })]),
    })

    await expect(client.chat(request)).rejects.toMatchObject({
      kind: 'stream',
      message: 'model runner has stopped',
    })
  })

  it('reports a line that is not JSON', async () => {
    const client = await serve({ '/api/chat': stream(['<html>proxy error</html>\n']) })

    await expect(client.chat(request)).rejects.toMatchObject({ kind: 'stream' })
  })

  it.each([
    ['an empty response', ''],
    [
      'an unfinished response',
      line({ message: { role: 'assistant', content: 'Hello' }, done: false }),
    ],
    ['content with no completion record', piece('Hello')],
  ])('reports %s as an incomplete stream', async (_name, reply) => {
    const client = await serve({ '/api/chat': stream([reply]) })

    await expect(client.chat(request)).rejects.toMatchObject({
      kind: 'stream',
      message: 'Ollama ended the chat reply before completion',
    })
  })

  it('reports a model that is not installed', async () => {
    const client = await serve({
      '/api/chat': (_request, response) =>
        response.writeHead(404).end(JSON.stringify({ error: 'model "m" not found' })),
    })

    await expect(client.chat(request)).rejects.toMatchObject({
      kind: 'http',
      message: expect.stringContaining('model "m" not found') as string,
    })
  })

  it('reports that nothing is listening', async () => {
    const client = new OllamaClient('http://127.0.0.1:9')

    const error = await client.chat(request).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(OllamaError)
    expect(error).toMatchObject({ kind: 'unreachable' })
  })

  it('stops when the caller cancels, and says so', async () => {
    const client = await serve({ '/api/chat': stream([piece('Still writ')], false) })
    const cancel = new AbortController()
    setTimeout(() => cancel.abort(), 40)

    await expect(client.chat({ ...request, signal: cancel.signal })).rejects.toMatchObject({
      kind: 'aborted',
    })
  })

  it('can give up part-way without that being an error', async () => {
    let closed = false
    const client = await serve({
      '/api/chat': (incoming, response, body) => {
        response.on('close', () => (closed = true))
        stream([piece('I am '), piece('sorry, '), piece('but '), piece('as an AI')], false)(
          incoming,
          response,
          body,
        )
      },
    })
    const seen: string[] = []

    const result = await client.chat({
      ...request,
      onContent: (soFar) => {
        seen.push(soFar)
        return !soFar.includes('sorry')
      },
    })

    expect(result.doneReason).toBe('abandoned')
    expect(seen).toEqual(['I am ', 'I am sorry, '])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(closed).toBe(true)
  })

  it('notices a reply that came from another machine', async () => {
    const client = await serve({
      '/api/chat': stream([
        piece('Text.'),
        done({ remote_host: 'https://ollama.com', remote_model: 'x' }),
      ]),
    })

    expect((await client.chat(request)).remote).toBe(true)
  })
})

describe('server information', () => {
  it('reads the version, and returns null when nothing answers', async () => {
    const client = await serve({
      '/api/version': (_request, response) => response.end(JSON.stringify({ version: '0.35.1' })),
    })

    expect(await client.version()).toBe('0.35.1')
    expect(await new OllamaClient('http://127.0.0.1:9').version()).toBeNull()
  })

  it('returns null when the server is too slow to say', async () => {
    const client = await serve({ '/api/version': () => {} })

    expect(await client.version(50)).toBeNull()
  })

  it('lists models with what they can do and where they would run', async () => {
    const client = await serve({
      '/api/tags': (_request, response) =>
        response.end(
          JSON.stringify({
            models: [
              {
                name: 'qwen3.5:4b',
                digest: 'abc',
                capabilities: ['completion', 'thinking'],
                details: { parameter_size: '4.7B' },
              },
              { name: 'cloud:latest', digest: 'def', remote_host: 'https://ollama.com' },
              { broken: true },
            ],
          }),
        ),
    })

    expect(await client.models()).toEqual([
      {
        name: 'qwen3.5:4b',
        digest: 'abc',
        capabilities: ['completion', 'thinking'],
        parameterSize: '4.7B',
        remote: false,
      },
      { name: 'cloud:latest', digest: 'def', capabilities: [], parameterSize: null, remote: true },
    ])
  })

  it('reads one model, and reports one that is missing', async () => {
    const client = await serve({
      '/api/show': (_request, response, body) => {
        const { model } = JSON.parse(body) as { model: string }
        if (model === 'gone') response.writeHead(404).end(JSON.stringify({ error: 'not found' }))
        else
          response.end(JSON.stringify({ capabilities: ['completion'], remote_model: 'big:cloud' }))
      },
    })

    expect(await client.show('alias')).toEqual({ capabilities: ['completion'], remote: true })
    await expect(client.show('gone')).rejects.toMatchObject({ kind: 'http' })
  })
})

describe('a server that answers with a redirect', () => {
  let elsewhere: Server | null = null
  /** What reached the address the redirects point to. Nothing should. */
  let arrived: Array<{ url: string; body: string }> = []

  /** A second server, standing in for wherever a redirect might lead. */
  async function elsewhereUrl(): Promise<string> {
    arrived = []
    elsewhere = createServer((incoming, response) => {
      let body = ''
      incoming.on('data', (chunk: Buffer) => (body += chunk.toString()))
      incoming.on('end', () => {
        arrived.push({ url: incoming.url ?? '', body })
        response.writeHead(200, { 'content-type': 'application/x-ndjson' })
        response.end(piece('forwarded') + done())
      })
    })
    await new Promise<void>((resolve) => elsewhere!.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}`
  }

  const redirectTo =
    (location: string, status: number): Handler =>
    (_request, response) => {
      response.writeHead(status, { location })
      response.end()
    }

  afterEach(async () => {
    elsewhere?.closeAllConnections()
    await new Promise((resolve) => (elsewhere ? elsewhere.close(resolve) : resolve(null)))
    elsewhere = null
  })

  it.each([307, 308, 301, 302, 303])(
    'does not take the chat request, or the text in it, where a %i points',
    async (status) => {
      const target = await elsewhereUrl()
      const client = await serve({ '/api/chat': redirectTo(`${target}/api/chat`, status) })

      const outcome = client.chat({
        model: 'm',
        messages: [{ role: 'user', content: 'TEXT THAT MUST STAY HERE' }],
        numPredict: 40,
      })

      await expect(outcome).rejects.toMatchObject({ name: 'OllamaError', kind: 'redirect' })
      // Long enough for a followed redirect to have arrived.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(arrived).toEqual([])
    },
  )

  it('does not follow one when listing models or reading one', async () => {
    const target = await elsewhereUrl()
    const client = await serve({
      '/api/tags': redirectTo(`${target}/api/tags`, 302),
      '/api/show': redirectTo(`${target}/api/show`, 307),
    })

    await expect(client.models()).rejects.toMatchObject({ kind: 'redirect' })
    await expect(client.show('qwen3.5:4b')).rejects.toMatchObject({ kind: 'redirect' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(arrived).toEqual([])
  })

  it('does not follow one when asking for the version or warming a model', async () => {
    const target = await elsewhereUrl()
    const client = await serve({
      '/api/version': redirectTo(`${target}/api/version`, 302),
      '/api/chat': redirectTo(`${target}/api/chat`, 307),
    })

    expect(await client.version()).toBeNull()
    expect(await client.warm('m', [{ role: 'system', content: 'instructions' }])).toEqual({
      remote: false,
      redirected: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(arrived).toEqual([])
  })

  it('refuses a redirect that points back at this machine all the same', async () => {
    const client = await serve({
      '/api/chat': redirectTo('/api/somewhere-else', 307),
      '/api/somewhere-else': stream([piece('followed'), done()]),
    })

    await expect(client.chat(request)).rejects.toMatchObject({ kind: 'redirect' })
  })
})

describe('a reply that names another machine', () => {
  const remoteLine = line({
    message: { role: 'assistant', content: 'Te' },
    remote_host: 'https://ollama.com',
  })
  /** How many pieces of the reply the server got to send before the reading stopped. */
  let written = 0
  const counted = (chunks: string[]): Handler => {
    written = 0
    return (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' })
      const next = (index: number): void => {
        if (index >= chunks.length || response.destroyed) return
        written += 1
        response.write(chunks[index])
        setTimeout(() => next(index + 1), 30)
      }
      next(0)
    }
  }

  it('is read no further than the line that says so', async () => {
    const client = await serve({
      '/api/chat': counted([remoteLine, piece('xt that is'), piece(' never wanted.'), done()]),
    })

    const result = await client.chat(request)

    expect(result).toMatchObject({ remote: true, doneReason: 'abandoned' })
    expect(result.content).toBe('')
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(written).toBeLessThan(4)
  })

  it('has said so even if an error line follows', async () => {
    const client = await serve({
      '/api/chat': stream([remoteLine + line({ error: 'model runner has stopped' })]),
    })

    expect((await client.chat(request)).remote).toBe(true)
  })

  it('has said so even if the error is on the same line', async () => {
    const client = await serve({
      '/api/chat': stream([line({ error: 'upstream failed', remote_model: 'big:cloud' })]),
    })

    expect((await client.chat(request)).remote).toBe(true)
  })

  it('has said so even if the rest never comes', async () => {
    // The first line, and then silence with the connection left open.
    const client = await serve({ '/api/chat': stream([remoteLine], false) })

    const result = await client.chat({ ...request, signal: AbortSignal.timeout(2_000) })

    expect(result.remote).toBe(true)
  })

  it('is reported by a warm-up, whatever would have followed', async () => {
    const client = await serve({
      '/api/chat': stream([remoteLine, line({ error: 'model runner has stopped' })]),
    })

    expect(await client.warm('m', [{ role: 'system', content: 'instructions' }])).toEqual({
      remote: true,
      redirected: false,
    })
  })

  it('does not make a local reply that fails look remote', async () => {
    const client = await serve({
      '/api/chat': stream([piece('Te'), line({ error: 'model runner has stopped' })]),
    })

    await expect(client.chat(request)).rejects.toMatchObject({ kind: 'stream' })
  })
})

describe('warming a model', () => {
  it('says where the reply came from', async () => {
    const local = await serve({ '/api/chat': stream([piece('x'), done()]) })
    expect(await local.warm('m', [{ role: 'system', content: 'instructions' }])).toEqual({
      remote: false,
      redirected: false,
    })
    server?.closeAllConnections()
    await new Promise((resolve) => server!.close(resolve))

    const remote = await serve({
      '/api/chat': stream([piece('x'), done({ remote_host: 'https://ollama.com' })]),
    })
    expect(await remote.warm('m', [{ role: 'system', content: 'instructions' }])).toEqual({
      remote: true,
      redirected: false,
    })
  })

  it('answers null, and does not throw, when the model cannot be reached', async () => {
    const client = new OllamaClient('http://127.0.0.1:9')

    expect(await client.warm('m', [{ role: 'system', content: 'instructions' }])).toBeNull()
  })

  it.each([
    ['an empty response', ''],
    ['whitespace only', '\n  \n'],
    ['an unfinished response', line({ message: { role: 'assistant', content: 'x' }, done: false })],
    ['content with no completion record', piece('x')],
    ['invalid JSON', '<html>proxy error</html>\n'],
    ['a JSON null', line(null)],
    ['a JSON array', line([])],
    ['a JSON primitive', line(true)],
    ['an unrelated JSON object', line({ ready: true })],
    ['a missing terminal message', line({ done: true })],
    ['an invalid message', done({ message: { role: 'assistant', content: 1 } })],
    ['an invalid message role', done({ message: { role: 'user', content: '' } })],
    ['an invalid done flag', done({ done: 'true' })],
    ['an invalid completion reason', done({ done_reason: 1 })],
    ['malformed data before completion', line({ unexpected: true }) + done()],
    ['content after completion', done() + piece('x')],
    ['two completion records', done() + done()],
    ['an error after completion', done() + line({ error: 'failed' })],
  ])('does not establish locality from %s', async (_name, reply) => {
    const client = await serve({ '/api/chat': stream([reply]) })

    expect(await client.warm('m', [{ role: 'system', content: 'instructions' }])).toBeNull()
  })

  it.each([[0xc2], [0xe2, 0x82]])(
    'rejects truncated UTF-8 bytes after an otherwise complete reply (%j)',
    async (...tail) => {
      const client = await serve({
        '/api/chat': (_request, response) => {
          response.writeHead(200, { 'content-type': 'application/x-ndjson' })
          response.end(Buffer.concat([Buffer.from(done()), Buffer.from(tail)]))
        },
      })

      expect(await client.warm('m', [{ role: 'system', content: 'instructions' }])).toBeNull()
    },
  )

  it('still reports remote metadata before truncated UTF-8 bytes', async () => {
    const client = await serve({
      '/api/chat': (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' })
        response.end(
          Buffer.concat([
            Buffer.from(line({ remote_host: 'https://ollama.com' })),
            Buffer.from([0xc2]),
          ]),
        )
      },
    })

    expect(await client.warm('m', [{ role: 'system', content: 'instructions' }])).toEqual({
      remote: true,
      redirected: false,
    })
  })

  it.each([
    ['a token limit completion', piece('x') + done({ done_reason: 'length' })],
    ['an empty completed reply', done()],
    ['a completion without an optional reason', done({ done_reason: undefined })],
    ['a terminal record without a trailing newline', done().trimEnd()],
  ])('establishes locality from %s', async (_name, reply) => {
    const client = await serve({ '/api/chat': stream([reply]) })

    expect(await client.warm('m', [{ role: 'system', content: 'instructions' }])).toEqual({
      remote: false,
      redirected: false,
    })
  })

  it.each([
    ['without completion', line({ remote_host: 'https://ollama.com', done: false })],
    ['with malformed chat data', line({ remote_host: 'https://ollama.com', message: 1 })],
    ['followed by malformed data', line({ remote_host: 'https://ollama.com' }) + 'not json\n'],
    ['after a local completion record', done() + line({ remote_model: 'big:cloud' })],
  ])('still reports remote execution %s', async (_name, reply) => {
    const client = await serve({ '/api/chat': stream([reply]) })

    expect(await client.warm('m', [{ role: 'system', content: 'instructions' }])).toEqual({
      remote: true,
      redirected: false,
    })
  })
})

describe('hasRemoteFields', () => {
  it('is true only when a remote host or model is named', () => {
    expect(hasRemoteFields({ remote_host: 'https://ollama.com' })).toBe(true)
    expect(hasRemoteFields({ remote_model: 'gpt-oss:120b' })).toBe(true)
    expect(hasRemoteFields({ remote_host: '', remote_model: '' })).toBe(false)
    expect(hasRemoteFields({ name: 'local' })).toBe(false)
    expect(hasRemoteFields(null)).toBe(false)
  })
})

describe('isLoopbackUrl', () => {
  it.each([
    ['http://127.0.0.1:11434', true],
    ['http://localhost:11434', true],
    ['http://[::1]:11434', true],
    ['http://127.8.9.10', true],
    ['http://192.168.1.20:11434', false],
    ['https://ollama.com', false],
    ['http://127.0.0.1.evil.example', false],
    ['not a url', false],
  ])('%s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected)
  })
})
