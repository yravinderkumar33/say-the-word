import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelSpec } from '../../src/main/stt/model-catalog'
import {
  downloadModel,
  isModelReady,
  modelDir,
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
})

describe('isModelReady', () => {
  it('is false when a file was changed after it was verified', async () => {
    await downloadModel(root, spec())
    await writeFile(join(modelDir(root, spec()), 'small.txt'), 'shorter')

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
