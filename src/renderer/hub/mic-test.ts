import { useCallback, useEffect, useRef, useState } from 'react'
import { meterLevel, rawMicrophoneConstraints } from '../microphone'

/** The Settings page's test lasts this long, then lets the microphone go by itself. */
export const TEST_MS = 10_000
/** A level above this is somebody speaking, not a quiet room. */
const HEARD_LEVEL = 0.12
/** How often the meter is redrawn: often enough to follow a voice, seldom enough to be cheap. */
const DRAW_EVERY_MS = 60
/** Above this the microphone is hearing something, if only a room. */
const SOUND_LEVEL = 0.04
/** How often the words beside the meter may change: a screen reader says them each time they do. */
const WORDS_EVERY_MS = 1_000

export interface MicTest {
  /** What is being tested: a device id, `''` for the system default, or null while nothing is. */
  testing: string | null
  /** Loudness now, from 0 to 1. */
  level: number
  /** True once a voice has been heard in this test. */
  heard: boolean
  /**
   * What the caller named the test in hand when it started it. "Heard" counts for that
   * test only: the one before may have heard a voice, and its answer arrives a moment
   * after the next one has started.
   */
  label: string
  /**
   * Whether there was any sound in the last second. It changes once a second at most,
   * so that the words drawn from it ("Hearing you", "Silent") can be read out.
   */
  sound: boolean
  /** Whole seconds left of a test that ends by itself; null for one that runs until stopped. */
  secondsLeft: number | null
  /** Why the microphone could not be opened, when it could not. */
  problem: string | null
  /** The microphone that could not be opened (`''` for the system default), until another test starts. */
  failed: string | null
  start(deviceId: string | null, forMs: number | null, label?: string): void
  stop(): void
}

/**
 * A level meter for a microphone, for as long as someone has asked to see one.
 *
 * The microphone is opened when a test is started and let go when it ends: when it is
 * stopped, when its time is up, and when the page that showed it goes away. No meter
 * runs merely because a page is open, which is what keeps "On only while you dictate"
 * true everywhere else. The audio is measured and nothing more: it is not kept, and
 * it goes nowhere.
 */
export function useMicTest(): MicTest {
  const [testing, setTesting] = useState<string | null>(null)
  const [level, setLevel] = useState(0)
  const [heard, setHeard] = useState(false)
  const [label, setLabel] = useState('')
  const [sound, setSound] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  /** Lets go of everything the test in hand holds. */
  const release = useRef<(() => void) | null>(null)

  const stop = useCallback((): void => {
    release.current?.()
    release.current = null
    setTesting(null)
    setLevel(0)
    setSound(false)
    setSecondsLeft(null)
  }, [])

  const start = useCallback(
    (deviceId: string | null, forMs: number | null, named = ''): void => {
      stop()
      setHeard(false)
      setLabel(named)
      setProblem(null)
      setFailed(null)
      setTesting(deviceId ?? '')
      setSecondsLeft(forMs === null ? null : Math.ceil(forMs / 1_000))

      let over = false
      let stream: MediaStream | null = null
      let context: AudioContext | null = null
      let draw: ReturnType<typeof setInterval> | null = null
      let end: ReturnType<typeof setTimeout> | null = null
      release.current = () => {
        over = true
        if (draw) clearInterval(draw)
        if (end) clearTimeout(end)
        for (const track of stream?.getTracks() ?? []) track.stop()
        void context?.close()
      }

      navigator.mediaDevices
        // As for a dictation: the raw signal, not one that has been levelled for a call.
        .getUserMedia(rawMicrophoneConstraints(deviceId))
        .then((opened) => {
          // Stopped, or replaced by another test, while the microphone was opening.
          if (over) {
            for (const track of opened.getTracks()) track.stop()
            return
          }
          stream = opened
          context = new AudioContext()
          const analyser = context.createAnalyser()
          analyser.fftSize = 1_024
          context.createMediaStreamSource(opened).connect(analyser)
          const samples = new Float32Array(analyser.fftSize)
          const startedAt = performance.now()
          let loudest = 0
          let saidAt = startedAt
          draw = setInterval(() => {
            analyser.getFloatTimeDomainData(samples)
            // Scaled as the pill's bars are: ordinary speech fills most of the range.
            const loudness = meterLevel(samples)
            setLevel(loudness)
            if (loudness >= HEARD_LEVEL) setHeard(true)
            loudest = Math.max(loudest, loudness)
            if (performance.now() - saidAt >= WORDS_EVERY_MS) {
              setSound(loudest >= SOUND_LEVEL)
              loudest = 0
              saidAt = performance.now()
            }
            if (forMs !== null) {
              setSecondsLeft(
                Math.max(0, Math.ceil((forMs - (performance.now() - startedAt)) / 1_000)),
              )
            }
          }, DRAW_EVERY_MS)
          if (forMs !== null) end = setTimeout(stop, forMs)
        })
        .catch((error: unknown) => {
          if (over) return
          stop()
          setProblem(describe(error))
          setFailed(deviceId ?? '')
        })
    },
    [stop],
  )

  // The page has gone: so has its claim on the microphone.
  useEffect(() => () => release.current?.(), [])

  return { testing, level, heard, label, sound, secondsLeft, problem, failed, start, stop }
}

function describe(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError') return 'The microphone is not allowed'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'It is not connected'
  if (name === 'NotReadableError') return 'It is in use or could not be opened'
  return 'It could not be opened'
}
