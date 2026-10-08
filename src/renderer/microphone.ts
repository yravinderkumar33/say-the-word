/**
 * The microphone as a dictation hears it, for both pages that open one: the overlay,
 * which records, and the Settings page's meter, which shows what a recording would hear.
 * It is kept apart from the capture code so that the main window does not bundle that.
 */

/**
 * The raw signal, of one channel. Processing meant for calls smears speech, and the
 * recognizer wants the signal as it is.
 */
export function rawMicrophoneConstraints(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  }
}

/** Loudness from 0 to 1: root mean square, scaled so that ordinary speech fills most of the range. */
export function meterLevel(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.min(1, Math.sqrt(sum / Math.max(1, samples.length)) * 6)
}
