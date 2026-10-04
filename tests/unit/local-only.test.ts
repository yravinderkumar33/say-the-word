import { describe, expect, it } from 'vitest'
import { LocalOnlyGate } from '../../src/main/cleanup/local-only'
import {
  OllamaError,
  type OllamaClient,
  type OllamaModel,
} from '../../src/main/cleanup/ollama-client'

const model = (name: string, extra: Partial<OllamaModel> = {}): OllamaModel => ({
  name,
  digest: `digest-of-${name}`,
  capabilities: ['completion'],
  parameterSize: '4B',
  remote: false,
  ...extra,
})

function setup(options: { url?: string; allowRemoteServer?: boolean } = {}) {
  const state = {
    models: [model('qwen3.5:4b'), model('cloud:latest', { remote: true })] as OllamaModel[] | Error,
    show: { capabilities: ['completion'], remote: false } as
      { capabilities: string[]; remote: boolean } | Error,
    clock: 0,
  }
  const calls = { models: 0, show: [] as string[], chat: 0 }
  const client = {
    url: options.url ?? 'http://127.0.0.1:11434',
    models: () => {
      calls.models += 1
      return state.models instanceof Error
        ? Promise.reject(state.models)
        : Promise.resolve(state.models)
    },
    show: (name: string) => {
      calls.show.push(name)
      return state.show instanceof Error ? Promise.reject(state.show) : Promise.resolve(state.show)
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
  return { gate, state, calls }
}

describe('LocalOnlyGate', () => {
  it('accepts a model that runs on this machine', async () => {
    const t = setup()

    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: true })
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
    expect(await t.gate.check('qwen3.5:4b')).toEqual({ local: true })
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

  it('treats a name without a tag as :latest', async () => {
    const t = setup()
    t.state.models = [model('gemma:latest')]

    expect(await t.gate.check('gemma')).toEqual({ local: true })
  })

  it('refuses a server that is not on this machine, unless the user chose it', async () => {
    const elsewhere = setup({ url: 'http://192.168.1.20:11434' })
    expect(await elsewhere.gate.check('qwen3.5:4b')).toEqual({
      local: false,
      reason: 'serverNotLocal',
    })
    expect(elsewhere.calls.models).toBe(0)

    const chosen = setup({ url: 'http://192.168.1.20:11434', allowRemoteServer: true })
    expect(await chosen.gate.check('qwen3.5:4b')).toEqual({ local: true })
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

  it('offers only local models that can write text', async () => {
    const t = setup()
    t.state.models = [
      model('qwen3.5:4b'),
      model('cloud:latest', { remote: true }),
      model('embed:latest', { capabilities: ['embedding'] }),
    ]

    expect((await t.gate.localTextModels()).map((entry) => entry.name)).toEqual(['qwen3.5:4b'])
  })
})
