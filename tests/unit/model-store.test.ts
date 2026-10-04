import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelSpec } from '../../src/main/stt/model-catalog'
import {
  adoptModel,
  downloadModel,
  isModelReady,
  modelDir,
  verifyModel,
  type DownloadProgress,
} from '../../src/main/stt/model-store'

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

/** Deterministic bytes, so a failure is reproducible. */
function bytes(length: number, seed: number): Buffer {
  const buffer = Buffer.alloc(length)
  for (let index = 0; index < length; index++) buffer[index] = (index * 31 + seed) % 251
  return buffer
}

const contents: Record<string, Buffer> = {
  'big.bin': bytes(200_000, 7),
  'small.txt': bytes(1_234, 3),
}

interface ServerOptions {
  /** Ignore Range headers and always send the whole file. */
  ignoreRange?: boolean
  /** Close the connection after this many bytes of the body. */
  cutAfter?: number
  /** Serve this instead of the real content. */
  corrupt?: Buffer
  status?: number
}

let server: Server
let serverOptions: ServerOptions
let requests: Array<{ url: string; range: string | undefined }>
let root: string

function spec(): ModelSpec {
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    id: 'test-model',
    label: 'Test model',
    licence: 'none',
    languages: ['en'],
    files: Object.entries(contents).map(([name, data]) => ({
      name,
      url: `${base}/${name}`,
      bytes: data.length,
      sha256: sha256(data),
    })),
  }
}

