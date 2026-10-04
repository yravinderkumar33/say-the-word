import { OllamaError, isLoopbackUrl, type OllamaClient, type OllamaModel } from './ollama-client'

/** The identity whose metadata was checked, rather than just the mutable model name. */
export interface LocalModelIdentity {
  server: string
  model: string
  digest: string
}

export type LocalVerdict =
  | { local: true; identity: LocalModelIdentity }
  | {
      local: false
      reason:
        /** Ollama would run this model on another machine. */
        | 'remote'
        /** A reply from this model said it came from another machine. */
        | 'blocked'
        | 'notInstalled'
        /** The model cannot write text (an embedding model, for example). */
        | 'notATextModel'
        /** The server is not on this machine. */
        | 'serverNotLocal'
        /** The server answered with a redirect, which is never followed. */
        | 'redirected'
        /** Ollama did not answer, so nothing is known. */
        | 'unreachable'
    }

/** How long a verdict stands before the model's fingerprint is looked at again. */
const RECHECK_MS = 60_000
/**
 * How long Ollama gets to answer a question about a model. The check runs before every
 * cleanup, so a server that accepts connections and then says nothing must not hold
 * the dictation up for long.
 */
const ANSWER_WITHIN_MS = 1_000
/** How many models' details are kept, so that filling a menu asks about each only once. */
const KEPT_DETAILS = 64

/**
 * Makes sure a transcript is only ever sent to a model that runs on this machine.
 *
 * Reaching Ollama on a loopback address is not enough. Ollama can forward a request to
 * a remote host: its cloud models do, and so does any alias made from one. The model
 * list and the model details both say so (`remote_host`, `remote_model`), and those are
 * what is checked here, so renaming an alias does not get it past.
 *
 * Nothing in this class sends a transcript. A model is asked about, never talked to.
 */
export class LocalOnlyGate {
  /** Verdicts by model name and fingerprint. A changed fingerprint is a different model. */
  private readonly verdicts = new Map<string, { verdict: LocalVerdict; at: number }>()
  private readonly blocked = new Set<string>()
  /**
   * What each model can do and where it runs, by name and fingerprint, for models whose
   * list entry does not say. The fingerprint changes when the model does, so an entry
   * never goes stale.
   */
  private readonly details = new Map<string, { capabilities: string[]; remote: boolean }>()
  /** The server that last answered a request with a redirect, and when. */
  private readonly redirects = new Map<string, number>()

  constructor(
    private readonly client: OllamaClient,
    private readonly now: () => number = () => Date.now(),
    /** A server elsewhere is allowed only when the user typed its address in themselves. */
    private readonly allowRemoteServer: () => boolean = () => false,
  ) {}

  /** May a transcript be sent to this model? */
  async check(model: string): Promise<LocalVerdict> {
    const server = this.client.url
    if (this.blocked.has(this.modelKey(model, server))) return { local: false, reason: 'blocked' }
    if (!isLoopbackUrl(server) && !this.allowRemoteServer()) {
      return { local: false, reason: 'serverNotLocal' }
    }
    const redirectedAt = this.redirects.get(server)
    if (redirectedAt !== undefined && this.now() - redirectedAt < RECHECK_MS) {
      return { local: false, reason: 'redirected' }
    }

    let listed: OllamaModel | undefined
    try {
      listed = (await this.client.models(ANSWER_WITHIN_MS)).find((entry) =>
        sameModel(entry.name, model),
      )
    } catch (error) {
      return { local: false, reason: reasonFor(error) }
    }
    // A settings change while the request was pending must not mix two servers' evidence.
    if (server !== this.client.url) return { local: false, reason: 'unreachable' }
    if (this.blocked.has(this.modelKey(model, server))) return { local: false, reason: 'blocked' }
    if (!listed) return { local: false, reason: 'notInstalled' }
    const identity = { server, model: fullName(listed.name), digest: listed.digest }
    if (listed.remote) return this.remember(identity, { local: false, reason: 'remote' })
    // Without a fingerprint, a later replacement could inherit this model's approval.
    if (!listed.digest.trim()) return { local: false, reason: 'unreachable' }

    const key = identityKey(identity)
    const known = this.verdicts.get(key)
    if (known && this.now() - known.at < RECHECK_MS) return known.verdict

    try {
      const details = await this.client.show(listed.name, ANSWER_WITHIN_MS)
      if (server !== this.client.url) return { local: false, reason: 'unreachable' }
      if (this.blocked.has(this.modelKey(model, server))) return { local: false, reason: 'blocked' }
      if (details.remote) return this.remember(identity, { local: false, reason: 'remote' })
      const capabilities =
        details.capabilities.length > 0 ? details.capabilities : listed.capabilities
      if (!capabilities.includes('completion')) {
        return this.remember(identity, { local: false, reason: 'notATextModel' })
      }
      return this.remember(identity, { local: true, identity })
    } catch (error) {
      return { local: false, reason: reasonFor(error) }
    }
  }

