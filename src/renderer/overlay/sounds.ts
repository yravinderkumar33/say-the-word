/**
 * The app's sounds, made with oscillators rather than shipped as files: a few short
 * sine notes each. Nothing is borrowed from another product.
 */
export type Cue =
  /** Audio is flowing: speak now. */
  | 'start'
  /** Recording stopped; the text is on its way. */
  | 'stop'
  /** The recording is locked on: the key can be let go. */
  | 'lock'
  /** The dictation did not end in a paste. */
  | 'notice'
  /** The shortcut was pressed while the previous dictation is still being processed. */
  | 'busy'

interface Note {
  frequency: number
  /** Seconds after the cue begins. */
  at: number
  duration: number
}

const CUES: Record<Cue, Note[]> = {
  start: [
    { frequency: 587.33, at: 0, duration: 0.07 },
    { frequency: 880, at: 0.065, duration: 0.12 },
  ],
  stop: [
    { frequency: 880, at: 0, duration: 0.07 },
    { frequency: 587.33, at: 0.065, duration: 0.12 },
  ],
  lock: [
    { frequency: 987.77, at: 0, duration: 0.06 },
    { frequency: 987.77, at: 0.09, duration: 0.09 },
  ],
  notice: [
    { frequency: 415.3, at: 0, duration: 0.1 },
    { frequency: 311.13, at: 0.1, duration: 0.18 },
  ],
  busy: [{ frequency: 329.63, at: 0, duration: 0.07 }],
}

const VOLUME = 0.16
/** The output is let go shortly after the last sound, so the audio device can rest. */
const SUSPEND_AFTER_MS = 1_500

let context: AudioContext | null = null
let suspendTimer: ReturnType<typeof setTimeout> | null = null

export function playCue(cue: Cue): void {
  try {
    context ??= new AudioContext()
    const audio = context
    if (audio.state === 'suspended') void audio.resume()
    const begin = audio.currentTime + 0.01

    for (const note of CUES[cue]) {
      const oscillator = audio.createOscillator()
      const gain = audio.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = note.frequency
      // A quick rise and a smooth fall, so the note neither clicks nor rings.
      const from = begin + note.at
      gain.gain.setValueAtTime(0.0001, from)
      gain.gain.exponentialRampToValueAtTime(VOLUME, from + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, from + note.duration)
      oscillator.connect(gain).connect(audio.destination)
      oscillator.start(from)
      oscillator.stop(from + note.duration + 0.02)
    }

    if (suspendTimer) clearTimeout(suspendTimer)
    suspendTimer = setTimeout(() => void audio.suspend(), SUSPEND_AFTER_MS)
  } catch {
    // A sound that cannot play is never a reason to disturb a dictation.
  }
}
