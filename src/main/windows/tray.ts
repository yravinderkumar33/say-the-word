import { Menu, Tray, app, type MenuItemConstructorOptions } from 'electron'
import { trayIconState, type TrayIconState } from '@shared/icon-shapes'
import type { HistoryRow, Microphone } from '@shared/ipc'
import { microphoneName, shortenInTheMiddle } from '@shared/microphone-name'
import { clockTime } from '../dictation/pause'
import { trayImage } from './tray-icon'

export interface TrayModel {
  /** One line describing what the app is doing or waiting for. */
  status: string
  /** The microphones the system offers now. */
  microphones: Microphone[]
  /** The order of preference, with the names they had: one that is not connected is listed as such. */
  microphoneOrder: Microphone[]
  /** The one a dictation would use, by device id, or null for the system default. */
  microphoneId: string | null
  /** Evaluation mode: every dictation's recording and text are being saved. */
  evaluationRecording: boolean
  mode: 'verbatim' | 'cleaned'
  /** What Cleaned mode will do right now; empty in Verbatim mode. */
  cleanup: string
  /** The local models Cleaned mode could use, and the one it does. */
  cleanupModels: string[]
  cleanupModel: string | null
  /** What the pill is offering to do about the last dictation, if anything. */
  offer: 'Undo' | 'Retry' | null
  /** A hands-free recording is running: no key is held, so the menu can stop it too. */
  handsFree: boolean
  canCancel: boolean
  /** There is a "Buy me a coffee" page to open. */
  support: boolean
  /** The newest dictations of the history, newest first. Choosing one copies it. */
  recent: HistoryRow[]
  /** Dictation is paused until then (milliseconds since the epoch); null when it is not. */
  pausedUntil: number | null
  /** The microphone is live. */
  live: boolean
  /** Something stands in the way of dictating, and needs the user. */
  attention: boolean
}

export interface TrayActions {
  /** The pointer has reached the icon: the menu is about to be opened. */
  approached(): void
  chooseMicrophone(deviceId: string | null): void
  setMode(mode: 'verbatim' | 'cleaned'): void
  setEvaluationRecording(on: boolean): void
  showEvaluationFolder(): void
  showLog(): void
  openHub(): void
  /** Undo a cancel, or try a failed dictation again: what the pill's button of that name does. */
  redo(): void
  pasteLast(): void
  copyLast(): void
  /** Stop, or cancel, the hands-free recording that is running. */
  stop(): void
  cancel(): void
  openSupportPage(): void
  /** Copies one of the recent dictations, by its id. */
  copyRecent(id: string): void
  pause(): void
  resume(): void
}

/** How much of a dictation fits in the Recent menu. */
const RECENT_CHARS = 48
/** How many dictations the Recent menu lists. */
export const RECENT_IN_MENU = 5

/** A shortcut named beside a menu item, for as long as the shortcut works. The menu itself never listens for it. */
function shortcutShown(
  accelerator: string,
  works: boolean,
): Pick<MenuItemConstructorOptions, 'accelerator' | 'registerAccelerator'> {
  return works ? { accelerator, registerAccelerator: false } : {}
}

