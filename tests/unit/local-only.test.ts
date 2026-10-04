import { describe, expect, it } from 'vitest'
import { LocalOnlyGate } from '../../src/main/cleanup/local-only'
import { OllamaClient, OllamaError, type OllamaModel } from '../../src/main/cleanup/ollama-client'

const model = (name: string, extra: Partial<OllamaModel> = {}): OllamaModel => ({
  name,
  digest: `digest-of-${name}`,
  capabilities: ['completion'],
  parameterSize: '4B',
  remote: false,
  ...extra,
})

type Details = { capabilities: string[]; remote: boolean }

function setup(options: { url?: string; allowRemoteServer?: boolean } = {}) {
  const state = {
    models: [model('qwen3.5:4b'), model('cloud:latest', { remote: true })] as OllamaModel[] | Error,
    show: { capabilities: ['completion'], remote: false } as Details | Error,
    /** Details for particular models; the rest get `show`. */
    showFor: {} as Record<string, Details | Error>,
    clock: 0,
    url: options.url ?? 'http://127.0.0.1:11434',
  }
  const calls = { models: 0, show: [] as string[], chat: 0 }
  const client = {
    get url() {
      return state.url
    },
    models: () => {
      calls.models += 1
      return state.models instanceof Error
        ? Promise.reject(state.models)
        : Promise.resolve(state.models)
    },
    show: (name: string) => {
      calls.show.push(name)
      const details = state.showFor[name] ?? state.show
      return details instanceof Error ? Promise.reject(details) : Promise.resolve(details)
    },
    chat: () => {
      calls.chat += 1
      return Promise.reject(new Error('the gate must never talk to a model'))
    },
  } as unknown as OllamaClient
  const gate = new LocalOnlyGate(
    client,
    () => state.clock,
    () => options.allowRemoteServer ?? false,
  )
  return { gate, state, calls, client }
}