beforeEach(async () => {
  serverOptions = {}
  requests = []
  root = await mkdtemp(join(tmpdir(), 'model-store-'))
  server = createServer((request, response) => {
    const name = (request.url ?? '').slice(1)
    const range = request.headers.range
    requests.push({ url: name, range })
    const data =
      name === 'big.bin' && serverOptions.corrupt ? serverOptions.corrupt : contents[name]
    if (!data || serverOptions.status) {
      response.writeHead(serverOptions.status ?? 404).end()
      return
    }
    const start = range && !serverOptions.ignoreRange ? Number(/bytes=(\d+)-/.exec(range)?.[1]) : 0
    const body = data.subarray(start)
    response.writeHead(start > 0 ? 206 : 200, { 'Content-Length': body.length })
    if (name === 'big.bin' && serverOptions.cutAfter !== undefined) {
      response.write(body.subarray(0, serverOptions.cutAfter), () => response.destroy())
      return
    }
    response.end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  await rm(root, { recursive: true, force: true })
})

describe('downloadModel', () => {
  it('downloads every file, verifies it, and reports the model ready', async () => {
    expect(await isModelReady(root, spec())).toBe(false)

    await downloadModel(root, spec())

    const dir = modelDir(root, spec())
    expect(await readFile(join(dir, 'big.bin'))).toEqual(contents['big.bin'])
    expect(await readFile(join(dir, 'small.txt'))).toEqual(contents['small.txt'])
    expect(await isModelReady(root, spec())).toBe(true)
    expect((await readdir(dir)).filter((name) => name.endsWith('.partial'))).toEqual([])
  })

  it('reports progress up to the full size', async () => {
    const seen: DownloadProgress[] = []

    await downloadModel(root, spec(), { onProgress: (progress) => seen.push({ ...progress }) })

    const total = contents['big.bin']!.length + contents['small.txt']!.length
    expect(seen.at(-1)).toMatchObject({ overallBytes: total, overallTotal: total })
    expect(seen.every((progress) => progress.overallBytes <= total)).toBe(true)
  })

  it('downloads nothing when the model is already there', async () => {
    await downloadModel(root, spec())
    requests.length = 0

    await downloadModel(root, spec())

    expect(requests).toEqual([])
  })

  it('resumes an interrupted download from where it stopped', async () => {
    serverOptions.cutAfter = 60_000
    await expect(downloadModel(root, spec())).rejects.toThrow(/stopped at|terminated|aborted/i)
    expect(await isModelReady(root, spec())).toBe(false)

    serverOptions = {}
    requests.length = 0
    await downloadModel(root, spec())

    const bigRequest = requests.find((request) => request.url === 'big.bin')
    expect(bigRequest?.range).toMatch(/^bytes=\d+-$/)
    expect(Number(/bytes=(\d+)-/.exec(bigRequest!.range!)![1])).toBeGreaterThan(0)
    expect(await readFile(join(modelDir(root, spec()), 'big.bin'))).toEqual(contents['big.bin'])
    expect(await isModelReady(root, spec())).toBe(true)
  })

  it('fails, and can be tried again, when the file cannot be written', async () => {
    // A folder where the download wants to put its file: every write to it fails.
    const blocked = join(modelDir(root, spec()), 'big.bin.partial')
    await mkdir(blocked, { recursive: true })

    await expect(downloadModel(root, spec())).rejects.toThrow(/EISDIR|directory/i)

    await rm(blocked, { recursive: true })
    await downloadModel(root, spec())
    expect(await isModelReady(root, spec())).toBe(true)
  })

  it('starts the file again when the server ignores the range request', async () => {
    serverOptions.cutAfter = 60_000
    await expect(downloadModel(root, spec())).rejects.toThrow()

    serverOptions = { ignoreRange: true }
    await downloadModel(root, spec())

    expect(await readFile(join(modelDir(root, spec()), 'big.bin'))).toEqual(contents['big.bin'])
  })

  it('rejects a file whose checksum does not match, and keeps nothing of it', async () => {
    serverOptions.corrupt = bytes(contents['big.bin']!.length, 99)

    await expect(downloadModel(root, spec())).rejects.toThrow(/checksum mismatch/i)

    const files = await readdir(modelDir(root, spec()))
    expect(files).toEqual([])
    expect(await isModelReady(root, spec())).toBe(false)
  })

  it('reports an HTTP error', async () => {
    serverOptions.status = 503

    await expect(downloadModel(root, spec())).rejects.toThrow(/HTTP 503/)
  })

  it('stops when aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(downloadModel(root, spec(), { signal: controller.signal })).rejects.toThrow()
    expect(await isModelReady(root, spec())).toBe(false)
  })

  it('fetches a damaged file again, and only that one', async () => {
    await downloadModel(root, spec())
    await damage('big.bin')
    requests.length = 0

    await downloadModel(root, spec())

    expect(requests.map((request) => request.url)).toEqual(['big.bin'])
    expect(await readFile(join(modelDir(root, spec()), 'big.bin'))).toEqual(contents['big.bin'])
    expect(await isModelReady(root, spec())).toBe(true)
  })

  it('checks a file that is already there before fetching it, and fetches nothing if it is intact', async () => {
    const dir = modelDir(root, spec())
    await mkdir(dir, { recursive: true })
    for (const [name, data] of Object.entries(contents)) await writeFile(join(dir, name), data)

    await downloadModel(root, spec())

    expect(requests).toEqual([])
    expect(await isModelReady(root, spec())).toBe(true)
  })
})

describe('a download that cannot go on', () => {
  /** One file, and a stand-in for the network that the test feeds by hand. */
  function setup(data = bytes(64, 5)) {
    const model: ModelSpec = {
      id: 'stalled-model',
      label: 'Test model',
      licence: 'none',
      languages: ['en'],
      files: [
        {
          name: 'model.bin',
          url: 'http://unused.invalid/model.bin',
          bytes: data.length,
          sha256: sha256(data),
        },
      ],
    }
    let feed: ReadableStreamDefaultController<Uint8Array> | null = null
    const seen = { requests: [] as Array<string | null>, cancelled: false }
    /** Runs between the downloader looking at the disk and the reply arriving. */
    let beforeAnswer: () => Promise<void> = () => Promise.resolve()
    /** What the reply already holds when it arrives. */
    let firstBytes: Uint8Array | null = null
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('range')
      seen.requests.push(range)
      await beforeAnswer()
      return new Response(
        new ReadableStream<Uint8Array>({
          start: (controller) => {
            feed = controller
            if (firstBytes) controller.enqueue(firstBytes)
          },
          cancel: () => void (seen.cancelled = true),
        }),
        // As a server that honours a range request does.
        { status: range ? 206 : 200 },
      )
    }) as typeof fetch
    const partial = join(modelDir(root, model), 'model.bin.partial')
    return {
      model,
      data,
      seen,
      fetchImpl,
      partial,
      send: (chunk: Uint8Array) => feed?.enqueue(chunk),
      finish: () => feed?.close(),
      answerWith: (bytes: Uint8Array, before: () => Promise<void> = () => Promise.resolve()) => {
        firstBytes = bytes
        beforeAnswer = before
      },
    }
  }

  /**
   * How the download ended, or `pending` if it had not by the time given. Asked as soon
   * as the download starts, so that a failure always has someone waiting for it.
   */
  const within = (download: Promise<void>, ms: number): Promise<string> => {
    const outcome = download.then(
      () => 'finished',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    return Promise.race([
      outcome,
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms)),
    ])
  }
  const moment = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  it('ends at once when the file cannot be written, although the server has gone quiet', async () => {
    const t = setup()
    // One byte arrives and then nothing more ever does. Meanwhile there is a folder
    // where the download wants to put its file, so every write to it fails.
    t.answerWith(t.data.subarray(0, 1), async () => {
      await mkdir(t.partial, { recursive: true })
    })

    const ended = within(downloadModel(root, t.model, { fetchImpl: t.fetchImpl }), 1_000)

    expect(await ended).toMatch(/EISDIR|directory/i)
    // The request was ended too, not left to fetch into nothing.
    expect(t.seen.cancelled).toBe(true)
  })

  it('gives up on a server that has gone quiet, and keeps what arrived', async () => {
    const t = setup()
    t.answerWith(t.data.subarray(0, 10))

    const ended = within(
      downloadModel(root, t.model, { fetchImpl: t.fetchImpl, stalledAfterMs: 60 }),
      1_000,
    )

    expect(await ended).toMatch(/stalled/i)
    expect(t.seen.cancelled).toBe(true)
    expect(await readFile(t.partial)).toEqual(t.data.subarray(0, 10))
    expect(await isModelReady(root, t.model)).toBe(false)
  })

  it('gives up on a server that takes the request and never answers it', async () => {
    const t = setup()
    // No reply at all, not even its first line, until the request is ended.
    const silent = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('the request was ended')))
      })) as typeof fetch

    const ended = within(
      downloadModel(root, t.model, { fetchImpl: silent, stalledAfterMs: 60 }),
      1_000,
    )

    expect(await ended).toMatch(/stalled/i)
  })

  it('does not take a slow download for a stalled one', async () => {
    const t = setup()
    t.answerWith(t.data.subarray(0, 16))

    const ended = within(
      downloadModel(root, t.model, { fetchImpl: t.fetchImpl, stalledAfterMs: 120 }),
      2_000,
    )
    // A piece every 40 ms: slow, but never quiet for 120.
    for (let sent = 16; sent < t.data.length; sent += 16) {
      await moment(40)
      t.send(t.data.subarray(sent, sent + 16))
    }
    await moment(40)
    t.finish()

    expect(await ended).toBe('finished')
    expect(await isModelReady(root, t.model)).toBe(true)
  })

  it('stops when it is cancelled part-way, keeps what arrived, and resumes from there', async () => {
    const t = setup()
    const cancel = new AbortController()
    t.answerWith(t.data.subarray(0, 24))

    const ended = within(
      downloadModel(root, t.model, { fetchImpl: t.fetchImpl, signal: cancel.signal }),
      1_000,
    )
    await moment()
    cancel.abort()

    expect(await ended).toMatch(/abort|cancel/i)
    expect(t.seen.cancelled).toBe(true)
    expect(await readFile(t.partial)).toEqual(t.data.subarray(0, 24))

    // The next attempt asks only for the rest, and finishes the file.
    t.answerWith(t.data.subarray(24))
    const again = within(downloadModel(root, t.model, { fetchImpl: t.fetchImpl }), 1_000)
    await moment()
    expect(t.seen.requests.at(-1)).toBe('bytes=24-')
    t.finish()
    expect(await again).toBe('finished')
    expect(await isModelReady(root, t.model)).toBe(true)
  })
})

