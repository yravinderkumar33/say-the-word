import type { Settings, SettingsPatch, SettingsStore } from './settings'

/** What the pill says when a change could not be saved. Short: it has to fit the pill. */
export const NOT_SAVED_MESSAGE = 'That setting could not be saved'

export interface SettingsChangerDeps {
  settings: Pick<SettingsStore, 'get' | 'update'>
  /** Redraws whatever shows the settings (the menu), from the ones in force. */
  showCurrent(settings: Settings): void
  /** Tells the user that something they asked for did not happen. */
  tell(message: string): void
}

/**
 * Makes a change to the settings that the user asked for, from the menu.
 *
 * A change that cannot be saved (a full disk, a folder that cannot be written to) is
 * not made. The menu is redrawn from the settings still in force, because a menu item
 * ticks itself when it is clicked, and the user is told. Nothing is lost by it: the
 * same change can be asked for again.
 *
 * Returns true when the change was made.
 */
export function createSettingsChanger(
  deps: SettingsChangerDeps,
): (patch: SettingsPatch) => boolean {
  return (patch) => {
    let saved = true
    try {
      deps.settings.update(patch)
    } catch (error) {
      saved = false
      // Which entries, never their values: a dictionary word or a server address may be personal.
      console.error(
        `[settings] could not save a change to ${Object.keys(patch).join(', ')}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
    deps.showCurrent(deps.settings.get())
    if (!saved) deps.tell(NOT_SAVED_MESSAGE)
    return saved
  }
}
