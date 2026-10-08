import { createHash, type Hash } from 'node:crypto'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelFile, ModelSpec } from './model-catalog'

/**
 * Downloads speech models and keeps them on disk.
 *
 * A download can be interrupted at any point and resumed: bytes go to `<name>.partial`,
 * and the next attempt asks the server for the rest. A file only gets its real name
 * once its size and SHA-256 match the catalog, so nothing half-downloaded or altered
 * is ever loaded.
 *
 * A file that has passed is vouched for in a small marker file, with its size and the
 * time it was last written. While those still hold, the file is taken to be what was
 * checked, and asking "is the model there?" costs a few `stat` calls. When they do not
 * (the file was changed, copied, or written by an older version of this app) nothing
 * vouches for it any more, and it is read and checked again before it is used.
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
  /** Ends the download. What has arrived is kept, so the next attempt resumes. */
  signal?: AbortSignal
  /** For tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** For tests. Defaults to `STALLED_AFTER_MS`. */
  stalledAfterMs?: number
}

/**
 * A download is given up on when nothing has arrived for this long. A connection can
 * go quiet without closing, and a download that waits for ever can be neither retried
 * nor reported. What has arrived is kept.
 */
const STALLED_AFTER_MS = 30_000

const MARKER = '.verified.json'
/**
 * The marker's entry for what was seen of each file when it was verified. Every other
 * entry is a file name with the checksum it was verified against, which is all that
 * versions before October 2026 wrote, and all they read: they share this folder, and
 * go on finding what they look for.
 */
const SEEN = '#files'

/** What a file looked like on disk when its checksum was verified. */
interface Seen {
  bytes: number
  /** When the file was last written, as the file system reports it. */
  mtimeMs: number
}

interface Marker {
  /** By file name: the checksum the file was verified against. */
  checksums: Record<string, string>
  /** By file name. Without an entry here, nothing is known about the file as it is now. */
  seen: Record<string, Seen>
}

/** What reading a model's files again found. */
export interface ModelCheck {
  /** True when every file is present and matches its checksum. */
  ok: boolean
  /** Files that are not there, or not at their full size. */
  missing: string[]
  /** Files that were there in full and did not match. They have been removed. */
  damaged: string[]
}

export function modelDir(root: string, spec: ModelSpec): string {
  return join(root, spec.id)
}

export function totalBytes(spec: ModelSpec): number {
  return spec.files.reduce((sum, file) => sum + file.bytes, 0)
}

/**
 * True when every file is present and vouched for: its checksum was verified, and its
 * size and the time it was last written are what they were then.
 *
 * It reads no file, so it can be asked as often as a status display likes. It does not
 * see a change that leaves both size and time as they were; a model that then fails to
 * load is checked in full (`verifyModel`).
 */
export async function isModelReady(root: string, spec: ModelSpec): Promise<boolean> {
  const dir = modelDir(root, spec)
  const marker = await readMarker(dir)
  for (const file of spec.files) {
    if (!(await vouchedFor(marker, file, join(dir, file.name)))) return false
  }
  return true
}

export interface Adoption {
  /** True when the model can be loaded. */
  ready: boolean
  /** What reading the files found, when some had to be read. */
  check: ModelCheck | null
}

/**
 * Makes the model ready from what is on disk, if it can be: files that are there in
 * full but that nothing vouches for are read and checked, once. Those that match are
 * vouched for from then on; those that do not are removed.
 *
 * This is what to ask before loading the model. It takes about a second for the 671 MB
 * model when there is something to read, and no time when there is not.
 */
export async function adoptModel(root: string, spec: ModelSpec): Promise<Adoption> {
  if (await isModelReady(root, spec)) return { ready: true, check: null }
  const dir = modelDir(root, spec)
  for (const file of spec.files) {
    // Reading is only worth it if the whole model could come out of it.
    if ((await sizeOf(join(dir, file.name))) !== file.bytes) return { ready: false, check: null }
  }
  const check = await verifyModel(root, spec, { trustVouched: true })
  return { ready: check.ok, check }
}

/**
 * Reads the model's files and compares each with its checksum in the catalog.
 *
 * A file that matches is vouched for. A file that is there in full and does not match
 * is removed: it cannot be used, and the next download fetches it again. With
 * `trustVouched`, files that are already vouched for are not read again.
 */
