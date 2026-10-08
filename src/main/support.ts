/**
 * Where "Buy me a coffee" leads. Null until there is such a page: the windows and the
 * menu then show no link at all, rather than one that leads nowhere.
 *
 * It is a link the user clicks, and it opens in their browser. The app itself fetches
 * nothing from that address: no button image, no widget.
 */
const SUPPORT_URL: string | null = null

const SUPPORT_HOSTS = new Set(['buymeacoffee.com', 'www.buymeacoffee.com'])

/**
 * The page to open, if the address is one this app may send people to: a secure page
 * on Buy Me a Coffee and nowhere else. A page of the app's own asks for "the support
 * page" and never names an address, so this is the only place one can come from.
 */
export function supportPage(url: string | null = SUPPORT_URL): URL | null {
  if (!url) return null
  try {
    const page = new URL(url)
    return page.protocol === 'https:' && SUPPORT_HOSTS.has(page.hostname) ? page : null
  } catch {
    return null
  }
}

/** Where the link goes, as the window says it beside the link. */
export function supportHost(url: string | null = SUPPORT_URL): string | null {
  return supportPage(url)?.hostname.replace(/^www\./, '') ?? null
}

/**
 * Where the source code is, and where a problem is reported. Null until the
 * repository has an address: the About page then lists neither.
 */
const SOURCE_URL: string | null = null

/** A page of the repository, if there is one and it is a secure address. */
export function sourcePage(path = '', url: string | null = SOURCE_URL): URL | null {
  if (!url) return null
  try {
    const page = new URL(url.replace(/\/+$/, '') + path)
    return page.protocol === 'https:' ? page : null
  } catch {
    return null
  }
}

/** Where Ollama is downloaded from. Opened in the browser when the user asks for it. */
export const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download'
