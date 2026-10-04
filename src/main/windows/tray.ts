import { Menu, Tray, app, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { Microphone } from '@shared/ipc'

export interface TrayModel {
  /** One line describing what the app is doing or waiting for. */
  status: string
  microphones: Microphone[]
  /** The chosen microphone's device id, or null for the system default. */
  microphoneId: string | null
  /** Evaluation mode: every dictation's recording and text are being saved. */
  evaluationRecording: boolean
  mode: 'verbatim' | 'cleaned'
  /** What Cleaned mode will do right now; empty in Verbatim mode. */
  cleanup: string
  /** The local models Cleaned mode could use, and the one it does. */
  cleanupModels: string[]
  cleanupModel: string | null
}

export interface TrayActions {
  chooseMicrophone(deviceId: string | null): void
  setMode(mode: 'verbatim' | 'cleaned'): void
  chooseCleanupModel(name: string): void
  setEvaluationRecording(on: boolean): void
  showEvaluationFolder(): void
  showLog(): void
  openHub(): void
}

const SIZE = 18
/** Heights of the five bars of the menu-bar glyph, as a share of the icon. */
const BARS = [0.35, 0.7, 1, 0.55, 0.3]

/**
 * Draws the menu-bar icon: five bars, like a small sound wave. Drawn in code so the
 * app ships no borrowed artwork. It is a template image, so macOS tints it to suit
 * a light or dark menu bar.
 */
function trayIcon(): Electron.NativeImage {
  const scale = 2
  const pixels = SIZE * scale
  const bitmap = Buffer.alloc(pixels * pixels * 4)
  const barWidth = 2 * scale
  const gap = 1.5 * scale
  const totalWidth = BARS.length * barWidth + (BARS.length - 1) * gap
  const left = (pixels - totalWidth) / 2

  BARS.forEach((share, index) => {
    const height = Math.round(share * (pixels - 6 * scale))
    const x0 = Math.round(left + index * (barWidth + gap))
    const y0 = Math.round((pixels - height) / 2)
    for (let y = y0; y < y0 + height; y++) {
      for (let x = x0; x < x0 + barWidth; x++) {
        // BGRA, black and opaque: only the alpha matters for a template image.
        bitmap[(y * pixels + x) * 4 + 3] = 255
      }
    }
  })

  const image = nativeImage.createFromBitmap(bitmap, {
    width: pixels,
    height: pixels,
    scaleFactor: scale,
  })
  image.setTemplateImage(true)
  return image
}

/** The menu-bar item: status, microphone choice, and the way to open the Hub or quit. */
export class AppTray {
  /** The menu-bar icon, kept so a test can save a picture of it. */
  readonly icon = trayIcon()
  private readonly tray: Tray
  private model: TrayModel = {
    status: 'Starting…',
    microphones: [],
    microphoneId: null,
    evaluationRecording: false,
    mode: 'verbatim',
    cleanup: '',
    cleanupModels: [],
    cleanupModel: null,
  }

  constructor(private readonly actions: TrayActions) {
    this.tray = new Tray(this.icon)
    this.tray.setToolTip(app.getName())
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

  private render(): void {
    const { status, microphones, microphoneId, evaluationRecording, mode, cleanup } = this.model
    const { cleanupModels, cleanupModel } = this.model
    const microphoneItems: MenuItemConstructorOptions[] = [
      {
        label: 'System default',
        type: 'radio',
        checked: microphoneId === null,
        click: () => this.actions.chooseMicrophone(null),
      },
      ...microphones.map((microphone, index): MenuItemConstructorOptions => ({
        label: microphone.label || `Microphone ${index + 1}`,
        type: 'radio',
        checked: microphone.deviceId === microphoneId,
        click: () => this.actions.chooseMicrophone(microphone.deviceId),
      })),
    ]

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: status, enabled: false },
        { type: 'separator' },
        {
          label: 'Mode',
          submenu: [
            {
              label: 'Verbatim: exactly what was heard',
              type: 'radio',
              checked: mode === 'verbatim',
              click: () => this.actions.setMode('verbatim'),
            },
            {
              label: 'Cleaned: tidied on this Mac with Ollama',
              type: 'radio',
              checked: mode === 'cleaned',
              click: () => this.actions.setMode('cleaned'),
            },
            ...(cleanup
              ? ([
                  { type: 'separator' },
                  { label: cleanup, enabled: false },
                ] satisfies MenuItemConstructorOptions[])
              : []),
            // Only models that run on this Mac are ever listed.
            ...(mode === 'cleaned' && cleanupModels.length > 0
              ? ([
                  {
                    label: 'Model',
                    submenu: cleanupModels.map((name): MenuItemConstructorOptions => ({
                      label: name,
                      type: 'radio',
                      checked: name === cleanupModel,
                      click: () => this.actions.chooseCleanupModel(name),
                    })),
                  },
                ] satisfies MenuItemConstructorOptions[])
              : []),
          ],
        },
        { label: 'Microphone', submenu: microphoneItems },
        {
          label: 'Evaluation',
          submenu: [
            {
              // Said in full: this is the one setting that writes what was said to disk.
              label: 'Save every dictation (recording and text)',
              type: 'checkbox',
              checked: evaluationRecording,
              click: (item) => this.actions.setEvaluationRecording(item.checked),
            },
            { label: 'Show saved dictations', click: () => this.actions.showEvaluationFolder() },
          ],
        },
        { label: `Open ${app.getName()}`, click: () => this.actions.openHub() },
        // What to look at, or send, when a dictation did not arrive. It never holds what was said.
        { label: 'Show Log', click: () => this.actions.showLog() },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'Command+Q', click: () => app.quit() },
      ]),
    )
  }
}