/**
 * Overwrites a file with other bytes of the same length, as a failing disk might.
 * `unseen`: the marker is made to describe the file as it is now, which is what a
 * change that leaves the file's date alone looks like to the app.
 */
async function damage(name: string, options: { unseen?: boolean } = {}): Promise<void> {
  const dir = modelDir(root, spec())
  const path = join(dir, name)
  await writeFile(path, Buffer.alloc((await stat(path)).size, 0))
  if (!options.unseen) return
  const markerPath = join(dir, '.verified.json')
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
    '#files': Record<string, { mtimeMs: number }>
  }
  marker['#files'][name]!.mtimeMs = (await stat(path)).mtimeMs
  await writeFile(markerPath, JSON.stringify(marker))
}

describe('isModelReady', () => {
  it('is false when a file was changed after it was verified', async () => {
    await downloadModel(root, spec())
    await writeFile(join(modelDir(root, spec()), 'small.txt'), 'shorter')

    expect(await isModelReady(root, spec())).toBe(false)
  })

  it('is false when a file was replaced by other bytes of the same length', async () => {
    await downloadModel(root, spec())

    await damage('big.bin')

    expect(await isModelReady(root, spec())).toBe(false)
  })

  it('reads no file to answer, so it does not see a change that leaves size and date alone', async () => {
    await downloadModel(root, spec())

    await damage('big.bin', { unseen: true })

    // The price of an answer that costs nothing. `verifyModel` is what reads the files.
    expect(await isModelReady(root, spec())).toBe(true)
  })

  it('is false for a marker that is not what this app writes', async () => {
    await downloadModel(root, spec())
    await writeFile(join(modelDir(root, spec()), '.verified.json'), '["not", "a", "marker"]')

    expect(await isModelReady(root, spec())).toBe(false)
  })

  it('is false when files are present but were never verified', async () => {
    const dir = modelDir(root, spec())
    await mkdir(dir, { recursive: true })
    for (const [name, data] of Object.entries(contents)) await writeFile(join(dir, name), data)

    expect(await isModelReady(root, spec())).toBe(false)
  })

  it('is false when the catalog checksum changes', async () => {
    await downloadModel(root, spec())
    const changed = spec()
    changed.files[0]!.sha256 = 'f'.repeat(64)

    expect(await isModelReady(root, changed)).toBe(false)
  })
})