export async function verifyModel(
  root: string,
  spec: ModelSpec,
  options: { trustVouched?: boolean } = {},
): Promise<ModelCheck> {
  const dir = modelDir(root, spec)
  const marker = await readMarker(dir)
  const missing: string[] = []
  const damaged: string[] = []

  for (const file of spec.files) {
    const path = join(dir, file.name)
    if (options.trustVouched && (await vouchedFor(marker, file, path))) continue
    delete marker.checksums[file.name]
    delete marker.seen[file.name]
    if ((await sizeOf(path)) !== file.bytes) {
      missing.push(file.name)
      continue
    }
    // A file that cannot be read cannot be loaded either. It is left where it is: one
    // that cannot be read now may be readable later.
    const digest = await sha256Of(path).catch(() => null)
    if (digest === null) {
      missing.push(file.name)
      continue
    }
    if (digest === file.sha256) {
      await vouch(marker, file, path)
    } else {
      await rm(path, { force: true })
      damaged.push(file.name)
    }
  }

  // Only if there is somewhere to write it: checking a model that was never
  // downloaded must not create its folder.
  if ((await sizeOf(dir)) !== null) await writeMarker(dir, marker)
  return { ok: missing.length === 0 && damaged.length === 0, missing, damaged }
}

/**
 * Downloads whatever is missing. Resolves once the whole model is verified on disk.
 *
 * A file that is already there in full is read and checked first, and fetched only if
 * it does not match. That is also the repair: a damaged file is replaced, and the good
 * ones are left alone.
 */
