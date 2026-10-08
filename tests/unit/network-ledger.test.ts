import { describe, expect, it } from 'vitest'
import { NetworkLedger, hostOf } from '../../src/main/privacy/network-ledger'

describe('what the app has contacted', () => {
  it('is nothing, until something is tried', () => {
    expect(new NetworkLedger().list()).toEqual([])
  })

  it('names the host and what for, never the path or what was sent', () => {
    const ledger = new NetworkLedger()

    ledger.tried('http://127.0.0.1:11434/api/chat?secret=1', 'ollama')

    expect(ledger.list()).toEqual([
      { host: '127.0.0.1', what: 'ollama', local: true, answered: false },
    ])
  })

  it('says whether anything answered, and does not forget that it did', () => {
    const ledger = new NetworkLedger()
    ledger.tried('http://127.0.0.1:11434/api/tags', 'ollama')
    ledger.answered('http://127.0.0.1:11434/api/tags', 'ollama')
    ledger.tried('http://127.0.0.1:11434/api/tags', 'ollama')

    expect(ledger.list()).toEqual([
      { host: '127.0.0.1', what: 'ollama', local: true, answered: true },
    ])
  })

  it('tells a host on this Mac from one that is not', () => {
    const ledger = new NetworkLedger()
    ledger.tried('https://huggingface.co/model.onnx', 'speechModel')
    ledger.tried('http://[::1]:11434/api/tags', 'ollama')
    ledger.tried('http://localhost:5173/hub.html', 'other')

    expect(ledger.list().map((contact) => [contact.host, contact.local])).toEqual([
      ['huggingface.co', false],
      ['::1', true],
      ['localhost', true],
    ])
  })

  it('writes down where a watched request goes before it goes, and where it was sent on to', async () => {
    const ledger = new NetworkLedger()
    const seen: string[] = []
    const fetchImpl = (() => {
      // Already written down by the time the request leaves.
      seen.push(JSON.stringify(ledger.list()))
      const response = new Response('ok')
      Object.defineProperty(response, 'url', { value: 'https://cdn.example.net/file' })
      return Promise.resolve(response)
    }) as unknown as typeof fetch

    await ledger.watch('speechModel', fetchImpl)('https://huggingface.co/model.onnx')

    expect(seen[0]).toContain('huggingface.co')
    expect(ledger.list()).toEqual([
      { host: 'huggingface.co', what: 'speechModel', local: false, answered: false },
      { host: 'cdn.example.net', what: 'speechModel', local: false, answered: true },
    ])
  })

  it('writes down every host a download is sent through on its way, not only the first and last', async () => {
    const ledger = new NetworkLedger()
    const asked: Array<{ url: string; redirect: string | undefined; range: string | null }> = []
    const hops: Record<string, string> = {
      'https://huggingface.co/model.onnx': 'https://cas-bridge.example.org/abc',
      'https://cas-bridge.example.org/abc': '/signed/abc?token=x',
    }
    const fetchImpl = ((input: string, init?: RequestInit) => {
      asked.push({
        url: input,
        redirect: init?.redirect,
        range: new Headers(init?.headers).get('range'),
      })
      const to = hops[input]
      return Promise.resolve(
        to ? new Response(null, { status: 302, headers: { location: to } }) : new Response('ok'),
      )
    }) as unknown as typeof fetch

    const response = await ledger.watch('speechModel', fetchImpl)(
      'https://huggingface.co/model.onnx',
      { headers: { Range: 'bytes=10-' }, redirect: 'follow' },
    )

    expect(await response.text()).toBe('ok')
    expect(asked.map((step) => step.url)).toEqual([
      'https://huggingface.co/model.onnx',
      'https://cas-bridge.example.org/abc',
      'https://cas-bridge.example.org/signed/abc?token=x',
    ])
    // The request is the same at every step: only the address changes.
    expect(asked.every((step) => step.redirect === 'manual' && step.range === 'bytes=10-')).toBe(
      true,
    )
    expect(ledger.list().map((contact) => [contact.host, contact.answered])).toEqual([
      ['huggingface.co', true],
      ['cas-bridge.example.org', true],
    ])
  })

  it('leaves a request that must not be sent on exactly as it was asked', async () => {
    const ledger = new NetworkLedger()
    const redirects: Array<string | undefined> = []
    const fetchImpl = ((_input: string, init?: RequestInit) => {
      redirects.push(init?.redirect)
      return Promise.resolve(
        new Response(null, { status: 307, headers: { location: 'http://elsewhere.example/' } }),
      )
    }) as unknown as typeof fetch

    const response = await ledger.watch('ollama', fetchImpl)('http://127.0.0.1:11434/api/chat', {
      redirect: 'manual',
    })

    expect(response.status).toBe(307)
    expect(redirects).toEqual(['manual'])
    expect(ledger.list().map((contact) => contact.host)).toEqual(['127.0.0.1'])
  })

  it('still has the address when the request fails', async () => {
    const ledger = new NetworkLedger()
    const failing = (() => Promise.reject(new Error('refused'))) as unknown as typeof fetch

    await expect(
      ledger.watch('ollama', failing)('http://127.0.0.1:11434/api/tags'),
    ).rejects.toThrow()

    expect(ledger.list()).toEqual([
      { host: '127.0.0.1', what: 'ollama', local: true, answered: false },
    ])
  })

  it('makes nothing of an address that is not one', () => {
    expect(hostOf('not an address')).toBeNull()
    const ledger = new NetworkLedger()
    ledger.tried('not an address', 'other')
    expect(ledger.list()).toEqual([])
  })
})
