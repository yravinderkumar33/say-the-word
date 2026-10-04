import { join, normalize, sep } from 'node:path'

export const APP_SCHEME = 'app'
export const APP_HOST = 'renderer'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

/**
 * True for a URL of one of the app's own pages: anything under `app://renderer`, plus
 * the dev server's origin while developing.
 *
 * `URL.origin` cannot be used for this. For a scheme the URL standard does not know,
 * such as `app:`, it is the string "null", whatever the host is.
 */
export function isOwnPageUrl(rawUrl: string, devServerUrl?: string): boolean {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }
  if (url.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST
  if (!devServerUrl) return false
  try {
    const dev = new URL(devServerUrl)
    return url.protocol === dev.protocol && url.host === dev.host
  } catch {
    return false
  }
}

/**
 * Maps an `app://renderer/…` URL to a file inside `rootDir`.
 * Returns null for any other scheme or host, and for any path that would
 * leave `rootDir`.
 */
export function resolveAppUrl(rawUrl: string, rootDir: string): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null

  // The URL parser has already collapsed plain `..` segments. Decoding can reintroduce
  // them (`..%2f`), so containment is checked on the final path.
  const root = normalize(rootDir)
  const target = normalize(join(root, pathname)).replace(/[\\/]+$/, '')
  if (!target.startsWith(root + sep)) return null
  return target
}
