import { FRAME_SAMPLES, PCM_PROCESSOR_NAME } from '@shared/audio-format'

/**
 * Runs on the audio thread. Collects the microphone's mono samples into fixed
 * frames of FRAME_SAMPLES and posts each full frame to the page.
 *
 * Messages to the page:
 * - the string `started`, once, when the first audio arrives from the microphone;
 * - a Float32Array for every full frame;
 * - after the page sends `flush` (recording stopped): whatever is held, as a final
 *   shorter frame, followed by the string `flushed`.
 *
 * When the page sends `close` the processor is finished: `process` returns false from
 * then on, which is what lets the audio thread stop running it and free it.
 */
class PcmProcessor extends AudioWorkletProcessor {
  private frame = new Float32Array(FRAME_SAMPLES)
  private filled = 0
  private started = false
  private closed = false

  constructor() {
    super()
    this.port.onmessage = (event: MessageEvent) => {
      if (event.data === 'close') {
        this.closed = true
        return
      }
      if (event.data !== 'flush') return
      if (this.filled > 0) this.port.postMessage(this.frame.slice(0, this.filled))
      this.filled = 0
      this.port.postMessage('flushed')
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.closed) return false
    const samples = inputs[0]?.[0]
    if (!samples) return true
    if (!this.started) {
      this.started = true
      this.port.postMessage('started')
    }

    let offset = 0
    while (offset < samples.length) {
      const count = Math.min(samples.length - offset, FRAME_SAMPLES - this.filled)
      this.frame.set(samples.subarray(offset, offset + count), this.filled)
      this.filled += count
      offset += count
      if (this.filled === FRAME_SAMPLES) {
        this.port.postMessage(this.frame.slice())
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor(PCM_PROCESSOR_NAME, PcmProcessor)
