import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { APP_SCHEME, resolveAppUrl } from './app-url'

// The renderer needs nothing from the network: no remote scripts, styles, frames or requests.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        codeCache: true,
      },
    },
  ])
}

/**
 * Serves the built renderer from `app://renderer/…` rather than `file://`, so pages
 * get a real origin, a secure context (needed for the microphone) and a CSP header.
 */
export function handleAppProtocol(rootDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const filePath = resolveAppUrl(request.url, rootDir)
    if (!filePath) return new Response('Not found', { status: 404 })
    try {
      const file = await net.fetch(pathToFileURL(filePath).toString())
      const headers = new Headers(file.headers)
      headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(file.body, { status: file.status, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
