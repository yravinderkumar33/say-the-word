import { describe, expect, it } from 'vitest'
import { pageRequestAllowed } from '../../src/main/privacy/page-requests'

describe('what a page of the app may ask for over the network', () => {
  it('is nothing at all in the app as it is built and installed', () => {
    for (const url of [
      'https://example.org/collect',
      'http://127.0.0.1:11434/api/chat',
      'http://localhost:5173/hub.html',
      'wss://example.org/socket',
    ]) {
      expect(pageRequestAllowed(url, undefined), url).toBe(false)
    }
  })

  it('is the development server the pages come from, and its socket, in a development run', () => {
    const devServer = 'http://localhost:5173'

    expect(pageRequestAllowed('http://localhost:5173/hub.html', devServer)).toBe(true)
    expect(pageRequestAllowed('ws://localhost:5173/', devServer)).toBe(true)
    // Another port on this Mac is another server: Ollama is the main process's to ask.
    expect(pageRequestAllowed('http://localhost:11434/api/tags', devServer)).toBe(false)
    expect(pageRequestAllowed('https://example.org/', devServer)).toBe(false)
  })

  it('lets nothing through for a development server that is not on this Mac', () => {
    expect(pageRequestAllowed('https://example.org/hub.html', 'https://example.org')).toBe(false)
    expect(pageRequestAllowed('not an address', 'http://localhost:5173')).toBe(false)
    expect(pageRequestAllowed('http://localhost:5173/', 'not an address')).toBe(false)
  })
})
