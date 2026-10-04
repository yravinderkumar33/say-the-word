// `?worker&url` makes Vite bundle and transpile the worklet and hand back its URL.
// A plain `?url` import would ship the raw TypeScript source.
import workletUrl from './pcm.worklet.ts?worker&url'

export function loadPcmWorklet(context: AudioContext): Promise<void> {
  return context.audioWorklet.addModule(workletUrl)
}
