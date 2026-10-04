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
