import { app } from 'electron'

/**
 * Whether macOS opens the app when the user logs in.
 *
 * The system keeps this, not the settings file: it can be changed in System Settings
 * as well, and what is shown here is what the system says.
 */
export interface LoginItem {
  /** Null where it cannot be set at all. */
  get(): boolean | null
  set(on: boolean): void
  /** True when this launch was the system's doing, at login: no window is opened then. */
  openedAtLogin(): boolean
}

/** The real thing, for the app as it is installed. */
export const systemLoginItem: LoginItem = {
  get: () => app.getLoginItemSettings().openAtLogin,
  set: (on) => app.setLoginItemSettings({ openAtLogin: on }),
  openedAtLogin: () => app.getLoginItemSettings().wasOpenedAtLogin,
}

/**
 * For a run from the source tree, where "the app" is the bare Electron binary: adding
 * that to the login items would open an empty Electron at every login.
 */
export const noLoginItem: LoginItem = {
  get: () => null,
  set: () => {},
  openedAtLogin: () => false,
}

/** For the automated tests: remembers what was asked, and tells the system nothing. */
export function pretendLoginItem(): LoginItem {
  let on = false
  return {
    get: () => on,
    set: (next) => {
      on = next
    },
    openedAtLogin: () => false,
  }
}
