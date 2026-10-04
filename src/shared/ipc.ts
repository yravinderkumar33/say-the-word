import { z } from 'zod'

export { IPC } from './ipc-channels'

// --- Capture -------------------------------------------------------------------------

export type CaptureCommand =
  | { kind: 'start'; session: number; deviceId: string | null }
  /** Stop after a short tail, send what is left, and tell the worker the session is over. */
  | { kind: 'stop'; session: number }
  /** Stop at once and send nothing more. */
  | { kind: 'cancel'; session: number }
  /** The session's text has arrived (or never will): its audio need not be kept any longer. */
  | { kind: 'release'; session: number }
  /** Undo or Retry: send the recording that is still held to the worker again. */
  | { kind: 'resend'; session: number }
  /** Tests only: behave as if the microphone had been unplugged. */
  | { kind: 'loseMicrophone'; session: number }

export const captureEventSchema = z.discriminatedUnion('kind', [
  /** Audio has started to flow. `openMs` is how long the microphone took to open. */
  z.object({ kind: z.literal('live'), session: z.number().int(), openMs: z.number() }),
  /** Capture is over and every frame has been sent. `micLost` means it ended on its own. */
  z.object({
    kind: z.literal('ended'),
    session: z.number().int(),
    frames: z.number().int(),
    micLost: z.boolean(),
  }),
  z.object({ kind: z.literal('failed'), session: z.number().int(), message: z.string() }),
  /** Asked to send a recording again, but it is no longer held. */
  z.object({ kind: z.literal('gone'), session: z.number().int() }),
])
export type CaptureEvent = z.infer<typeof captureEventSchema>

export const microphonesSchema = z.array(z.object({ deviceId: z.string(), label: z.string() }))
export type Microphone = z.infer<typeof microphonesSchema>[number]

// --- The pill ------------------------------------------------------------------------

/** `start`: the resting pill was clicked. `stop`: the stop button of a hands-free recording. */
export const pillActionSchema = z.enum(['copy', 'dismiss', 'cancel', 'start', 'stop', 'redo'])
export type PillAction = z.infer<typeof pillActionSchema>

/** A short message on the pill, shown when something did not end in a paste. */
export interface PillRecovery {
  message: string
  /** Offer a Copy button: the session left text behind. */
  canCopy: boolean
  /** Draw attention with a sound, for things the user would otherwise miss. */
  sound: boolean
  /**
   * Offer to transcribe the recording after all and paste it: `Undo` after a cancel,
   * `Retry` after a failed decode. Absent when the recording is no longer held.
   */
  redo?: 'Undo' | 'Retry'
}

export type PillState =
  | { kind: 'resting' }
  /** The microphone has been requested but no audio is flowing yet. */
  | { kind: 'starting' }
  /** `handsFree`: no key is held, so the pill offers Stop and Cancel. */
  | { kind: 'listening'; handsFree: boolean }
  | { kind: 'processing' }
  | ({ kind: 'recovery' } & PillRecovery)

/**
 * `busy`: the shortcut was pressed while the previous dictation is still being processed.
 * `limitSoon`: a hands-free recording has a minute left before it is stopped.
 */
export type PillCue = 'busy' | 'limitSoon'

// --- Smoke check ---------------------------------------------------------------------

export interface SmokeRequest {
  /** When present, the overlay sends this audio to the worker as one session. */
  audio: { session: number; samples: Float32Array } | null
}

export interface OverlaySmokeReport {
  /** `app:` in a packaged build, `http:` under the dev server. */
  pageProtocol: string
  workletLoaded: boolean
  probePosted: boolean
  /** Frames of the smoke recording sent to the worker; zero when none was supplied. */
  framesPosted: number
  error?: string
}

// --- Hub -----------------------------------------------------------------------------

/**
 * Where speech recognition stands. `stopped` is normal: the model is unloaded after a
 * while without dictation, and loaded again on the next one.
 */
export type SpeechState = 'stopped' | 'modelMissing' | 'loading' | 'ready' | 'failed'

export interface AppStatus {
  versions: { app: string; electron: string; node: string; chrome: string }
  packaged: boolean
  helper: {
    running: boolean
    protocol: number | null
    /** Null while the helper is not running. */
    accessibilityTrusted: boolean | null
    /** True once the key event tap exists, which is when shortcuts start working. */
    tapInstalled: boolean | null
  }
  speech: {
    state: SpeechState
    modelDownloaded: boolean
    modelLabel: string
    /** Size of the download in bytes. */
    modelBytes: number
    /** The loaded engine's id, or null while no model is loaded. */
    engine: string | null
    /** Download progress from 0 to 1, or null when no download is running. */
    downloadProgress: number | null
    downloadError: string | null
  }
  microphone: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
}