/** The menu-bar item: status, the last dictations, mode, microphone, and the way to open the window or quit. */
export class AppTray {
  private readonly tray: Tray
  private shown: TrayIconState = 'ready'
  /** The labels of the menu as it was last built, for the tests' control line. */
  private labels: string[] = []
  private model: TrayModel = {
    status: 'Starting…',
    microphones: [],
    microphoneOrder: [],
    microphoneId: null,
    evaluationRecording: false,
    mode: 'verbatim',
    cleanup: '',
    cleanupModels: [],
    cleanupModel: null,
    offer: null,
    handsFree: false,
    canCancel: false,
    support: false,
    recent: [],
    pausedUntil: null,
    live: false,
    attention: false,
  }

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(trayImage(this.shown))
    this.tray.setToolTip(app.getName())
    // The menu is drawn ahead of time and cannot be changed once it is open, so what it
    // says is brought up to date as the pointer arrives, a moment before the click.
    this.tray.on('mouse-enter', () => this.actions.approached())
    this.render()
  }

  update(patch: Partial<TrayModel>): void {
    this.model = { ...this.model, ...patch }
    this.render()
  }

  /** What the menu currently says, for tests. */
  get state(): TrayModel {
    return this.model
  }

  /** What the menu offers, by label, as it was last built. */
  get itemLabels(): readonly string[] {
    return this.labels
  }

  /** Which of its five shapes the icon has now. */
  get iconState(): TrayIconState {
    return this.shown
  }

  /** The icon in a state, for a test to save a picture of. */
  icon(state: TrayIconState = this.shown): Electron.NativeImage {
    return trayImage(state)
  }

  /** The status line, as the menu and VoiceOver say it. */
  get statusLine(): string {
    const { status, pausedUntil } = this.model
    return pausedUntil === null
      ? status
      : `Paused until ${clockTime(pausedUntil)}. Shortcuts are off`
  }

  private render(): void {
    const { evaluationRecording, mode, cleanup, offer, handsFree, canCancel, support } = this.model
    const { recent, pausedUntil, live, attention } = this.model

    // One shape at a time: live, then what needs the user, then a pause, then the saving.
    const icon = trayIconState({
      live,
      attention,
      paused: pausedUntil !== null,
      saving: evaluationRecording,
    })
    if (icon !== this.shown) {
      this.shown = icon
      this.tray.setImage(trayImage(icon))
    }
    // The icon has no words of its own: what it stands for is read from here.
    this.tray.setToolTip(`${app.getName()}: ${this.statusLine}`)

    // Everything the pill offers is offered here as well. The pill cannot be reached
    // from the keyboard or by VoiceOver, and the menu can.
    const offered: MenuItemConstructorOptions[] = [
      ...(offer
        ? [{ label: offer === 'Undo' ? 'Undo Cancel' : 'Retry', click: () => this.actions.redo() }]
        : []),
      ...(handsFree ? [{ label: 'Stop Dictation', click: () => this.actions.stop() }] : []),
      ...(canCancel ? [{ label: 'Cancel Dictation', click: () => this.actions.cancel() }] : []),
    ]

    const template: MenuItemConstructorOptions[] = [
      { label: this.statusLine, enabled: false },
      ...offered,
      { type: 'separator' },
      // The shortcuts are shown beside them; it is the helper that listens for them.
      // Not while dictation is paused: the shortcuts are off then, and the items still work.
      {
        label: 'Paste Last Dictation',
        ...shortcutShown('Command+Control+V', pausedUntil === null),
        click: () => this.actions.pasteLast(),
      },
      {
        label: 'Copy Last Dictation',
        ...shortcutShown('Command+Control+C', pausedUntil === null),
        click: () => this.actions.copyLast(),
      },
      { label: 'Recent', submenu: this.recentItems(recent) },
      { type: 'separator' },
      {
        label: 'Mode',
        submenu: [
          {
            label: 'Verbatim',
            type: 'radio',
            checked: mode === 'verbatim',
            click: () => this.actions.setMode('verbatim'),
          },
          {
            label: 'Cleaned',
            type: 'radio',
            checked: mode === 'cleaned',
            click: () => this.actions.setMode('cleaned'),
          },
          // Which model, or why only the rules: the choosing is done in the window.
          ...(cleanup
            ? ([
                { type: 'separator' },
                { label: cleanup, enabled: false },
              ] satisfies MenuItemConstructorOptions[])
            : []),
        ],
      },
      { label: 'Microphone', submenu: this.microphoneItems() },
      pausedUntil === null
        ? { label: 'Pause Dictation for 1 Hour', click: () => this.actions.pause() }
        : { label: 'Resume Dictation', click: () => this.actions.resume() },
      { type: 'separator' },
      {
        label: `Open ${app.getName()}`,
        accelerator: 'Command+,',
        registerAccelerator: false,
        click: () => this.actions.openHub(),
      },
      {
        label: 'Advanced',
        submenu: [
          {
            // Said in full: this is the one setting that writes recordings to disk.
            label: 'Save Every Dictation (Recording and Text)',
            type: 'checkbox',
            checked: evaluationRecording,
            click: (item) => this.actions.setEvaluationRecording(item.checked),
          },
          { label: 'Show Saved Dictations', click: () => this.actions.showEvaluationFolder() },
          // What to look at, or send, when a dictation did not arrive. It never holds what was said.
          { label: 'Show Log', click: () => this.actions.showLog() },
        ],
      },
      { type: 'separator' },
      ...(support
        ? [{ label: 'Buy me a coffee…', click: () => this.actions.openSupportPage() }]
        : []),
      { label: `Quit ${app.getName()}`, accelerator: 'Command+Q', click: () => app.quit() },
    ]
    this.labels = template.flatMap((item) => (item.label ? [item.label] : []))
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  private recentItems(recent: readonly HistoryRow[]): MenuItemConstructorOptions[] {
    const withText = recent.filter((row) => row.text.length > 0).slice(0, RECENT_IN_MENU)
    if (withText.length === 0) return [{ label: 'No dictations yet', enabled: false }]
    return [
      ...withText.map((row): MenuItemConstructorOptions => ({
        label:
          row.text.length > RECENT_CHARS
            ? `${row.text.slice(0, RECENT_CHARS).trimEnd()}…`
            : row.text,
        click: () => this.actions.copyRecent(row.id),
      })),
      { type: 'separator' },
      { label: 'Choosing one copies it', enabled: false },
    ]
  }

  private microphoneItems(): MenuItemConstructorOptions[] {
    const { microphones, microphoneOrder, microphoneId } = this.model
    const connected = new Set(microphones.map((microphone) => microphone.deviceId))
    const away = microphoneOrder.filter((microphone) => !connected.has(microphone.deviceId))
    return [
      {
        label: 'System default',
        type: 'radio',
        checked: microphoneId === null,
        click: () => this.actions.chooseMicrophone(null),
      },
      ...microphones.map((microphone, index): MenuItemConstructorOptions => ({
        label: microphone.label ? microphoneName(microphone.label) : `Microphone ${index + 1}`,
        type: 'radio',
        checked: microphone.deviceId === microphoneId,
        click: () => this.actions.chooseMicrophone(microphone.deviceId),
      })),
      // In the order of preference, and not here now: listed, so that the order can be read.
      ...away.map((microphone): MenuItemConstructorOptions => ({
        label: `${microphone.label ? shortenInTheMiddle(microphoneName(microphone.label), 28) : 'A microphone'} (not connected)`,
        enabled: false,
      })),
    ]
  }
}
