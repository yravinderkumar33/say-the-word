import type { AppStatus } from '@shared/ipc'

/** The one button that moves the speech model forward from where it is. */
export type ModelAction = 'download' | 'tryAgain' | 'cancel' | 'checkFiles'

export interface ModelStepView {
  /** True when the model is on disk and nothing is wrong with it. */
  done: boolean
  /** A few words on where the model is. */
  state: string
  /** Null when there is nothing to press: all is well, or something is under way. */
  action: ModelAction | null
  /** The model is on disk and could not be started: its files are the first thing to look at. */
  wouldNotStart: boolean
}

const SPEECH_STATE: Record<AppStatus['speech']['state'], string> = {
  ready: 'Downloaded and loaded',
  // The model is unloaded after a while without dictation and loaded again when needed.
  stopped: 'Downloaded',
  loading: 'Loading…',
  // Shown only while the files are on disk and the app is about to take them in.
  modelMissing: 'Downloaded, loading…',
  failed: 'Could not start',
}

/**
 * What the setup window shows for the speech model. Kept apart from the window so that
 * the rule "there is always a way forward" can be tested: a download can be cancelled,
 * a download that stopped can be tried again, and a model that is on disk but will not
 * start can have its files checked.
 */
export function modelStep(speech: AppStatus['speech']): ModelStepView {
  const downloading = speech.downloadProgress !== null
  const wouldNotStart = !downloading && speech.modelDownloaded && speech.state === 'failed'

  if (downloading) {
    return {
      done: false,
      state: `Downloading, ${Math.floor((speech.downloadProgress ?? 0) * 100)}%`,
      action: 'cancel',
      wouldNotStart: false,
    }
  }
  if (speech.modelDownloaded) {
    return {
      done: speech.state !== 'modelMissing' && !wouldNotStart,
      state: SPEECH_STATE[speech.state],
      action: wouldNotStart ? 'checkFiles' : null,
      wouldNotStart,
    }
  }
  // Not vouched for. While the files on disk are being read, there is nothing to press.
  if (speech.state === 'loading') {
    return { done: false, state: 'Checking the files…', action: null, wouldNotStart: false }
  }
  return {
    done: false,
    state: 'Not downloaded',
    action: speech.downloadError ? 'tryAgain' : 'download',
    wouldNotStart: false,
  }
}
