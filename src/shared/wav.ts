/** Mono audio as floating-point samples in [-1, 1]. */
export interface WavAudio {
  sampleRate: number
  samples: Float32Array
}

const PCM = 1
const IEEE_FLOAT = 3
const EXTENSIBLE = 0xfffe

/**
 * Decodes a WAV file (16-bit PCM or 32-bit float) to mono. Other channels are
 * averaged in. Throws on anything it does not understand rather than guessing.
 */
export function decodeWav(bytes: Uint8Array): WavAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('Not a WAV file')
  }

  let format = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let data: { offset: number; length: number } | null = null

  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in the first two bytes of a GUID.
      if (format === EXTENSIBLE && size >= 26) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      data = { offset: body, length: Math.min(size, bytes.byteLength - body) }
    }
    offset = body + size + (size % 2)
  }

  if (!data || channels === 0) throw new Error('WAV file has no audio data')
  const isPcm16 = format === PCM && bitsPerSample === 16
  const isFloat32 = format === IEEE_FLOAT && bitsPerSample === 32
  if (!isPcm16 && !isFloat32) {
    throw new Error(`Unsupported WAV encoding (format ${format}, ${bitsPerSample} bits)`)
  }

  const bytesPerSample = bitsPerSample / 8
  const frames = Math.floor(data.length / (bytesPerSample * channels))
  const samples = new Float32Array(frames)
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) {
      const at = data.offset + (frame * channels + channel) * bytesPerSample
      sum += isPcm16 ? view.getInt16(at, true) / 32_768 : view.getFloat32(at, true)
    }
    samples[frame] = sum / channels
  }
  return { sampleRate, samples }
}

/** Encodes mono samples as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(bytes.buffer)
  const writeTag = (offset: number, text: string): void => {
    for (let index = 0; index < 4; index++) bytes[offset + index] = text.charCodeAt(index)
  }
  writeTag(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeTag(8, 'WAVE')
  writeTag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, PCM, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeTag(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index++) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0))
    view.setInt16(44 + index * 2, Math.round(clamped * 32_767), true)
  }
  return bytes
}
