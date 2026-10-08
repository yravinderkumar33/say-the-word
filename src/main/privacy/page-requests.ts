import { isLoopbackUrl } from '../cleanup/ollama-client'

/**
 * Whether a request made by a page of the app may go out.
 *
 * The pages ask for nothing over the network: what they show is in the app, and what
 * the app fetches (the speech model, Ollama's answers) the main process fetches itself.
 * Their content policy says the same, but a policy binds only a page that is still the
 * app's own. This is asked in the main process for every request of the pages' session,
 * and binds whatever is drawing them.
 *
 * In development the pages come from a server on this Mac. That one is let through: the
 * page itself, and the socket that reloads it.
 */
export function pageRequestAllowed(url: string, devServer: string | undefined): boolean {
  if (!devServer || !isLoopbackUrl(devServer)) return false
  try {
    return new URL(url).host === new URL(devServer).host
  } catch {
    return false
  }
}
