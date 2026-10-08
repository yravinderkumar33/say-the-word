// How long a test recording plays, read from the file's chunks. The size of the file less
// a 44-byte header is not it: the recordings `say` writes carry a 4 KB filler chunk before
// the audio, which made every one 127 ms longer than it plays.
import { readFileSync } from 'node:fs'

/** Milliseconds of audio in the bytes of a WAV file. Throws on anything else. */
export function wavDurationMs(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (bytes.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new Error('not a WAV file')
  }
  let bytesPerSecond = 0
  for (let offset = 12; offset + 8 <= bytes.byteLength;) {
    const size = view.getUint32(offset + 4, true)
    if (tag(offset) === 'fmt ') bytesPerSecond = view.getUint32(offset + 16, true)
    if (tag(offset) === 'data' && bytesPerSecond > 0) {
      return (Math.min(size, bytes.byteLength - offset - 8) / bytesPerSecond) * 1_000
    }
    offset += 8 + size + (size % 2)
  }
  throw new Error('the WAV file has no audio after its format')
}

/** `wavDurationMs` of the file at `path`. */
export const wavFileDurationMs = (path) => wavDurationMs(readFileSync(path))
