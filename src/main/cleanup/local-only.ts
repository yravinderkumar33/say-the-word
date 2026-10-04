import { OllamaError, isLoopbackUrl, type OllamaClient, type OllamaModel } from './ollama-client'

export type LocalVerdict =
  | { local: true }
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

  constructor(
    private readonly client: OllamaClient,
    private readonly now: () => number = () => Date.now(),
    /** A server elsewhere is allowed only when the user typed its address in themselves. */
    private readonly allowRemoteServer: () => boolean = () => false,
  ) {}

  /** May a transcript be sent to this model? */
  async check(model: string): Promise<LocalVerdict> {
    if (this.blocked.has(model)) return { local: false, reason: 'blocked' }
    if (!isLoopbackUrl(this.client.url) && !this.allowRemoteServer()) {
      return { local: false, reason: 'serverNotLocal' }
    }

    let listed: OllamaModel | undefined
    try {
      listed = (await this.client.models(ANSWER_WITHIN_MS)).find((entry) =>
        sameModel(entry.name, model),
      )
    } catch (error) {
      return { local: false, reason: reasonFor(error) }
    }
    if (!listed) return { local: false, reason: 'notInstalled' }
    if (listed.remote) return this.remember(listed, { local: false, reason: 'remote' })

    const key = `${listed.name}@${listed.digest}`
    const known = this.verdicts.get(key)
    if (known && this.now() - known.at < RECHECK_MS) return known.verdict

    try {
      const details = await this.client.show(listed.name, ANSWER_WITHIN_MS)
      if (details.remote) return this.remember(listed, { local: false, reason: 'remote' })
      const capabilities =
        details.capabilities.length > 0 ? details.capabilities : listed.capabilities
      if (!capabilities.includes('completion')) {
        return this.remember(listed, { local: false, reason: 'notATextModel' })
      }
      return this.remember(listed, { local: true })
    } catch (error) {
      return { local: false, reason: reasonFor(error) }
    }
  }

  /** A reply from this model carried remote fields: it is not used again in this run. */
  block(model: string): void {
    this.blocked.add(model)
  }

  /**
   * The models that can clean a transcript and run on this machine. A server that is
   * not on this machine is not asked, unless the user allowed it: nothing goes out to
   * another host just to fill a menu.
   */
  async localTextModels(): Promise<OllamaModel[]> {
    if (!isLoopbackUrl(this.client.url) && !this.allowRemoteServer()) return []
    const models = await this.client.models()
    return models.filter(
      (model) =>
        !model.remote && model.capabilities.includes('completion') && !this.blocked.has(model.name),
    )
  }

  private remember(model: OllamaModel, verdict: LocalVerdict): LocalVerdict {
    this.verdicts.set(`${model.name}@${model.digest}`, { verdict, at: this.now() })
    return verdict
  }
}

/** Ollama treats a name without a tag as `:latest`. */
function sameModel(a: string, b: string): boolean {
  const full = (name: string): string => (name.includes(':') ? name : `${name}:latest`)
  return full(a) === full(b)
}

function reasonFor(error: unknown): 'unreachable' | 'notInstalled' {
  return error instanceof OllamaError && error.kind === 'http' ? 'notInstalled' : 'unreachable'
}
