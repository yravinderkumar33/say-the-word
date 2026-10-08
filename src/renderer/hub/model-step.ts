import type { AppStatus } from '@shared/ipc'

/** The one button that moves the speech model forward from where it is. */
export type ModelAction = 'download' | 'tryAgain' | 'cancel' | 'checkFiles'

/** What a screen reader calls a bar that shows how far the speech model's download has got. */
export const DOWNLOAD_NAME = 'Downloading the speech model'

export interface ModelStepView {
  /** True when the model is on disk and nothing is wrong with it. */
  done: boolean
  /** The files on disk are being read, to find out whether they can be vouched for. */
  checking: boolean
  /** Null when there is nothing to press: all is well, or something is under way. */
  action: ModelAction | null
  /** The model is on disk and could not be started: its files are the first thing to look at. */
  wouldNotStart: boolean
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
    return { done: false, checking: false, action: 'cancel', wouldNotStart: false }
  }
  if (speech.modelDownloaded) {
    return {
      // Shown as missing only while the files are on disk and the app is about to take them in.
      done: speech.state !== 'modelMissing' && !wouldNotStart,
      checking: false,
      action: wouldNotStart ? 'checkFiles' : null,
      wouldNotStart,
    }
  }
  // Not vouched for. While the files on disk are being read, there is nothing to press.
  if (speech.state === 'loading') {
    return { done: false, checking: true, action: null, wouldNotStart: false }
  }
  return {
    done: false,
    checking: false,
    action: speech.downloadError ? 'tryAgain' : 'download',
    wouldNotStart: false,
  }
}
