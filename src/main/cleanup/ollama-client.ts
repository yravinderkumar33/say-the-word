import type { ChatMessage } from './prompts'

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'

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
  /** Ollama answered with a redirect. Redirects are never followed: see `send`. */
  | 'redirect'
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
  /** Its size on disk in bytes, when the list says. */
  bytes: number | null
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
  /**
   * `stop` when the model finished by itself; `abandoned` when `onContent` gave up, or
   * when the reply named another machine and was read no further.
   */
  doneReason: string | null
  /** True if the reply said it came from a remote host. Nothing after that line was read. */
  remote: boolean
  /** Request sent → first piece of the reply. */
  firstTokenMs: number | null
  outputTokens: number | null
  /** Time the model spent generating, as Ollama reports it. */
  generationMs: number | null
  /** Time spent loading the model, if it had to be loaded. */
  loadMs: number | null
}

/** What a warm-up learned from the server's answer. */
export interface WarmReply {
  /** The reply named another machine as where it came from. */
  remote: boolean
  /** The server answered with a redirect, which was not followed. */
  redirected: boolean
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

  /**
   * Every request goes out through here, and none of them follows a redirect.
   *
   * The address was checked before anything was sent to it: it is on this machine, or
   * the user typed it in. The address a redirect points to was checked by nobody, and a
   * redirect of the kind that keeps the method (307, 308) would hand it the whole
   * request, transcript included. So a redirect is an error, whatever it points to.
   */
  private async send(path: string, init: RequestInit): Promise<Response> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, redirect: 'manual' })
    // Node's fetch hands back the redirect itself; a browser's hands back an empty
    // stand-in of this type.
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {})
      throw new OllamaError('redirect', 'Ollama answered with a redirect, which is not followed')
    }
    return response
  }

  /** The server's version, or null when nothing answers quickly. */
  async version(timeoutMs = 300): Promise<string | null> {
    try {
      const response = await this.send('/api/version', {
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
    const body = await this.json('/api/tags', undefined, timeoutMs)
    const models = isRecord(body) ? body['models'] : undefined
    if (!Array.isArray(models)) throw new OllamaError('stream', 'Unexpected model list')
    return models.flatMap((entry: unknown): OllamaModel[] => {
      if (!isRecord(entry) || typeof entry['name'] !== 'string') return []
      return [
        {
          name: entry['name'],
          digest: typeof entry['digest'] === 'string' ? entry['digest'] : '',
          capabilities: stringList(entry['capabilities']),
          bytes: numberOrNull(entry['size']),
          remote: hasRemoteFields(entry),
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
    if (!isRecord(body)) throw new OllamaError('stream', 'Unexpected model details')
    return {
      capabilities: stringList(body['capabilities']),
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
      response = await this.send('/api/chat', {
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
      if (error instanceof OllamaError) throw error
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
      outputTokens: null,
      generationMs: null,
      loadMs: null,
    }
    let abandoned = false
    let completed = false

    const onLine = (line: string): void => {
      let parsed: unknown
      try {
        parsed = JSON.parse(line) as unknown
      } catch {
        throw new OllamaError('stream', 'Ollama sent a line that is not JSON')
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new OllamaError('stream', 'Ollama sent an unexpected chat reply')
      }
      const piece = parsed as Record<string, unknown>
      // Looked at before anything else. A reply that names another machine is read no
      // further: it will be discarded whatever it says, and however it would have gone
      // on (an error, a stall, a cancel), it has already told where it came from.
      if (hasRemoteFields(piece)) {
        result.remote = true
        abandoned = true
        abandon.abort()
        return
      }
      // A failure after the reply has started arrives as a line of its own.
      if (typeof piece['error'] === 'string') throw new OllamaError('stream', piece['error'])
      if (completed) {
        throw new OllamaError('stream', 'Ollama sent data after the completed chat reply')
      }

      const message = piece['message'] as { role?: unknown; content?: unknown } | undefined
      if (
        !message ||
        typeof message !== 'object' ||
        Array.isArray(message) ||
        message.role !== 'assistant' ||
        typeof message.content !== 'string' ||
        (piece['done'] !== undefined && typeof piece['done'] !== 'boolean') ||
        (piece['done_reason'] !== undefined && typeof piece['done_reason'] !== 'string')
      ) {
        throw new OllamaError('stream', 'Ollama sent an unexpected chat reply')
      }
      if (message.content.length > 0) {
        result.firstTokenMs ??= performance.now() - started
        result.content += message.content
        if (request.onContent?.(result.content) === false) {
          abandoned = true
          abandon.abort()
        }
      }
      if (piece['done'] === true) {
        completed = true
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
        for (const line of lines) {
          // What follows a line that ended the reading is not looked at.
          if (abandoned) break
          if (line.trim()) onLine(line)
        }
        if (abandoned) break
      }
      if (!abandoned) {
        // Flush buffered UTF-8 bytes as well: a truncated character after the final
        // record is malformed data, not an empty tail that can establish locality.
        pending += decoder.decode()
        if (pending.trim()) onLine(pending)
      }
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

    // A clean HTTP EOF is not completion: an empty or cut-short reply says nothing
    // about locality. Only the terminal Ollama record can establish a local reply.
    // Remote metadata and intentional content rejection still stop reading early.
    if (!abandoned && !completed) {
      throw new OllamaError('stream', 'Ollama ended the chat reply before completion')
    }
    if (abandoned) result.doneReason = 'abandoned'
    return result
  }

  /**
   * Has the model loaded and its instructions read before the transcript exists, so
   * the real request does not pay for either.
   *
   * Resolves with what the reply said about where it came from: a model can look local
   * in every list and still answer from another machine, and this is the first reply
   * there is. (A reply is read no further than the line that names another machine, so
   * one that goes on to fail has still been heard.) A server that answered with a
   * redirect is reported as well, because the transcript would be answered the same
   * way. A local result requires a valid reply ending with `done:true`, even if its
   * content is empty or its token limit was reached. Resolves null if the reply is
   * missing, malformed, incomplete, or fails before establishing locality.
   */
  async warm(
    model: string,
    prefix: readonly ChatMessage[],
    signal?: AbortSignal,
  ): Promise<WarmReply | null> {
    try {
      const reply = await this.chat({
        model,
        messages: prefix,
        numPredict: 1,
        ...(signal ? { signal } : {}),
      })
      return { remote: reply.remote, redirected: false }
    } catch (error) {
      if (error instanceof OllamaError && error.kind === 'redirect') {
        return { remote: false, redirected: true }
      }
      return null
    }
  }

  private async json(path: string, body: unknown, timeoutMs: number): Promise<unknown> {
    let response: Response
    try {
      response = await this.send(path, {
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
      if (error instanceof OllamaError) throw error
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
