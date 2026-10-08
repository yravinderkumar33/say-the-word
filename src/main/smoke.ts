import { app, type BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { z } from 'zod'
import { FRAME_SAMPLES, SAMPLE_RATE } from '@shared/audio-format'
import { HELPER_PROTOCOL_VERSION } from '@shared/helper-protocol'
import { IPC, type OverlaySmokeReport, type SmokeRequest } from '@shared/ipc'
import type { WorkerEvent } from '@shared/stt-protocol'
import { decodeWav } from '@shared/wav'
import { wordErrorRate } from '@shared/wer'
import { NO_TIMINGS } from './history/from-session'
import { DECODE_THREADS } from './dictation/speech-service'
import type { HelperBridge } from './native/helper-bridge'
import { listenFromOwnPages } from './security'
import { StorageHost } from './storage/storage-host'
import { DEFAULT_MODEL } from './stt/model-catalog'
import { adoptModel, modelDir } from './stt/model-store'
import { modelsRoot } from './stt/models-dir'
import type { SttHost } from './stt/stt-host'
import { loadRenderer } from './windows/load-renderer'

export interface SmokeCheck {
  name: string
  ok: boolean
  detail: string
  /** The check could not run here (for example, the speech model is not downloaded). */
  skipped?: boolean
}

export interface SmokeReport {
  ok: boolean
  packaged: boolean
  versions: { app: string; electron: string; node: string; chrome: string }
  checks: SmokeCheck[]
}

interface SmokeParts {
  helper: HelperBridge
  stt: SttHost
  overlay: BrowserWindow
}

type ProbeAck = Extract<WorkerEvent, { t: 'probe-ack' }>

const SMOKE_SESSION = 1
/** The recording is synthetic speech and the check is about plumbing, so this is loose. */
const MAX_WORD_ERROR_RATE = 0.2

const overlayReportSchema = z.object({
  pageProtocol: z.string(),
  workletLoaded: z.boolean(),
  probePosted: z.boolean(),
  framesPosted: z.number(),
  error: z.string().exactOptional(),
})
const NOT_UNDERSTOOD: OverlaySmokeReport = {
  pageProtocol: '',
  workletLoaded: false,
  probePosted: false,
  framesPosted: 0,
  error: 'the overlay page sent a report that could not be read',
}

class Skipped extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms} ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