describe('verifyModel', () => {
  it('finds nothing wrong with a model that was just downloaded', async () => {
    await downloadModel(root, spec())

    expect(await verifyModel(root, spec())).toEqual({ ok: true, missing: [], damaged: [] })
    expect(await isModelReady(root, spec())).toBe(true)
  })

  it('finds a file that changed without its size or its date changing, and removes it', async () => {
    await downloadModel(root, spec())
    await damage('big.bin', { unseen: true })
    // Nothing short of reading the file shows it.
    expect(await isModelReady(root, spec())).toBe(true)

    const check = await verifyModel(root, spec())

    expect(check).toEqual({ ok: false, missing: [], damaged: ['big.bin'] })
    expect(existsSync(join(modelDir(root, spec()), 'big.bin'))).toBe(false)
    expect(existsSync(join(modelDir(root, spec()), 'small.txt'))).toBe(true)
    expect(await isModelReady(root, spec())).toBe(false)
  })

  it('leads to a repair: the next download fetches the file that was removed', async () => {
    await downloadModel(root, spec())
    await damage('big.bin', { unseen: true })
    await verifyModel(root, spec())
    requests.length = 0

    await downloadModel(root, spec())

    expect(requests.map((request) => request.url)).toEqual(['big.bin'])
    expect(await readFile(join(modelDir(root, spec()), 'big.bin'))).toEqual(contents['big.bin'])
    expect(await verifyModel(root, spec())).toMatchObject({ ok: true })
  })

  it('reports files that are not there, and creates nothing for a model never downloaded', async () => {
    expect(await verifyModel(root, spec())).toEqual({
      ok: false,
      missing: ['big.bin', 'small.txt'],
      damaged: [],
    })
    expect(existsSync(modelDir(root, spec()))).toBe(false)
  })
})

