import type { AppStatus, SpeechState } from '@shared/ipc'

/** What the menu-bar icon's status is worked out from: all of it known at once, without asking anyone. */
export interface TrayFacts {
  helperRunning: boolean
  /** The key tap is in place, which it can be only with the Accessibility permission. */
  shortcutsOn: boolean
  speech: { state: SpeechState; downloadProgress: number | null }
  microphone: AppStatus['microphone']
  /** The dictation key, as a keycap names it. */
  key: string
}

export interface TrayStatus {
  /** The menu's status line, which is also the icon's tooltip and what VoiceOver says. */
  line: string
  /** Something stands in the way of dictating that only the user can clear. */
  attention: boolean
}

/**
 * Kept in the order Home's status line uses (`src/renderer/hub/home-status.ts`): the
 * helper, then the speech model, then the two permissions, then what is under way. The
 * two must not disagree: on a first launch Home said that the model was not downloaded
 * while the menu said it was waiting for Accessibility. A pause is said by the menu
 * itself, over all of this.
 */
export function trayStatus(facts: TrayFacts): TrayStatus {
  const { speech, microphone } = facts
  const downloading = speech.downloadProgress !== null
  const needsUser = (line: string): TrayStatus => ({ line, attention: true })
  const meanwhile = (line: string): TrayStatus => ({ line, attention: false })

  if (!facts.helperRunning) return needsUser('The shortcut helper is not running')
  if (!downloading && speech.state === 'modelMissing') {
    return needsUser('The speech model is not downloaded')
  }
  if (!downloading && speech.state === 'failed') {
    return needsUser('Speech recognition could not start')
  }
  if (!facts.shortcutsOn) return needsUser('Waiting for the Accessibility permission')
  if (microphone !== 'granted') {
    const refused = microphone === 'denied' || microphone === 'restricted'
    return needsUser(
      refused ? 'The microphone is switched off' : 'The microphone is not allowed yet',
    )
  }
  if (downloading) {
    const percent = Math.floor((speech.downloadProgress ?? 0) * 100)
    return meanwhile(`Downloading the speech model, ${percent}%`)
  }
  if (speech.state === 'loading') return meanwhile('Loading the speech model…')
  // The model is loaded again on the next dictation, so `stopped` is still ready.
  return meanwhile(`Ready. Hold ${facts.key} to dictate`)
}
