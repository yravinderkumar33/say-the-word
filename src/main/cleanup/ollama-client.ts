import type { ChatMessage } from './prompts'

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

/**
 * The context size is fixed at load time: sending a different value makes Ollama load
 * the model again, so every request sends the same one.
 */
export const NUM_CTX = 4096
const KEEP_ALIVE = '30m'

export type OllamaErrorKind =
  /** Nothing answered at the address: Ollama is not running, or not installed. */
  | 'unreachable'
  /** Ollama answered with an error status (for example, the model is not installed). */
  | 'http'
  /** The reply started and then failed, or was not what Ollama sends. */
  | 'stream'
  | 'aborted'

export class OllamaError extends Error {
  constructor(
    readonly kind: OllamaErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'OllamaError'
  }
}

export interface OllamaModel {
  name: string
  digest: string
  capabilities: string[]
  parameterSize: string | null
  /** True when Ollama would run this model on another machine. */
  remote: boolean
}

export interface ChatRequest {
  model: string
  messages: readonly ChatMessage[]
  /** The most tokens the reply may have. */
  numPredict: number
  signal?: AbortSignal
  /** Called with the reply so far. Returning `false` abandons the request. */
  onContent?: (soFar: string) => boolean | void
}

export interface ChatResult {
  content: string
  /** `stop` when the model finished by itself; `abandoned` when `onContent` gave up. */
  doneReason: string | null
  /** True if any part of the reply said it came from a remote host. */
  remote: boolean
  /** Request sent → first piece of the reply. */
  firstTokenMs: number | null
  totalMs: number
  outputTokens: number | null
  /** Time the model spent generating, as Ollama reports it. */
  generationMs: number | null
  /** Time spent loading the model, if it had to be loaded. */
  loadMs: number | null
}

/** True when a piece of Ollama's metadata says the model runs somewhere else. */
export function hasRemoteFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const fields = value as Record<string, unknown>
  return isPresent(fields['remote_host']) || isPresent(fields['remote_model'])
}

function isPresent(value: unknown): boolean {
  return typeof value === 'string' ? value.length > 0 : value !== undefined && value !== null
}

/** True for an address on this machine: 127.0.0.0/8, ::1 or localhost. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
  } catch {
    return false
  }
}

/**
 * Talks to an Ollama server over HTTP. It knows the wire format and nothing about
 * dictation: which model may be used, and what to make of its output, is decided
 * elsewhere.
 */
export class OllamaClient {
  constructor(
    private baseUrl: string = DEFAULT_OLLAMA_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get url(): string {
    return this.baseUrl
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '')
  }