describe('adoptModel', () => {
  const place = async (): Promise<string> => {
    const dir = modelDir(root, spec())
    await mkdir(dir, { recursive: true })
    for (const [name, data] of Object.entries(contents)) await writeFile(join(dir, name), data)
    return dir
  }

  it('says a downloaded model is ready, without reading it again', async () => {
    await downloadModel(root, spec())

    expect(await adoptModel(root, spec())).toEqual({ ready: true, check: null })
  })

  it('takes in files that arrived by another route, once they have been checked', async () => {
    await place()
    expect(await isModelReady(root, spec())).toBe(false)

    const adoption = await adoptModel(root, spec())

    expect(adoption).toEqual({ ready: true, check: { ok: true, missing: [], damaged: [] } })
    expect(await isModelReady(root, spec())).toBe(true)
    expect(requests).toEqual([])
  })

  it('takes in a model that an older version of the app had recorded', async () => {
    const dir = await place()
    // What the marker looked like before it recorded sizes and dates: checksums only.
    const older = Object.fromEntries(spec().files.map((file) => [file.name, file.sha256]))
    await writeFile(join(dir, '.verified.json'), JSON.stringify(older))
    expect(await isModelReady(root, spec())).toBe(false)

    expect((await adoptModel(root, spec())).ready).toBe(true)

    expect(await isModelReady(root, spec())).toBe(true)
  })

  it('keeps writing what an older version of the app looks for', async () => {
    // Every build shares this folder. One that knows nothing of sizes and dates reads a
    // checksum under each file's name, and must go on finding it.
    await downloadModel(root, spec())

    const marker = JSON.parse(
      await readFile(join(modelDir(root, spec()), '.verified.json'), 'utf8'),
    ) as Record<string, unknown>

    for (const file of spec().files) expect(marker[file.name]).toBe(file.sha256)
    expect(marker['#files']).toMatchObject({
      'big.bin': { bytes: contents['big.bin']!.length },
      'small.txt': { bytes: contents['small.txt']!.length },
    })
  })

  it('does not take the older version at its word for a file that has changed since', async () => {
    const dir = await place()
    const older = Object.fromEntries(spec().files.map((file) => [file.name, file.sha256]))
    await writeFile(join(dir, '.verified.json'), JSON.stringify(older))
    await damage('big.bin')

    const adoption = await adoptModel(root, spec())

    expect(adoption.ready).toBe(false)
    expect(adoption.check).toEqual({ ok: false, missing: [], damaged: ['big.bin'] })
    expect(existsSync(join(dir, 'big.bin'))).toBe(false)
  })

  it('removes a file that was changed after the download, and keeps the rest', async () => {
    await downloadModel(root, spec())
    await damage('big.bin')

    const adoption = await adoptModel(root, spec())

    expect(adoption).toEqual({
      ready: false,
      check: { ok: false, missing: [], damaged: ['big.bin'] },
    })
    expect(existsSync(join(modelDir(root, spec()), 'small.txt'))).toBe(true)
    // What is left to do is a download of the one file.
    requests.length = 0
    await downloadModel(root, spec())
    expect(requests.map((request) => request.url)).toEqual(['big.bin'])
    expect((await adoptModel(root, spec())).ready).toBe(true)
  })

  it('takes in an intact model although its folder cannot be written to', async () => {
    const dir = await place()
    // As an older version of the app left it: checksums only. And the folder is
    // read-only, as it would be on a full disk for all that can be written to it.
    const older = Object.fromEntries(spec().files.map((file) => [file.name, file.sha256]))
    await writeFile(join(dir, '.verified.json'), JSON.stringify(older))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await chmod(dir, 0o555)
    try {
      const adoption = await adoptModel(root, spec())

      expect(adoption.ready).toBe(true)
      // And it stays ready for the rest of the run, without the files being read again.
      expect(await isModelReady(root, spec())).toBe(true)
      expect(await adoptModel(root, spec())).toEqual({ ready: true, check: null })
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      await chmod(dir, 0o755)
      logged.mockRestore()
    }
    // Nothing was written: the marker on disk is still the older one.
    expect(JSON.parse(await readFile(join(dir, '.verified.json'), 'utf8'))).toEqual(older)
  })

  it('reads nothing when a file is missing: there is no model to take in', async () => {
    const dir = await place()
    await rm(join(dir, 'small.txt'))

    expect(await adoptModel(root, spec())).toEqual({ ready: false, check: null })
    expect(existsSync(join(dir, '.verified.json'))).toBe(false)
  })
})