describe('LocalOnlyGate', () => {
  it('accepts a model that runs on this machine', async () => {
    const t = setup()

    expect(await t.gate.check('qwen3.5:4b')).toEqual({
      local: true,
      identity: { server: t.state.url, model: 'qwen3.5:4b', digest: 'digest-of-qwen3.5:4b' },
    })
    expect(t.calls.chat).toBe(0)
  })

  it('refuses a model the list marks as remote, without asking further', async () => {
    const t = setup()

    expect(await t.gate.check('cloud:latest')).toEqual({ local: false, reason: 'remote' })
    expect(t.calls.show).toEqual([])
  })

  it('refuses an alias whose details name a remote model, whatever it is called', async () => {
    const t = setup()
    t.state.models = [model('my-innocent-name:latest')]
    t.state.show = { capabilities: ['completion'], remote: true }

    expect(await t.gate.check('my-innocent-name')).toEqual({ local: false, reason: 'remote' })
  })

  it('refuses a model that is not installed, or cannot write text', async () => {
    const t = setup()
    expect(await t.gate.check('missing:1b')).toEqual({ local: false, reason: 'notInstalled' })

    t.state.models = [model('embed:latest', { capabilities: ['embedding'] })]
    t.state.show = { capabilities: ['embedding'], remote: false }
    expect(await t.gate.check('embed:latest')).toEqual({ local: false, reason: 'notATextModel' })
  })

  it('says so when Ollama does not answer, and remembers nothing from that', async () => {
    const t = setup()
    t.state.models = new OllamaError('unreachable', 'connection refused')
    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'unreachable' })

    t.state.models = [model('qwen3.5:4b')]
    expect(await t.gate.check('qwen3.5:4b')).toEqual({
      local: true,
      identity: { server: t.state.url, model: 'qwen3.5:4b', digest: 'digest-of-qwen3.5:4b' },
    })
  })

  it('asks for the details once, then again when a minute has passed', async () => {
    const t = setup()
    await t.gate.check('qwen3.5:4b')
    await t.gate.check('qwen3.5:4b')
    expect(t.calls.show).toHaveLength(1)

    t.state.clock += 61_000
    await t.gate.check('qwen3.5:4b')
    expect(t.calls.show).toHaveLength(2)
  })

  it('checks again at once when the model behind the name has changed', async () => {
    const t = setup()
    await t.gate.check('qwen3.5:4b')

    t.state.models = [model('qwen3.5:4b', { digest: 'a-different-model' })]
    t.state.show = { capabilities: ['completion'], remote: true }

    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'remote' })
  })

  it('returns the changed digest even when both sets of metadata say local', async () => {
    const t = setup()
    await t.gate.check('qwen3.5:4b')
    t.state.models = [model('qwen3.5:4b', { digest: 'replacement' })]

    expect(await t.gate.check('qwen3.5:4b')).toEqual({
      local: true,
      identity: { server: t.state.url, model: 'qwen3.5:4b', digest: 'replacement' },
    })
    expect(t.calls.show).toHaveLength(2)
  })

  it('cannot verify a model whose list entry supplies no digest', async () => {
    const t = setup()
    t.state.models = [model('qwen3.5:4b', { digest: '' })]

    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'unreachable' })
    expect(t.calls.show).toHaveLength(0)
  })

  it('does not share a metadata verdict between servers with the same name and digest', async () => {
    const t = setup()
    await t.gate.check('qwen3.5:4b')
    t.state.url = 'http://127.0.0.1:11500'
    t.state.show = { capabilities: ['completion'], remote: true }

    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'remote' })
    expect(t.calls.show).toHaveLength(2)
  })

  it.each(['models', 'show'] as const)(
    'fails closed if the server changes while %s is pending',
    async (operation) => {
      const t = setup()
      const original = t.client[operation].bind(t.client)
      t.client[operation] = (async (name: string) => {
        const result = await (original as (name: string) => Promise<unknown>)(name)
        t.state.url = 'http://127.0.0.1:11500'
        return result
      }) as typeof t.client.models & typeof t.client.show

      expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'unreachable' })
    },
  )

  it('treats a name without a tag as :latest', async () => {
    const t = setup()
    t.state.models = [model('gemma:latest')]

    expect(await t.gate.check('gemma')).toEqual({
      local: true,
      identity: { server: t.state.url, model: 'gemma:latest', digest: 'digest-of-gemma:latest' },
    })
  })

  it('refuses a server that is not on this machine, unless the user chose it', async () => {
    const elsewhere = setup({ url: 'http://192.168.1.20:11434' })
    expect(await elsewhere.gate.check('qwen3.5:4b')).toEqual({
      local: false,
      reason: 'serverNotLocal',
    })
    expect(elsewhere.calls.models).toBe(0)

    const chosen = setup({ url: 'http://192.168.1.20:11434', allowRemoteServer: true })
    expect((await chosen.gate.check('qwen3.5:4b')).local).toBe(true)
  })

  it('does not ask a server elsewhere for its model list either', async () => {
    const elsewhere = setup({ url: 'http://192.168.1.20:11434' })
    expect(await elsewhere.gate.localTextModels()).toEqual([])
    expect(elsewhere.calls.models).toBe(0)

    const chosen = setup({ url: 'http://192.168.1.20:11434', allowRemoteServer: true })
    expect((await chosen.gate.localTextModels()).map((entry) => entry.name)).toEqual(['qwen3.5:4b'])
  })

  it('never uses a model again once a reply from it came from elsewhere', async () => {
    const t = setup()
    expect((await t.gate.check('qwen3.5:4b')).local).toBe(true)

    t.gate.block('qwen3.5:4b')

    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'blocked' })
    expect((await t.gate.localTextModels()).map((entry) => entry.name)).toEqual([])
  })

  it('blocks the model under every spelling of its name', async () => {
    const t = setup()
    t.state.models = [model('looks-local:latest')]

    // Blocked under the name as it stands in the settings, without its tag.
    t.gate.block('looks-local')

    expect(await t.gate.check('looks-local')).toEqual({ local: false, reason: 'blocked' })
    expect(await t.gate.check('looks-local:latest')).toEqual({ local: false, reason: 'blocked' })
    // And the menu does not offer it under the name the list gives it.
    expect(await t.gate.localTextModels()).toEqual([])
  })

  it('attributes a late block to the server that produced the reply', async () => {
    const t = setup()
    const originalServer = t.state.url
    t.state.url = 'http://127.0.0.1:11500'
    t.gate.block('qwen3.5:4b', originalServer)

    expect((await t.gate.check('qwen3.5:4b')).local).toBe(true)
    t.state.url = originalServer
    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'blocked' })
  })

  it('offers only local models that can write text', async () => {
    const t = setup()
    t.state.models = [
      model('qwen3.5:4b'),
      model('cloud:latest', { remote: true }),
      model('embed:latest', { capabilities: ['embedding'] }),
    ]

    expect((await t.gate.localTextModels()).map((entry) => entry.name)).toEqual(['qwen3.5:4b'])
    // The list said everything that was needed: no model was asked about.
    expect(t.calls.show).toEqual([])
  })

  it('asks about a model whose list entry does not say what it can do', async () => {
    const t = setup()
    // `capabilities` is optional in the list; these entries came without it.
    t.state.models = [
      model('writes:latest', { capabilities: [] }),
      model('embeds:latest', { capabilities: [] }),
      model('forwards:latest', { capabilities: [] }),
      model('silent:latest', { capabilities: [] }),
    ]
    t.state.showFor = {
      'writes:latest': { capabilities: ['completion', 'tools'], remote: false },
      'embeds:latest': { capabilities: ['embedding'], remote: false },
      'forwards:latest': { capabilities: ['completion'], remote: true },
      'silent:latest': new OllamaError('unreachable', 'timed out'),
    }

    const offered = await t.gate.localTextModels()

    expect(offered.map((entry) => entry.name)).toEqual(['writes:latest'])
    expect(offered[0]?.capabilities).toEqual(['completion', 'tools'])
    expect(t.calls.chat).toBe(0)
  })

  it('asks about each such model once, and again only when the model has changed', async () => {
    const t = setup()
    t.state.models = [model('writes:latest', { capabilities: [] })]

    await t.gate.localTextModels()
    await t.gate.localTextModels()
    expect(t.calls.show).toEqual(['writes:latest'])

    t.state.models = [model('writes:latest', { capabilities: [], digest: 'a-new-digest' })]
    await t.gate.localTextModels()
    expect(t.calls.show).toEqual(['writes:latest', 'writes:latest'])
  })

  it('does not share the model menu details cache between servers', async () => {
    const t = setup()
    t.state.models = [model('writes:latest', { capabilities: [] })]
    expect(await t.gate.localTextModels()).toHaveLength(1)
    t.state.url = 'http://127.0.0.1:11500'
    t.state.show = { capabilities: ['completion'], remote: true }

    expect(await t.gate.localTextModels()).toEqual([])
    expect(t.calls.show).toHaveLength(2)
  })

  it('asks again next time about a model it could not get an answer for', async () => {
    const t = setup()
    t.state.models = [model('writes:latest', { capabilities: [] })]
    t.state.show = new OllamaError('unreachable', 'timed out')
    expect(await t.gate.localTextModels()).toEqual([])

    t.state.show = { capabilities: ['completion'], remote: false }

    expect((await t.gate.localTextModels()).map((entry) => entry.name)).toEqual(['writes:latest'])
  })

  it('offers the model from the list Ollama documents, which names no capabilities', async () => {
    // The example reply in Ollama's own documentation of GET /api/tags.
    const documented = {
      models: [
        {
          name: 'gemma4',
          model: 'gemma4',
          modified_at: '2025-10-03T23:34:03.409490317-07:00',
          size: 9608350245,
          digest: 'c6eb396dbd5992bbe3f5cdb947e8bbc0ee413d7c17e2beaae69f5d569cf982eb',
          details: {
            format: 'gguf',
            family: 'gemma4',
            families: ['gemma4'],
            parameter_size: '8.0B',
            quantization_level: 'Q4_K_M',
          },
        },
      ],
    }
    const json = (body: unknown): Response =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
    const asked: string[] = []
    const fetchImpl = ((input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      asked.push(path)
      if (path === '/api/tags') return Promise.resolve(json(documented))
      if (path === '/api/show') {
        return Promise.resolve(json({ capabilities: ['completion', 'vision'] }))
      }
      return Promise.reject(new Error(`unexpected request to ${path}`))
    }) as typeof fetch
    const gate = new LocalOnlyGate(new OllamaClient(undefined, fetchImpl))

    const offered = await gate.localTextModels()

    expect(offered.map((entry) => entry.name)).toEqual(['gemma4'])
    expect(offered[0]).toMatchObject({ parameterSize: '8.0B', remote: false })
    expect(asked).toEqual(['/api/tags', '/api/show'])
    expect(await gate.check('gemma4')).toEqual({
      local: true,
      identity: {
        server: 'http://127.0.0.1:11434',
        model: 'gemma4:latest',
        digest: documented.models[0]!.digest,
      },
    })
  })

  it('refuses a server that answers with a redirect', async () => {
    const t = setup()
    t.state.models = new OllamaError('redirect', 'Ollama answered with a redirect')
    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'redirected' })

    t.state.models = [model('qwen3.5:4b')]
    t.state.show = new OllamaError('redirect', 'Ollama answered with a redirect')
    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'redirected' })
  })

  it('leaves a server alone for a minute after it redirected a request', async () => {
    const t = setup()
    expect((await t.gate.check('qwen3.5:4b')).local).toBe(true)
    const asked = t.calls.models

    t.gate.sawRedirect()

    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: false, reason: 'redirected' })
    expect(t.calls.models).toBe(asked)

    t.state.clock += 61_000
    expect((await t.gate.check('qwen3.5:4b')).local).toBe(true)
  })

  it('does not hold a redirect against another server', async () => {
    const t = setup()
    t.gate.sawRedirect()

    t.state.url = 'http://127.0.0.1:11500'

    expect((await t.gate.check('qwen3.5:4b')).local).toBe(true)
  })
})