  /** The server's version, or null when nothing answers quickly. */
  async version(timeoutMs = 300): Promise<string | null> {
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return null
      const body = (await response.json()) as { version?: unknown }
      return typeof body.version === 'string' ? body.version : null
    } catch {
      return null
    }
  }

  /** Every model the server has, with what it can do and where it would run. */
  async models(timeoutMs = 2_000): Promise<OllamaModel[]> {
    const body = (await this.json('/api/tags', undefined, timeoutMs)) as { models?: unknown }
    if (!Array.isArray(body.models)) throw new OllamaError('stream', 'Unexpected model list')
    return body.models.flatMap((entry: unknown): OllamaModel[] => {
      if (!entry || typeof entry !== 'object') return []
      const model = entry as Record<string, unknown>
      if (typeof model['name'] !== 'string') return []
      const details = (model['details'] ?? {}) as Record<string, unknown>
      return [
        {
          name: model['name'],
          digest: typeof model['digest'] === 'string' ? model['digest'] : '',
          capabilities: stringList(model['capabilities']),
          parameterSize:
            typeof details['parameter_size'] === 'string' ? details['parameter_size'] : null,
          remote: hasRemoteFields(model),
        },
      ]
    })
  }

  /** One model's details. Throws an `http` error when the model is not installed. */
  async show(
    model: string,
    timeoutMs = 2_000,
  ): Promise<{ capabilities: string[]; remote: boolean }> {
    const body = await this.json('/api/show', { model }, timeoutMs)
    return {
      capabilities: stringList((body as Record<string, unknown>)['capabilities']),
      remote: hasRemoteFields(body),
    }
  }

  /**
   * One chat request, streamed. Thinking is switched off and its output discarded.
   * The penalties are set explicitly because some models ship values that punish
   * repeating the input, which is exactly what this task needs them to do.
   */
  async chat(request: ChatRequest): Promise<ChatResult> {
    const started = performance.now()
    const abandon = new AbortController()
    const signal = request.signal
      ? AbortSignal.any([request.signal, abandon.signal])
      : abandon.signal

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          think: false,
          keep_alive: KEEP_ALIVE,
          options: {
            num_ctx: NUM_CTX,
            num_predict: request.numPredict,
            temperature: 0,
            presence_penalty: 0,
            repeat_penalty: 1,
          },
        }),
        signal,
      })
    } catch (error) {
      throw request.signal?.aborted
        ? new OllamaError('aborted', 'The request was cancelled')
        : new OllamaError('unreachable', describe(error))
    }
    if (!response.ok || !response.body) {
      throw new OllamaError(
        'http',
        `Ollama answered ${response.status}: ${await errorText(response)}`,
      )
    }

    const result: ChatResult = {
      content: '',
      doneReason: null,
      remote: false,
      firstTokenMs: null,
      totalMs: 0,
      outputTokens: null,
      generationMs: null,
      loadMs: null,
    }
    let abandoned = false

    const onLine = (line: string): void => {
      let piece: Record<string, unknown>
      try {
        piece = JSON.parse(line) as Record<string, unknown>
      } catch {
        throw new OllamaError('stream', 'Ollama sent a line that is not JSON')
      }
      // A failure after the reply has started arrives as a line of its own.
      if (typeof piece['error'] === 'string') throw new OllamaError('stream', piece['error'])
      if (hasRemoteFields(piece)) result.remote = true

      const message = piece['message'] as { content?: unknown } | undefined
      if (typeof message?.content === 'string' && message.content.length > 0) {
        result.firstTokenMs ??= performance.now() - started
        result.content += message.content
        if (request.onContent?.(result.content) === false) {
          abandoned = true
          abandon.abort()
        }
      }
      if (piece['done'] === true) {
        result.doneReason = typeof piece['done_reason'] === 'string' ? piece['done_reason'] : null
        result.outputTokens = numberOrNull(piece['eval_count'])
        result.generationMs = nanosToMs(piece['eval_duration'])
        result.loadMs = nanosToMs(piece['load_duration'])
      }
    }

    try {
      let pending = ''
      const decoder = new TextDecoder()
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLine(line)
        if (abandoned) break
      }
      if (!abandoned && pending.trim()) onLine(pending)
    } catch (error) {
      if (error instanceof OllamaError) throw error
      if (abandoned) {
        // Giving up on the reply is this side's doing, and not a failure of the stream.
      } else if (request.signal?.aborted) {
        throw new OllamaError('aborted', 'The request was cancelled')
      } else {
        throw new OllamaError('stream', describe(error))
      }
    }

    if (abandoned) result.doneReason = 'abandoned'
    result.totalMs = performance.now() - started
    return result
  }

  /**
   * Has the model loaded and its instructions read before the transcript exists, so
   * the real request does not pay for either. Failures are not reported: the real
   * request will meet the same problem and say so.
   */
  async warm(model: string, prefix: readonly ChatMessage[], signal?: AbortSignal): Promise<void> {
    try {
      await this.chat({ model, messages: prefix, numPredict: 1, ...(signal ? { signal } : {}) })
    } catch {
      // See above.
    }
  }

  private async json(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...(body === undefined
          ? {}
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new OllamaError('unreachable', describe(error))
    }
    if (!response.ok) {
      throw new OllamaError(
        'http',
        `Ollama answered ${response.status}: ${await errorText(response)}`,
      )
    }
    try {
      return (await response.json()) as unknown
    } catch {
      throw new OllamaError('stream', 'Ollama sent a reply that is not JSON')
    }
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

function nanosToMs(value: unknown): number | null {
  return typeof value === 'number' ? value / 1e6 : null
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    return typeof body.error === 'string' ? body.error : 'no details'
  } catch {
    return 'no details'
  }
}
