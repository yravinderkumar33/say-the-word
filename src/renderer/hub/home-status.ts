import type { AppStatus, DictationMode, Usage } from '@shared/ipc'
import { dictationKeyLabel, dictationKeySpoken, type DictationKey } from '@shared/keycodes'
import { microphoneName } from '@shared/microphone-name'
import { PRODUCT_NAME } from '@shared/product'
import { bytes, timeOfDay, wholeNumber } from './format'
import { modelStep, type ModelAction } from './model-step'

/** The one button under the status line, by what it does. */
export type HomeAction = 'accessibility' | 'microphone' | 'resume' | 'otherKey' | ModelAction

/** Said at the top of every page while the status cannot be read. It is asked for again by itself. */
export const STATUS_UNREAD = 'The status could not be read. It is asked for again by itself.'

/**
 * What the top of Home says: that dictation is ready, or the one thing that stands in
 * its way, with the one button that moves it forward.
 */
export interface HomeStatus {
  ready: boolean
  /** The status line. Empty when ready: the page then draws its own, with the key in it. */
  title: string
  /**
   * What a screen reader is told when the line changes, with the key in words. The figure
   * of a download is left out: it changes at every look, and would be read out each time.
   */
  spoken: string
  detail: string | null
  /** Said under the detail when something went wrong on the way. */
  problem: string | null
  action: { does: HomeAction; label: string } | null
  /** How far a download has got, from 0 to 1, when one is what the line is about. */
  progress: number | null
  /** True for something the user has to do, as against something that is under way. */
  needsUser: boolean
}

const READY: HomeStatus = {
  ready: true,
  title: '',
  spoken: '',
  detail: null,
  problem: null,
  action: null,
  progress: null,
  needsUser: false,
}

const waiting = (title: string, spoken = title): HomeStatus => ({
  ...READY,
  ready: false,
  title,
  spoken,
})

/** In development macOS attributes permissions to the terminal that started the app. */
const DEVELOPMENT_NOTE =
  ' Development build: macOS asks on behalf of the terminal that started the app.'

/**
 * Kept apart from the window so that its rule can be tested: there is always exactly
 * one thing on show, and when it is something to do, there is a button that does it.
 *
 * The order is the order to do things in. The download comes first because it takes
 * the longest and needs one click; it then runs while the permissions are seen to.
 */
export function homeStatus(status: AppStatus, key: string): HomeStatus {
  const { helper, speech } = status
  const spokenKey = dictationKeySpoken(status.dictationKey)
  const model = modelStep(speech)
  const downloading = model.action === 'cancel'
  const percent = Math.floor((speech.downloadProgress ?? 0) * 100)
  // Said beside a permission while the model arrives, so that it is not forgotten.
  const meanwhile = downloading ? ` The speech model is downloading meanwhile: ${percent}%.` : ''
  const development = status.packaged ? '' : DEVELOPMENT_NOTE

  if (!helper.running) {
    return {
      ...waiting('The shortcut helper is not running'),
      detail: `It is the part that notices the ${key} key and pastes. It is started again by itself.`,
      needsUser: true,
    }
  }

  if (model.action === 'download' || model.action === 'tryAgain') {
    const title = 'The speech model is not downloaded'
    const problem = speech.downloadError
      ? `The download stopped: ${speech.downloadError}. What was downloaded is kept.`
      : null
    return {
      ...waiting(title, problem ? `${title}. ${problem}` : title),
      detail:
        `${speech.modelLabel} turns speech into text. It is downloaded once; after that, ` +
        'dictation works without a network connection.',
      problem,
      action:
        model.action === 'tryAgain'
          ? { does: 'tryAgain', label: 'Try again' }
          : { does: 'download', label: `Download (${bytes(speech.modelBytes)})` },
      needsUser: true,
    }
  }

  if (model.wouldNotStart) {
    return {
      ...waiting('Speech recognition could not start'),
      detail:
        'The model is on this Mac but could not be started. Checking its files finds any ' +
        'that are damaged and downloads those again.',
      action: { does: 'checkFiles', label: 'Check the model files' },
      needsUser: true,
    }
  }

  if (helper.accessibilityTrusted !== true) {
    return {
      ...waiting('Waiting for the Accessibility permission'),
      detail:
        `Lets ${PRODUCT_NAME} notice the ${key} key and paste into the app you are using. ` +
        `It sees shortcut keys only, never what you type.${meanwhile}${development}`,
      action: { does: 'accessibility', label: 'Open System Settings' },
      needsUser: true,
    }
  }

  if (status.microphone !== 'granted') {
    const refused = status.microphone === 'denied' || status.microphone === 'restricted'
    return {
      ...waiting(refused ? 'The microphone is switched off' : 'The microphone is not allowed yet'),
      detail:
        'On only while you dictate: while you hold the key, or from the start of a ' +
        'hands-free dictation until you stop it. Audio is turned into text on this Mac and ' +
        'is not kept afterwards, unless you switch on “Save every dictation” in the ' +
        `menu-bar menu.${meanwhile}${development}`,
      action: {
        does: 'microphone',
        label: refused ? 'Open System Settings' : 'Allow the microphone',
      },
      needsUser: true,
    }
  }

  if (downloading) {
    return {
      ...waiting(`Downloading the speech model, ${percent}%`, 'Downloading the speech model'),
      detail: 'Dictation is ready as soon as it has arrived.',
      action: { does: 'cancel', label: 'Cancel' },
      progress: speech.downloadProgress ?? 0,
    }
  }

  // On disk, and being read or taken in: nothing to press, and not for long.
  if (!model.done) {
    return waiting(model.checking ? 'Checking the model files…' : 'Loading the speech model…')
  }

  if (helper.tapInstalled !== true) return waiting('Starting the shortcuts…')

  if (status.pausedUntil !== null) {
    return {
      ...waiting(`Paused until ${timeOfDay(status.pausedUntil)}`),
      detail: 'Every shortcut is off until then, so the keys are free for something else.',
      action: { does: 'resume', label: 'Resume Dictation' },
    }
  }

  if (status.conflict) {
    const other = dictationKeyLabel('ctrlOption')
    return {
      ...waiting(
        `${status.conflict} is also listening to ${key}`,
        `${status.conflict} is also listening to ${spokenKey}`,
      ),
      detail:
        `Two apps on one key both start at once. Quit ${status.conflict}, or use ${other} ` +
        'here: both then keep working.',
      action: { does: 'otherKey', label: `Use ${other} Instead` },
      needsUser: true,
    }
  }

  return { ...READY, spoken: `Ready. Hold ${spokenKey} to dictate.` }
}

