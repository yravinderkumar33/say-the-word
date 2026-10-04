import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav } from '@shared/wav'

/** Builds a WAV file by hand, so decoding is tested against bytes this code did not write. */
function wavFile(options: {
  format: number
  channels: number
  sampleRate: number
  bitsPerSample: number
  data: Uint8Array
  extraChunk?: boolean
}): Uint8Array {
  const { format, channels, sampleRate, bitsPerSample, data } = options
  const extra = options.extraChunk ? 12 : 0
  const bytes = new Uint8Array(44 + extra + data.length)
  const view = new DataView(bytes.buffer)
  const tag = (offset: number, text: string): void => {
    for (let index = 0; index < 4; index++) bytes[offset + index] = text.charCodeAt(index)
  }
  tag(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  tag(8, 'WAVE')
  tag(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, (sampleRate * channels * bitsPerSample) / 8, true)
  view.setUint16(32, (channels * bitsPerSample) / 8, true)
  view.setUint16(34, bitsPerSample, true)
  let offset = 36
  if (options.extraChunk) {
    tag(offset, 'LIST')
    view.setUint32(offset + 4, 4, true)
    offset += 12
  }
  tag(offset, 'data')
  view.setUint32(offset + 4, data.length, true)
  bytes.set(data, offset + 8)
  return bytes
}

function pcm16(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setInt16(index * 2, value, true))
  return bytes
}

describe('decodeWav', () => {
  it('decodes 16-bit mono PCM to samples in [-1, 1]', () => {
    const audio = decodeWav(
      wavFile({
        format: 1,
        channels: 1,
        sampleRate: 16_000,
        bitsPerSample: 16,
        data: pcm16([0, 16_384, -32_768, 32_767]),
      }),
    )

    expect(audio.sampleRate).toBe(16_000)
    expect(Array.from(audio.samples)).toEqual([0, 0.5, -1, 32_767 / 32_768])
  })

  it('averages stereo down to mono', () => {
    const audio = decodeWav(
      wavFile({
        format: 1,
        channels: 2,
        sampleRate: 48_000,
        bitsPerSample: 16,
        data: pcm16([16_384, 0, -16_384, -16_384]),
      }),
    )

    expect(Array.from(audio.samples)).toEqual([0.25, -0.5])
  })

  it('decodes 32-bit float', () => {
    const data = new Uint8Array(new Float32Array([0.25, -0.75]).buffer)

    const audio = decodeWav(
      wavFile({ format: 3, channels: 1, sampleRate: 16_000, bitsPerSample: 32, data }),
    )

    expect(Array.from(audio.samples)).toEqual([0.25, -0.75])
  })

  it('skips chunks it does not need', () => {
    const audio = decodeWav(
      wavFile({
        format: 1,
        channels: 1,
        sampleRate: 16_000,
        bitsPerSample: 16,
        data: pcm16([8_192]),
        extraChunk: true,
      }),
    )

    expect(Array.from(audio.samples)).toEqual([0.25])
  })

  it('refuses encodings it does not understand', () => {
    const eightBit = wavFile({
      format: 1,
      channels: 1,
      sampleRate: 8_000,
      bitsPerSample: 8,
      data: new Uint8Array(4),
    })

    expect(() => decodeWav(eightBit)).toThrow(/Unsupported WAV encoding/)
  })

  it('refuses a file that is not WAV', () => {
    expect(() => decodeWav(new TextEncoder().encode('this is not audio at all'))).toThrow(
      'Not a WAV file',
    )
  })
})

describe('encodeWav', () => {
  it('round-trips through decodeWav within 16-bit precision', () => {
    const original = new Float32Array([0, 0.5, -0.5, 0.999, -1])

    const decoded = decodeWav(encodeWav(original, 16_000))

    expect(decoded.sampleRate).toBe(16_000)
    expect(decoded.samples).toHaveLength(original.length)
    decoded.samples.forEach((sample, index) => {
      expect(sample).toBeCloseTo(original[index]!, 3)
    })
  })

  it('clamps samples outside the valid range', () => {
    const decoded = decodeWav(encodeWav(new Float32Array([2, -3]), 16_000))

    expect(decoded.samples[0]).toBeCloseTo(1, 3)
    expect(decoded.samples[1]).toBeCloseTo(-1, 3)
  })
})