  /**
   * A reply from this model carried remote fields: it is not used again in this run,
   * under whichever spelling of its name (`qwen3.5` and `qwen3.5:latest` are one model).
   */
  block(model: string, server = this.client.url): void {
    this.blocked.add(this.modelKey(model, server))
  }

  /**
   * The server answered a request with a redirect. It was not followed. The server is
   * left alone for a while, so that a transcript is not sent to it over and over only
   * to be turned away, and so that the tray can say what is wrong.
   */
  sawRedirect(server = this.client.url): void {
    this.redirects.set(server, this.now())
  }

  /**
   * The models that can clean a transcript and run on this machine. A server that is
   * not on this machine is not asked, unless the user allowed it: nothing goes out to
   * another host just to fill a menu.
   *
   * The list may not say what a model can do: `capabilities` is optional in Ollama's
   * reply, and its own documented example leaves it out. A model whose entry is silent
   * is asked about by name, once, rather than dropped from the menu.
   */
  async localTextModels(): Promise<OllamaModel[]> {
    const server = this.client.url
    if (!isLoopbackUrl(server) && !this.allowRemoteServer()) return []
    const models = await this.client.models()
    if (server !== this.client.url) return []
    const candidates = models.filter(
      (model) => !model.remote && !this.blocked.has(this.modelKey(model.name, server)),
    )
    const described = await Promise.all(
      candidates.map(async (model) => {
        if (model.capabilities.length > 0) return model
        const details = await this.detailsOf(model, server)
        return details && !details.remote ? { ...model, capabilities: details.capabilities } : null
      }),
    )
    if (server !== this.client.url) return []
    return described.filter(
      (model): model is OllamaModel => model !== null && model.capabilities.includes('completion'),
    )
  }

  /** A model's details, asked for once per fingerprint. Null when they cannot be had. */
  private async detailsOf(
    model: OllamaModel,
    server: string,
  ): Promise<{ capabilities: string[]; remote: boolean } | null> {
    if (server !== this.client.url) return null
    const key = identityKey({ server, model: fullName(model.name), digest: model.digest })
    const known = this.details.get(key)
    if (known && model.digest.trim()) return known
    try {
      const details = await this.client.show(model.name, ANSWER_WITHIN_MS)
      if (server !== this.client.url) return null
      if (model.digest.trim()) this.details.set(key, details)
      // The oldest entry goes first: a map keeps the order things were added in.
      while (this.details.size > KEPT_DETAILS) {
        const oldest = this.details.keys().next().value
        if (oldest === undefined) break
        this.details.delete(oldest)
      }
      return details
    } catch {
      return null
    }
  }

  private remember(identity: LocalModelIdentity, verdict: LocalVerdict): LocalVerdict {
    this.verdicts.set(identityKey(identity), { verdict, at: this.now() })
    return verdict
  }

  private modelKey(model: string, server: string): string {
    return JSON.stringify([server, fullName(model)])
  }
}

export function identityKey(identity: LocalModelIdentity): string {
  return JSON.stringify([identity.server, identity.model, identity.digest])
}

/** Ollama treats a name without a tag as `:latest`. */
function fullName(name: string): string {
  return name.includes(':') ? name : `${name}:latest`
}

function sameModel(a: string, b: string): boolean {
  return fullName(a) === fullName(b)
}

function reasonFor(error: unknown): 'unreachable' | 'notInstalled' | 'redirected' {
  if (!(error instanceof OllamaError)) return 'unreachable'
  if (error.kind === 'redirect') return 'redirected'
  return error.kind === 'http' ? 'notInstalled' : 'unreachable'
}
