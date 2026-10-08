import type { Contact } from '@shared/ipc'
import { isLoopbackUrl } from '../cleanup/ollama-client'

/**
 * Every address the app has tried to reach since it was started, and what for. The
 * Privacy page shows it, so that "nothing is sent anywhere" is a fact to look at and
 * not a sentence to believe.
 *
 * It holds host names and nothing else: never a path, a query or anything that was sent.
 */
export class NetworkLedger {
  private readonly contacts = new Map<string, Contact>()

  /** A request is about to go to this address. */
  tried(url: string, what: Contact['what']): void {
    this.note(url, what, false)
  }

  /** Something at this address answered. */
  answered(url: string, what: Contact['what']): void {
    this.note(url, what, true)
  }

  /** In the order they were first tried. */
  list(): Contact[] {
    return [...this.contacts.values()]
  }

  /**
   * `fetch`, with every address it is asked to reach written down first. A download
   * that is sent on to another host (a mirror) is written down under that host too, and
   * so is every host on the way: a request that may be sent on is followed here, one step
   * at a time, where `fetch` would follow it out of sight. One that asks not to be sent on
   * (every request to Ollama) is left exactly as it is.
   */
  watch(what: Contact['what'], fetchImpl: typeof fetch = fetch): typeof fetch {
    return async (input, init) => {
      let url = addressOf(input)
      this.tried(url, what)
      if (init?.redirect !== undefined && init.redirect !== 'follow') {
        const response = await fetchImpl(input, init)
        this.answered(response.url || url, what)
        return response
      }
      let next: Parameters<typeof fetch>[0] = input
      for (let step = 0; step <= MOST_REDIRECTS; step += 1) {
        const response = await fetchImpl(next, { ...init, redirect: 'manual' })
        const location = REDIRECTS.has(response.status) ? response.headers.get('location') : null
        if (!location) {
          this.answered(response.url || url, what)
          return response
        }
        // It answered, with another address to try.
        this.answered(url, what)
        void response.body?.cancel().catch(() => {})
        url = new URL(location, url).href
        this.tried(url, what)
        next = url
      }
      throw new TypeError(`More than ${MOST_REDIRECTS} redirects`)
    }
  }

  private note(url: string, what: Contact['what'], answered: boolean): void {
    const host = hostOf(url)
    if (!host) return
    const key = `${what} ${host}`
    const before = this.contacts.get(key)
    if (before && (before.answered || !answered)) return
    this.contacts.set(key, { host, what, local: isLoopbackUrl(url), answered })
  }
}

/** As `fetch` does: no request is sent on more often than this. */
const MOST_REDIRECTS = 20
const REDIRECTS = new Set([301, 302, 303, 307, 308])

function addressOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

/** The host of an address, without the brackets of an IPv6 one. Null when it has none. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '') || null
  } catch {
    return null
  }
}
