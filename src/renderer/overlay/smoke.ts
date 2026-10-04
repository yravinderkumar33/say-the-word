import { FRAME_SAMPLES, PCM_PROCESSOR_NAME, SAMPLE_RATE } from '@shared/audio-format'
import type { OverlaySmokeReport, SmokeRequest } from '@shared/ipc'
import type { AudioMessage } from '@shared/stt-protocol'
import { loadPcmWorklet } from './capture/load-worklet'
import { sttPort } from './stt-port'

/**
 * The renderer half of `--smoke`: load the capture worklet, send one silent frame to
 * the speech worker and, when the main process supplies a recording, send that as a
 * session, in the same frames the microphone would produce.
 */
export function registerSmoke(): void {
  window.flow.onSmokeRun((request) => {
    void runSmoke(request).then((report) => window.flow.reportSmoke(report))
  })
}

async function runSmoke(request: SmokeRequest): Promise<OverlaySmokeReport> {
  const report: OverlaySmokeReport = {
    pageProtocol: window.location.protocol,
    workletLoaded: false,
    probePosted: false,
    framesPosted: 0,
  }
  try {
    const context = new AudioContext({ sampleRate: SAMPLE_RATE })
    await loadPcmWorklet(context)
    // Constructing the node throws if the processor never registered.
    new AudioWorkletNode(context, PCM_PROCESSOR_NAME)
    report.workletLoaded = true
    await context.close()

    const port = await sttPort(5_000)
    const post = (message: AudioMessage): void => port.postMessage(message)
    post({ t: 'probe', pcm: new Float32Array(FRAME_SAMPLES) })
    report.probePosted = true

    if (request.audio) {
      const { session, samples } = request.audio
      let seq = 0
      for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
        post({ t: 'pcm', session, seq, pcm: samples.slice(offset, offset + FRAME_SAMPLES) })
        seq += 1
      }
      post({ t: 'end', session, frames: seq })
      report.framesPosted = seq
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  }
  return report
}
