/**
 * The audio of one recording, kept as the frames it arrived in. Slicing copies only
 * the samples asked for, so a long recording is never duplicated as one huge array.
 */
export class SampleBuffer {
  private readonly frames: Float32Array[] = []
  /** Position of each frame's first sample. */
  private readonly starts: number[] = []
  private total = 0

  get length(): number {
    return this.total
  }

  append(frame: Float32Array): void {
    this.frames.push(frame)
    this.starts.push(this.total)
    this.total += frame.length
  }

  /** Copies samples `start` (inclusive) to `end` (exclusive), clamped to what exists. */
  slice(start: number, end: number): Float32Array {
    const from = Math.max(0, Math.min(start, this.total))
    const to = Math.max(from, Math.min(end, this.total))
    const out = new Float32Array(to - from)
    let written = 0
    for (let index = this.firstFrameAt(from); index < this.frames.length; index++) {
      const frame = this.frames[index]
      const frameStart = this.starts[index]
      if (!frame || frameStart === undefined || frameStart >= to) break
      const begin = Math.max(0, from - frameStart)
      const finish = Math.min(frame.length, to - frameStart)
      out.set(frame.subarray(begin, finish), written)
      written += finish - begin
    }
    return out
  }

  /** Index of the frame that contains sample `position`, by binary search. */
  private firstFrameAt(position: number): number {
    let low = 0
    let high = this.starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if ((this.starts[middle] ?? 0) <= position) low = middle
      else high = middle - 1
    }
    return low
  }
}
