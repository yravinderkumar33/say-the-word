import { describe, expect, it } from 'vitest'
import { isOwnPageUrl, resolveAppUrl } from '../../src/main/app-url'

const root = '/Applications/App.app/Contents/Resources/app.asar/out/renderer'

describe('resolveAppUrl', () => {
  it('maps a page to a file under the root', () => {
    expect(resolveAppUrl('app://renderer/overlay.html', root)).toBe(`${root}/overlay.html`)
  })

  it('maps a nested asset and ignores the query string', () => {
    expect(resolveAppUrl('app://renderer/assets/index-abc.js?v=1', root)).toBe(
      `${root}/assets/index-abc.js`,
    )
  })

  it('decodes percent-encoded characters in the path', () => {
    expect(resolveAppUrl('app://renderer/assets/my%20file.js', root)).toBe(
      `${root}/assets/my file.js`,
    )
  })

  it('keeps dot-segment traversal inside the root', () => {
    // The URL parser collapses `..` at the top of the path, so these cannot climb out.
    expect(resolveAppUrl('app://renderer/../../../../etc/passwd', root)).toBe(`${root}/etc/passwd`)
    expect(resolveAppUrl('app://renderer/%2e%2e/%2e%2e/secret.txt', root)).toBe(
      `${root}/secret.txt`,
    )
  })

  it.each([
    ['another scheme', 'file:///etc/passwd'],
    ['another host', 'app://evil/overlay.html'],
    ['traversal hidden in encoded slashes', 'app://renderer/..%2f..%2fsecret.txt'],
    [
      'a sibling directory that shares the root as a prefix',
      'app://renderer/..%2frenderer-secrets%2fkey',
    ],
    ['the root itself', 'app://renderer/'],
    ['a NUL byte', 'app://renderer/overlay.html%00.png'],
    ['malformed escapes', 'app://renderer/%E0%A4%A'],
    ['text that is not a URL', 'overlay.html'],
  ])('refuses %s', (_label, url) => {
    expect(resolveAppUrl(url, root)).toBeNull()
  })

  it('never returns a path outside the root', () => {
    const hostile = [
      'app://renderer/../../etc/passwd',
      'app://renderer/..%2f..%2f..%2fetc%2fpasswd',
      'app://renderer/assets/..%2f..%2f..%2fsecret',
      'app://renderer/%2e%2e%2f%2e%2e%2fsecret',
      'app://renderer//etc/passwd',
      'app://renderer/assets/../../outside',
    ]
    for (const url of hostile) {
      const resolved = resolveAppUrl(url, root)
      expect(resolved === null || resolved.startsWith(`${root}/`), url).toBe(true)
    }
  })
})

describe('isOwnPageUrl', () => {
  const dev = 'http://localhost:5173'

  it('accepts the pages the app serves itself', () => {
    expect(isOwnPageUrl('app://renderer/overlay.html')).toBe(true)
    expect(isOwnPageUrl('app://renderer/hub.html?x=1#top')).toBe(true)
    // The form Chromium uses when it reports an origin rather than a page.
    expect(isOwnPageUrl('app://renderer')).toBe(true)
    expect(isOwnPageUrl('app://renderer/')).toBe(true)
  })

  it('does not rely on URL.origin, which is "null" for the app scheme', () => {
    expect(new URL('app://renderer/overlay.html').origin).toBe('null')
    expect(new URL('app://elsewhere/overlay.html').origin).toBe('null')
    expect(isOwnPageUrl('app://elsewhere/overlay.html')).toBe(false)
  })

  it('refuses every other scheme and host', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:5173/overlay.html',
      'file:///Users/someone/overlay.html',
      'app://renderer.evil.example/overlay.html',
      'app://renderer@evil.example/overlay.html',
      'about:blank',
      'null',
      '',
    ]) {
      expect(isOwnPageUrl(url), url).toBe(false)
    }
  })

  it('accepts the dev server only when one is in use, and only that host and port', () => {
    expect(isOwnPageUrl('http://localhost:5173/overlay.html', dev)).toBe(true)
    expect(isOwnPageUrl('http://localhost:5173', dev)).toBe(true)
    expect(isOwnPageUrl('http://localhost:9999/overlay.html', dev)).toBe(false)
    expect(isOwnPageUrl('https://localhost:5173/overlay.html', dev)).toBe(false)
    expect(isOwnPageUrl('http://localhost.evil.example:5173/', dev)).toBe(false)
    expect(isOwnPageUrl('app://renderer/overlay.html', dev)).toBe(true)
  })
})
