/** A stretch of audio, as sample positions: `start` inclusive, `end` exclusive. */
export interface SampleRange {
  start: number
  end: number
}

export interface PlannerOptions {
  /** The longest stretch to hand to the recognizer in one go. */
  maxChunkSamples: number
  /** Audio kept before the first word of a chunk, so its onset is not clipped. */
  padBefore: number
  /** Audio kept after the last word of a chunk. */
  padAfter: number
}

/**
 * Decides which stretches of a recording to decode, and when.
 *
 * The voice detector reports each stretch of speech as it ends. Neighbouring stretches
 * are grouped into one chunk, because the recognizer punctuates better with a whole
 * thought in front of it. A chunk is closed, and can be decoded while the recording
 * continues, as soon as the next stretch would make it longer than the recognizer
 * should take at once. A short dictation is therefore one chunk, decoded at the end;
 * a long one is decoded piece by piece, so only its tail is left when it stops.
 *
 * Pure bookkeeping: no audio and no recognizer, so it is unit-tested with numbers.
 */
export class ChunkPlanner {
  private group: SampleRange | null = null
  private decodedUpTo = 0
  private speechSeen = false

  constructor(private readonly options: PlannerOptions) {}

  /** True once any speech has been reported. */
  get hadSpeech(): boolean {
    return this.speechSeen
  }

  /** A stretch of speech has ended. Returns the chunks that are now ready to decode. */
  addSpeech(speech: SampleRange): SampleRange[] {
    this.speechSeen = true
    const ready: SampleRange[] = []
    if (this.group && speech.end - this.group.start > this.options.maxChunkSamples) {
      ready.push(this.close(this.group, speech.start))
      this.group = null
    }
    if (this.group) this.group.end = speech.end
    else this.group = { ...speech }
    return ready
  }

  /** The recording is over. Returns whatever is left to decode. */
  finish(totalSamples: number): SampleRange[] {
    if (!this.group) return []
    const last = this.close(this.group, totalSamples)
    this.group = null
    return [last]
  }

  /**
   * Turns a group of speech into a chunk of audio: padded a little on both sides,
   * never reaching back into audio already decoded, never past `limit`.
   */
  private close(group: SampleRange, limit: number): SampleRange {
    const chunk = {
      start: Math.max(this.decodedUpTo, group.start - this.options.padBefore),
      end: Math.min(limit, group.end + this.options.padAfter),
    }
    this.decodedUpTo = chunk.end
    return chunk
  }
}

/**
 * Splits audio that is longer than the recognizer should take at once. Each cut is
 * made at the quietest moment in the last stretch before the limit, so that it falls
 * between words where possible. Returns ranges that together cover all of `samples`.
 */
export function splitAtQuietPoints(
  samples: Float32Array,
  maxSamples: number,
  options: { frame: number; searchBack: number },
): SampleRange[] {
  const pieces: SampleRange[] = []
  let offset = 0
  while (samples.length - offset > maxSamples) {
    const limit = offset + maxSamples
    const searchFrom = Math.max(offset + Math.floor(maxSamples / 2), limit - options.searchBack)
    let quietest = searchFrom
    let lowest = Infinity
    for (let start = searchFrom; start + options.frame <= limit; start += options.frame) {
      let energy = 0
      for (let index = start; index < start + options.frame; index++) {
        const sample = samples[index] ?? 0
        energy += sample * sample
      }
      if (energy < lowest) {
        lowest = energy
        quietest = start
      }
    }
    const cut = quietest + Math.floor(options.frame / 2)
    pieces.push({ start: offset, end: cut })
    offset = cut
  }
  pieces.push({ start: offset, end: samples.length })
  return pieces
}