async function check(name: string, run: () => Promise<string>): Promise<SmokeCheck> {
  try {
    return { name, ok: true, detail: await run() }
  } catch (error) {
    if (error instanceof Skipped) return { name, ok: true, detail: error.message, skipped: true }
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A short recording and the words it contains. `WHISPER_FLOW_SMOKE_AUDIO` names the WAV;
 * a development run falls back to a generated fixture. The text sits beside the audio:
 * `short.daniel.wav` is described by `short.txt`.
 */
function smokeRecording(): { samples: Float32Array; text: string } | null {
  const path =
    process.env['WHISPER_FLOW_SMOKE_AUDIO'] ??
    (app.isPackaged
      ? null
      : join(app.getAppPath(), 'tests', 'fixtures', 'audio', 'short.daniel.wav'))
  if (!path || !existsSync(path)) return null
  const textPath = join(dirname(path), `${basename(path).split('.')[0]}.txt`)
  if (!existsSync(textPath)) return null
  const audio = decodeWav(readFileSync(path))
  if (audio.sampleRate !== SAMPLE_RATE) return null
  return { samples: audio.samples, text: readFileSync(textPath, 'utf8').trim() }
}

/**
 * Starts every part of the app once and checks that the parts can talk to each other.
 * Needs no permissions and no microphone, so it can run unattended. With the speech
 * model on disk it also loads the model and transcribes a short recording, which is
 * the proof that the native speech library runs inside the signed app.
 */
export async function runSmoke({ helper, stt, overlay }: SmokeParts): Promise<SmokeReport> {
  const checks: SmokeCheck[] = []

  checks.push(
    await check('helper starts and answers', async () => {
      helper.start()
      const ready = await helper.whenReady()
      if (ready.protocol !== HELPER_PROTOCOL_VERSION) {
        throw new Error(`helper protocol ${ready.protocol}, app expects ${HELPER_PROTOCOL_VERSION}`)
      }
      const reply = await helper.ping()
      if (reply.pong !== true) throw new Error('unexpected ping reply')
      return `protocol ${ready.protocol}, accessibilityTrusted=${ready.accessibilityTrusted}`
    }),
  )

  checks.push(
    await check('speech worker starts', async () => {
      await stt.start()
      return 'ready'
    }),
  )

  const modelReady = (await adoptModel(modelsRoot(), DEFAULT_MODEL)).ready
  let modelLoaded = false
  checks.push(
    await check('speech model loads in the worker', async () => {
      if (!modelReady) throw new Skipped('the speech model is not downloaded')
      const { loadMs } = await stt.load(modelDir(modelsRoot(), DEFAULT_MODEL), DECODE_THREADS)
      modelLoaded = true
      return `${stt.engine ?? 'unknown engine'} in ${loadMs.toFixed(0)} ms`
    }),
  )

  checks.push(
    await check('overlay page loads', async () => {
      await withTimeout(loadRenderer(overlay, 'overlay'), 10_000, 'overlay load')
      return overlay.webContents.getURL()
    }),
  )

  // The renderer half: load the capture worklet, send one frame to the worker and,
  // when there is a recording, send that too.
  const recording = modelLoaded ? smokeRecording() : null
  const probeAck = new Promise<ProbeAck>((resolve) => {
    const onEvent = (event: WorkerEvent): void => {
      if (event.t !== 'probe-ack') return
      stt.off('event', onEvent)
      resolve(event)
    }
    stt.on('event', onEvent)
  })
  // From the app's own page only, and checked, as everything a page sends is.
  const rendererReport = new Promise<OverlaySmokeReport>((resolve) => {
    listenFromOwnPages(IPC.smokeReport, (payload) => {
      const parsed = overlayReportSchema.safeParse(payload)
      resolve(parsed.success ? parsed.data : NOT_UNDERSTOOD)
    })
  })
  const transcript = recording
    ? stt.transcript(SMOKE_SESSION, new AbortController().signal, 30_000)
    : null
  transcript?.catch(() => {}) // Reported by its own check below.

  let report: OverlaySmokeReport | null = null
  checks.push(
    await check('overlay runs its checks', async () => {
      stt.connectRenderer(overlay.webContents)
      const request: SmokeRequest = {
        audio: recording ? { session: SMOKE_SESSION, samples: recording.samples } : null,
      }
      overlay.webContents.send(IPC.smokeRun, request)
      report = await withTimeout(rendererReport, 10_000, 'overlay report')
      if (report.error) throw new Error(report.error)
      return `page served over ${report.pageProtocol}`
    }),
  )

  checks.push(
    await check('capture worklet loads', async () => {
      if (!report?.workletLoaded) throw new Error('worklet did not load')
      return 'processor registered'
    }),
  )

  checks.push(
    await check('audio frame reaches the speech worker', async () => {
      if (!report?.probePosted) throw new Error('renderer did not post a frame')
      const ack = await withTimeout(probeAck, 5_000, 'frame acknowledgement')
      if (!ack.isFloat32) throw new Error('frame did not arrive as a Float32Array')
      if (ack.samples !== FRAME_SAMPLES) {
        throw new Error(`frame had ${ack.samples} samples, expected ${FRAME_SAMPLES}`)
      }
      return `${ack.samples} samples, Float32Array intact`
    }),
  )

  checks.push(
    await check('a recording is transcribed', async () => {
      if (!modelReady) throw new Skipped('the speech model is not downloaded')
      if (!recording || !transcript) throw new Skipped('no recording to transcribe')
      if (!report?.framesPosted) throw new Error('renderer did not send the recording')
      const result = await transcript
      const errorRate = wordErrorRate(recording.text, result.text)
      if (errorRate > MAX_WORD_ERROR_RATE) {
        throw new Error(`word error rate ${(errorRate * 100).toFixed(0)}% on the test recording`)
      }
      // Timings only: the transcript itself stays out of the report.
      return (
        `${(result.audioMs / 1000).toFixed(1)} s of audio in ${result.decodeMs.toFixed(0)} ms, ` +
        `word error rate ${(errorRate * 100).toFixed(0)}%`
      )
    }),
  )

  checks.push(
    await check('the storage process keeps a dictation', async () => {
      // In memory, in a folder of its own: nothing of anyone's is opened, and nothing is left.
      const dir = mkdtempSync(join(tmpdir(), 'flow-smoke-storage-'))
      const storage = new StorageHost({
        history: { dir: join(dir, 'history'), keep: 'session', keepIsKnown: true, paused: false },
        usageFile: join(dir, 'usage.json'),
        weekStartsOn: 1,
      })
      try {
        await storage.ready
        storage.history.put({
          id: 'smoke',
          endedAt: Date.now(),
          app: null,
          outcome: 'pasted',
          fetched: null,
          mode: 'verbatim',
          note: null,
          heard: 'smoke test',
          written: 'smoke test',
          failure: null,
          audioMs: null,
          timings: NO_TIMINGS,
        })
        await storage.flush()
        const page = await storage.history.page({ search: 'smoke', limit: 5 })
        if (page.rows.length !== 1) throw new Error(`${page.rows.length} listed, 1 expected`)
        return 'SQLite in its own process: written, and listed again'
      } finally {
        await storage.stop()
        rmSync(dir, { recursive: true, force: true })
      }
    }),
  )

  return {
    ok: checks.every((item) => item.ok),
    packaged: app.isPackaged,
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
    checks,
  }
}