export async function downloadModel(
  root: string,
  spec: ModelSpec,
  options: DownloadOptions = {},
): Promise<void> {
  const dir = modelDir(root, spec)
  await mkdir(dir, { recursive: true })
  const marker = await readMarker(dir)
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
    if (!(await vouchedFor(marker, file, finalPath))) {
      options.signal?.throwIfAborted()
      const alreadyGood =
        (await sizeOf(finalPath)) === file.bytes &&
        (await sha256Of(finalPath).catch(() => null)) === file.sha256
      if (!alreadyGood) await downloadFile(file, finalPath, report, options)
      await vouch(marker, file, finalPath)
      await writeMarker(dir, marker)
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

  if (have >= file.bytes) {
    await verifyAndPublish(file, partialPath, finalPath, have, hash)
    return
  }

  // Three things can end the download from this side: the disk (it fills up, or the
  // file cannot be opened), the network going quiet, and the caller. Each one ends the
  // request at once, which also ends the wait for its next piece. Without that, a
  // failed write would only be noticed when more data happened to arrive, and on a
  // stalled connection that is never.
  const stalledAfterMs = options.stalledAfterMs ?? STALLED_AFTER_MS
  const ending = new AbortController()
  let stalled = false
  // Running from before the request is sent: a server that takes the request and
  // never answers is a stalled download too.
  const quiet = setTimeout(() => {
    stalled = true
    ending.abort()
  }, stalledAfterMs)
  const stalledError = (): Error =>
    new Error(
      `Download of ${file.name} stalled: nothing arrived for ${Math.round(stalledAfterMs / 1_000)} seconds`,
    )

  let response: Response
  try {
    response = await fetchImpl(file.url, {
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      // The model's host sends the request on to wherever the file is stored. What
      // arrives is checked against the catalog's checksum, wherever it came from.
      redirect: 'follow',
      signal: options.signal ? AbortSignal.any([options.signal, ending.signal]) : ending.signal,
    })
  } catch (error) {
    clearTimeout(quiet)
    throw stalled && !options.signal?.aborted ? stalledError() : error
  }
  if (!response.ok || !response.body) {
    clearTimeout(quiet)
    throw new Error(`Download of ${file.name} failed: HTTP ${response.status}`)
  }

  // 206 means the server honoured the range. A plain 200 means it sent the whole
  // file again, so what was on disk is discarded.
  const resuming = have > 0 && response.status === 206
  const out = createWriteStream(partialPath, { flags: resuming ? 'a' : 'w' })
  const fresh = resuming ? hash : createHash('sha256')
  let received = resuming ? have : 0

  const body = (response.body as ReadableStream<Uint8Array>).getReader()
  // Closes the incoming stream as well as ending the request: a stream that does not
  // come from a real connection would not notice the request ending.
  const endRequest = (): void => {
    ending.abort()
    void body.cancel().catch(() => {})
  }
  let writeError: Error | null = null
  out.once('error', (error) => {
    writeError = error
    endRequest()
  })
  ending.signal.addEventListener('abort', endRequest, { once: true })
  options.signal?.addEventListener('abort', endRequest, { once: true })

  let failure: unknown = null
  try {
    for (;;) {
      const { done, value } = await body.read()
      if (done || writeError || stalled || options.signal?.aborted) break
      quiet.refresh()
      fresh.update(value)
      received += value.length
      if (!out.write(value)) await drained(out)
      report(received)
    }
  } catch (error) {
    // The connection broke, or the request was cancelled.
    failure = error
    endRequest()
  } finally {
    clearTimeout(quiet)
    options.signal?.removeEventListener('abort', endRequest)
  }

  // What has arrived is written out, so that the next attempt can resume from it. A
  // failure of this last write is told to the callback before the stream announces it.
  if (writeError) out.destroy()
  else {
    await new Promise<void>((resolve) =>
      out.end((error?: Error | null) => {
        if (error) writeError ??= error
        resolve()
      }),
    )
  }

  // The reason given is the first cause, not what followed from closing the stream.
  if (writeError) throw writeError as Error
  if (options.signal?.aborted) throw abortReason(options.signal)
  if (stalled) throw stalledError()
  if (failure !== null) throw failure
  await verifyAndPublish(file, partialPath, finalPath, received, fresh)
}

/** Resolves when the stream can take more, or can take no more at all. */
function drained(out: WriteStream): Promise<void> {
  if (out.destroyed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      out.off('drain', done)
      out.off('error', done)
      out.off('close', done)
      resolve()
    }
    out.once('drain', done)
    out.once('error', done)
    out.once('close', done)
  })
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('The download was cancelled')
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
  // What was counted and hashed is what arrived; what is published is what is on disk.
  const onDisk = await sizeOf(partialPath)
  if (onDisk !== file.bytes) {
    throw new Error(`Download of ${file.name} stopped at ${onDisk ?? 0} of ${file.bytes} bytes`)
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

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256')
  await hashExisting(path, hash)
  return hash.digest('hex')
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

/** True when the marker still describes the file that is on disk. */
async function vouchedFor(marker: Marker, file: ModelFile, path: string): Promise<boolean> {
  const seen = marker.seen[file.name]
  if (marker.checksums[file.name] !== file.sha256 || !seen || seen.bytes !== file.bytes) {
    return false
  }
  try {
    const found = await stat(path)
    return found.size === file.bytes && found.mtimeMs === seen.mtimeMs
  } catch {
    return false
  }
}

/** Records a file whose checksum has just been verified, as it is on disk now. */
async function vouch(marker: Marker, file: ModelFile, path: string): Promise<void> {
  marker.checksums[file.name] = file.sha256
  marker.seen[file.name] = { bytes: file.bytes, mtimeMs: (await stat(path)).mtimeMs }
}

/**
 * Markers that could not be written (a full disk, a folder that cannot be written to),
 * by model folder. A model whose files have just been read and found intact is usable
 * whether or not that could be recorded; what was found holds for this run, and the
 * files are read again in the next.
 */
const unsaved = new Map<string, Marker>()

async function readMarker(dir: string): Promise<Marker> {
  const kept = unsaved.get(dir)
  if (kept) return kept
  const marker: Marker = { checksums: {}, seen: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(join(dir, MARKER), 'utf8'))
  } catch {
    return marker
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return marker
  for (const [name, entry] of Object.entries(parsed)) {
    if (name === SEEN) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      for (const [file, seen] of Object.entries(entry as Record<string, unknown>)) {
        if (isSeen(seen)) marker.seen[file] = { bytes: seen.bytes, mtimeMs: seen.mtimeMs }
      }
    } else if (typeof entry === 'string') {
      marker.checksums[name] = entry
    }
  }
  return marker
}

function isSeen(value: unknown): value is Seen {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry['bytes'] === 'number' && typeof entry['mtimeMs'] === 'number'
}

/**
 * Written to a temporary file first, so a crash mid-write cannot leave half a marker.
 * A write that fails is not an error of the model: the marker is kept in memory.
 */
async function writeMarker(dir: string, marker: Marker): Promise<void> {
  const path = join(dir, MARKER)
  try {
    await writeFile(
      `${path}.tmp`,
      JSON.stringify({ ...marker.checksums, [SEEN]: marker.seen }, null, 2),
    )
    await rename(`${path}.tmp`, path)
    unsaved.delete(dir)
  } catch (error) {
    unsaved.set(dir, marker)
    console.error(
      `[models] could not record which files were checked (${error instanceof Error ? error.message : String(error)}); they will be read again next time`,
    )
  }
}
