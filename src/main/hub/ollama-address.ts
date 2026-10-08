import { isLoopbackUrl } from '../cleanup/ollama-client'

/**
 * The address a page asks Ollama to be looked for at. Only an address on this Mac is
 * taken from a page: one elsewhere would send what is said to another machine, and
 * allowing that is not a page's to decide.
 */
export function ollamaAddress(
  typed: string,
  remoteAllowed: boolean,
): { ok: true; url: string } | { ok: false; problem: string } {
  let url: URL
  try {
    url = new URL(typed.trim())
  } catch {
    return { ok: false, problem: 'That is not an address. It looks like http://127.0.0.1:11434.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, problem: 'The address starts with http:// or https://.' }
  }
  if (url.username || url.password) {
    return { ok: false, problem: 'The address cannot carry a name or a password.' }
  }
  const address = `${url.protocol}//${url.host}`
  if (!isLoopbackUrl(address) && !remoteAllowed) {
    return {
      ok: false,
      problem: 'Only an address on this Mac is accepted, such as http://127.0.0.1:11434.',
    }
  }
  return { ok: true, url: address }
}
