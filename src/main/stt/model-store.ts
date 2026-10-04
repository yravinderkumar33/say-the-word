import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { ModelFile, ModelSpec } from './model-catalog'

/**
 * Downloads speech models and keeps them on disk.
 *
 * A download can be interrupted at any point and resumed: bytes go to `<name>.partial`,
 * and the next attempt asks the server for the rest. A file only gets its real name
 * once its size and SHA-256 match the catalog, so nothing half-downloaded or altered
 * is ever loaded.
 *
 * This module has no Electron imports, so scripts and tests can use it directly.
 */

export interface DownloadProgress {
  file: string
  /** Bytes of this file on disk so far. */
  fileBytes: number
  fileTotal: number
  /** Bytes across the whole model so far. */
  overallBytes: number
  overallTotal: number
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
  /** For tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

const MARKER = '.verified.json'

export function modelDir(root: string, spec: ModelSpec): string {
  return join(root, spec.id)
}

export function totalBytes(spec: ModelSpec): number {
  return spec.files.reduce((sum, file) => sum + file.bytes, 0)
}

/** True when every file is present with the expected size and a verified checksum. */
export async function isModelReady(root: string, spec: ModelSpec): Promise<boolean> {
  const dir = modelDir(root, spec)
  const verified = await readMarker(dir)
  for (const file of spec.files) {
    if (verified[file.name] !== file.sha256) return false
    if ((await sizeOf(join(dir, file.name))) !== file.bytes) return false
  }
  return true
}

/** Downloads whatever is missing. Resolves once the whole model is verified on disk. */
export async function downloadModel(
  root: string,
  spec: ModelSpec,
  options: DownloadOptions = {},
): Promise<void> {
  const dir = modelDir(root, spec)
  await mkdir(dir, { recursive: true })
  const verified = await readMarker(dir)
  const overallTotal = totalBytes(spec)
  let overallBytes = 0

  for (const file of spec.files) {
    const report = (fileBytes: number): void => {
      options.onProgress?.({
        file: file.name,
        fileBytes,
        fileTotal: file.bytes,
        overallBytes: overallBytes + fileBytes,
        overallTotal,
      })
    }

    const finalPath = join(dir, file.name)
    const alreadyThere =
      verified[file.name] === file.sha256 && (await sizeOf(finalPath)) === file.bytes
    if (!alreadyThere) {
      await downloadFile(file, finalPath, report, options)
      verified[file.name] = file.sha256
      await writeFile(join(dir, MARKER), JSON.stringify(verified, null, 2))
    }
    report(file.bytes)
    overallBytes += file.bytes
  }
}

async function downloadFile(
  file: ModelFile,
  finalPath: string,
  report: (fileBytes: number) => void,
  options: DownloadOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const partialPath = `${finalPath}.partial`

  let have = (await sizeOf(partialPath)) ?? 0
  if (have > file.bytes) {
    // Larger than the file can be: left over from something else. Start again.
    await rm(partialPath, { force: true })
    have = 0
  }

  const hash = createHash('sha256')
  if (have > 0) await hashExisting(partialPath, hash)

  if (have < file.bytes) {
    const response = await fetchImpl(file.url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      redirect: 'follow',
      ...(options.signal ? { signal: options.signal } : {}),
    })
    if (!response.ok || !response.body) {
      throw new Error(`Download of ${file.name} failed: HTTP ${response.status}`)
    }

    // 206 means the server honoured the range. A plain 200 means it sent the whole
    // file again, so what was on disk is discarded.
    const resuming = have > 0 && response.status === 206
    const out = createWriteStream(partialPath, { flags: resuming ? 'a' : 'w' })
    const fresh = resuming ? hash : createHash('sha256')
    let received = resuming ? have : 0
    // A disk that fills up, or a file that cannot be opened, fails this download, which
    // can then be tried again. Without a listener the error would be raised with nobody
    // to catch it, and the loop below would wait for ever for room that never comes.
    let writeError: Error | null = null
    const failed = new Promise<never>((_resolve, reject) => {
      out.once('error', (error) => {
        writeError = error
        reject(error)
      })
    })
    failed.catch(() => {})
    try {
      for await (const chunk of Readable.fromWeb(response.body as never) as AsyncIterable<Buffer>) {
        if (writeError) break
        fresh.update(chunk)
        received += chunk.length
        if (!out.write(chunk)) {
          await Promise.race([new Promise<void>((resolve) => out.once('drain', resolve)), failed])
        }
        report(received)
      }
    } finally {
      // What has arrived is written out, so that the next attempt can resume from it.
      if (writeError) out.destroy()
      else await Promise.race([new Promise<void>((resolve) => out.end(resolve)), failed])
    }
    if (writeError) throw writeError
    await verifyAndPublish(file, partialPath, finalPath, received, fresh)
    return
  }

  await verifyAndPublish(file, partialPath, finalPath, have, hash)
}

async function verifyAndPublish(
  file: ModelFile,
  partialPath: string,
  finalPath: string,
  size: number,
  hash: Hash,
): Promise<void> {
  if (size !== file.bytes) {
    // Short: the connection dropped. The partial file stays, so the next attempt resumes.
    throw new Error(`Download of ${file.name} stopped at ${size} of ${file.bytes} bytes`)
  }
  const digest = hash.digest('hex')
  if (digest !== file.sha256) {
    // Complete but wrong: resuming cannot fix it, so the next attempt starts clean.
    await rm(partialPath, { force: true })
    throw new Error(`Checksum mismatch for ${file.name}: the download was discarded`)
  }
  await rename(partialPath, finalPath)
}

function hashExisting(path: string, hash: Hash): Promise<void> {
  return new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

async function readMarker(dir: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, MARKER), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}