/** The gestures Home lists: fewer than Settings, the ones used every day. */
export function gestures(key: DictationKey): Array<{ keys: string[]; does: string }> {
  const cap = dictationKeyLabel(key)
  return [
    { keys: [cap], does: 'Hold to dictate' },
    key === 'fn'
      ? { keys: [cap, cap], does: 'Press twice for hands-free' }
      : { keys: [cap, 'Space'], does: 'Lock on for hands-free' },
    { keys: ['esc'], does: 'Cancel' },
    { keys: ['⌘', '⌃', 'V'], does: 'Paste the last dictation' },
  ]
}

/** What is said beside the microphone: that it is on only while dictating, or that the first choice is away. */
export function microphoneCaption(
  status: Pick<AppStatus, 'microphones' | 'microphoneOrder'>,
): string {
  // The first choice is not connected, so the next one down, or the system's, is used.
  const first = status.microphoneOrder[0]
  const away =
    first !== undefined &&
    status.microphones.length > 0 &&
    !status.microphones.some((microphone) => microphone.deviceId === first.deviceId)
  if (!away) return 'On only while you dictate.'
  return `${first.label ? microphoneName(first.label) : 'Your first choice'} is not connected.`
}

/** What a mode does, in a sentence. In Cleaned mode, why only the rules are used, when that is so. */
export function modeCaption(mode: DictationMode, cleanup: string): string {
  if (mode === 'verbatim') return 'Every word, with the recognizer’s punctuation.'
  // The menu's line: "Cleaned: rules only (Ollama is not running)".
  const rulesOnly = /^Cleaned: rules only \((.+)\)$/.exec(cleanup)
  if (rulesOnly?.[1]) return `Rules only: ${rulesOnly[1]}.`
  return 'The same words, tidied by a model on this Mac.'
}

/** One figure of the line under the list: the number, and the words around it. */
export interface Figure {
  before: string
  number: string
  after: string
  /** What follows the number where there is little room. */
  afterShort: string
}

/** The figures line. The usual time is left out until there is one to give. */
export function figures(usage: Usage): Figure[] {
  const words = (total: number): string => (total === 1 ? ' word' : ' words')
  const today = `${words(usage.wordsToday)} today`
  const list: Figure[] = [
    { before: '', number: wholeNumber(usage.wordsToday), after: today, afterShort: today },
    {
      before: '',
      number: wholeNumber(usage.wordsThisWeek),
      after: ' this week',
      afterShort: ' this week',
    },
  ]
  if (usage.typicalMs !== null) {
    list.push({
      before: 'usually ',
      number: `${(usage.typicalMs / 1_000).toFixed(1)} s`,
      after: ' from release to text',
      afterShort: '',
    })
  }
  return list
}
