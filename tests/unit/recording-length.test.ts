import { describe, expect, it } from 'vitest'
import { encodeWav } from '../../src/shared/wav'
import { wavDurationMs } from '../../scripts/lib/wav.mjs'

const SECOND = new Float32Array(16_000)

/** The file with a chunk put in after the format, as `say` puts a 4 KB filler chunk there. */
function withChunk(wav: Uint8Array, id: string, size: number): Uint8Array {
  const chunk = new Uint8Array(8 + size + (size % 2))
  chunk.set([...id].map((letter) => letter.charCodeAt(0)))
  new DataView(chunk.buffer).setUint32(4, size, true)
  const bytes = new Uint8Array(wav.byteLength + chunk.byteLength)
  bytes.set(wav.subarray(0, 36))
  bytes.set(chunk, 36)
  bytes.set(wav.subarray(36), 36 + chunk.byteLength)
  new DataView(bytes.buffer).setUint32(4, bytes.byteLength - 8, true)
  return bytes
}

describe('how long a test recording plays', () => {
  it('reads one second of 16 kHz audio as 1,000 ms', () => {
    expect(wavDurationMs(encodeWav(SECOND, 16_000))).toBe(1_000)
  })

  it('does not count a filler chunk before the audio', () => {
    // The size less 44 bytes would make this 1,126 ms.
    expect(wavDurationMs(withChunk(encodeWav(SECOND, 16_000), 'FLLR', 4_044))).toBe(1_000)
  })

  it('steps over a chunk of odd size, which is padded to an even one', () => {
    expect(wavDurationMs(withChunk(encodeWav(SECOND, 16_000), 'LIST', 7))).toBe(1_000)
  })

  it('counts by the rate the file gives', () => {
    expect(wavDurationMs(encodeWav(SECOND, 8_000))).toBe(2_000)
  })

  it('refuses what is not a WAV file', () => {
    expect(() => wavDurationMs(new TextEncoder().encode('not a recording at all'))).toThrow(
      'not a WAV file',
    )
  })
})
