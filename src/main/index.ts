// First, for its effect: a release build drops the test switches from its environment.
import './test-switch-policy'
import { app, BrowserWindow, shell, systemPreferences } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  IPC,
  microphonesSchema,
  type AppStatus,
  type Microphone,
  type SpeechState,
} from '@shared/ipc'
import { handleAppProtocol, registerAppScheme } from './app-protocol'
import { startDebugControl } from './debug-control'
import { evaluationDir } from './dictation/evaluation-recorder'
import { wireDictation } from './dictation/wire-dictation'
import { latestOnly } from './latest-only'
import { LogFile, mirrorConsoleTo } from './log-file'
import { HelperBridge } from './native/helper-bridge'
import { helperBinaryPath, rendererDir } from './paths'
import {
  handleFromOwnPages,
  listenFromOwnPages,
  lockDownWebContents,
  restrictPermissions,
} from './security'
import { runSmoke } from './smoke'
import { SettingsStore } from './store/settings'
import { createSettingsChanger } from './store/settings-changer'
import { totalBytes } from './stt/model-store'
import { SttHost } from './stt/stt-host'
import { showHubWindow } from './windows/hub-window'
import { loadRenderer } from './windows/load-renderer'
import { createOverlayWindow, showOverlay } from './windows/overlay-window'
import { AppTray } from './windows/tray'

/** The menu's line about Ollama is not asked for more often than this as the pointer comes and goes. */
const TRAY_REFRESH_EVERY_MS = 2_000

/** `--smoke` starts every part once, prints a report and exits. See `smoke.ts`. */
const isSmoke = process.argv.includes('--smoke')
/** `--hidden` starts without opening the Hub window: the pill and shortcuts only. */
const startHidden = process.argv.includes('--hidden')

// --- Hooks for the automated tests. Each does nothing unless its variable is set. ---

/** A WAV file that stands in for the microphone, so tests need neither a voice nor a permission. */
const fakeMicrophone = process.env['WHISPER_FLOW_FAKE_MIC']
if (fakeMicrophone) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', fakeMicrophone)
  // The audio service is sandboxed and could not read the file otherwise.
  app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox')
}
if (process.env['WHISPER_FLOW_MUTE']) app.commandLine.appendSwitch('mute-audio')
/** Keeps a test's settings away from the real ones. */
const userDataDir = process.env['WHISPER_FLOW_USER_DATA_DIR']
if (userDataDir) app.setPath('userData', userDataDir)
/**
 * For tests that must not disturb the person using the Mac. The app never listens to
 * the keyboard (the helper creates no key tap, so it cannot see or swallow anyone's
 * keys) and never comes to the front (no Dock icon, no activation at launch).
 */
const quiet = Boolean(process.env['WHISPER_FLOW_QUIET'])
if (quiet) app.setActivationPolicy('accessory')

registerAppScheme()

// A smoke run may sit beside a normal instance; everything else is single-instance.
if (!isSmoke && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(main)
}

async function main(): Promise<void> {
  // An app opened from Finder has no terminal, so what it prints is also kept in a file.
  // A smoke run prints its report and exits; it leaves the file alone.
  const logFile = isSmoke ? null : new LogFile(join(logsDir(), 'main.log'))
  if (logFile) {
    mirrorConsoleTo(logFile)
    console.log(
      `[app] ${app.getName()} ${app.getVersion()} started (${app.isPackaged ? 'packaged' : 'development'}): ` +
        `macOS ${process.getSystemVersion()}, Electron ${process.versions.electron}, ` +
        `microphone permission ${systemPreferences.getMediaAccessStatus('microphone')}`,
    )
  }

  handleAppProtocol(rendererDir())
  restrictPermissions()
  lockDownWebContents()

  const helper = new HelperBridge(helperBinaryPath(), { args: quiet ? ['--no-tap'] : [] })
  const stt = new SttHost()
  const overlay = createOverlayWindow()

  if (isSmoke) {
    app.on('before-quit', () => {
      helper.stop()
      stt.stop()
    })
    app.dock?.hide()
    const report = await runSmoke({ helper, stt, overlay })
    console.log(`SMOKE_RESULT ${JSON.stringify(report)}`)
    app.exit(report.ok ? 0 : 1)
    return
  }

  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))

  let microphones: Microphone[] = []
  // Every change the user makes goes through here: it is made only if it can be saved.
  const changeSettings = createSettingsChanger({
    settings,
    showCurrent: (current) =>
      tray.update({
        microphoneId: current.microphoneId,
        evaluationRecording: current.evaluationRecording,
        mode: current.mode,
        cleanupModel: current.cleanupModel,
      }),
    tell: (message) => dictation.tell(message),
  })
  const chooseMicrophone = (deviceId: string | null): void => {
    changeSettings({ microphoneId: deviceId })
  }
  const setEvaluationRecording = (on: boolean): void => {
    if (!changeSettings({ evaluationRecording: on })) return
    console.log(`[evaluation] saving dictations: ${on ? 'on' : 'off'}`)
  }
  const setMode = (mode: 'verbatim' | 'cleaned'): void => {
    if (!changeSettings({ mode })) return
    console.log(`[dictation] mode: ${mode}`)
    refreshCleanupStatus()
  }
  /**
   * What Cleaned mode will do right now (which model, or why only the rules), for the
   * tray. Asking Ollama takes time, and the mode, the model or the server can be
   * changed meanwhile: only the answer to the latest asking is shown.
   */
  const refreshCleanupStatus = latestOnly(
    async () => {
      // The answer is about these settings, read at the moment the question is put.
      const asked = cleanupSettings()
      return { ...(await dictation.cleanupStatus()), asked }
    },
    ({ line, models, asked }) => {
      // Changed since, by something that did not ask again: the answer is about
      // settings that are no longer in force, so the question is put once more.
      if (asked !== cleanupSettings()) return refreshCleanupStatus()
      tray.update({
        cleanup: line,
        cleanupModels: models,
        cleanupModel: settings.get().cleanupModel,
      })
    },
  )
  /** The settings that decide what Cleaned mode does, as one value that can be compared. */
  const cleanupSettings = (): string => {
    const { mode, cleanupModel, ollamaUrl, allowRemoteOllama } = settings.get()
    return JSON.stringify([mode, cleanupModel, ollamaUrl, allowRemoteOllama])
  }
  /**
   * The pointer has reached the menu-bar icon, so the menu is about to be opened. What
   * it says about Ollama may be old: Ollama can be started, or stopped, at any time,
   * and nothing announces it. Asked again here, at most every couple of seconds.
   */
  let trayApproachedAt = -Infinity
  const trayApproached = (): void => {
    if (settings.get().mode !== 'cleaned') return
    if (performance.now() - trayApproachedAt < TRAY_REFRESH_EVERY_MS) return
    trayApproachedAt = performance.now()
    refreshCleanupStatus()
  }
  const tray = new AppTray({
    approached: trayApproached,
    chooseMicrophone,
    setMode,
    chooseCleanupModel: (name) => {
      if (changeSettings({ cleanupModel: name })) refreshCleanupStatus()
    },
    setEvaluationRecording,
    showEvaluationFolder: () => {
      mkdirSync(evaluationDir(), { recursive: true })
      void shell.openPath(evaluationDir())
    },
    showLog: () => {
      if (logFile) shell.showItemInFolder(logFile.path)
    },
    openHub: () => showHubWindow(),
  })
  tray.update({
    microphoneId: settings.get().microphoneId,
    evaluationRecording: settings.get().evaluationRecording,
    mode: settings.get().mode,
  })

  const dictation = wireDictation({
    helper,
    stt,
    overlay,
    settings,
    shortcuts: !quiet,
    onStatusChange: () => {
      tray.update({ status: statusLine() })
      if (settings.get().mode === 'cleaned') refreshCleanupStatus()
    },
  })
  const { speech } = dictation

  // The overlay page holds the microphone. If its process ends, a session in progress
  // has lost its recording and nobody will stop it: it ends here, and what can be kept is.
  overlay.webContents.on('render-process-gone', () => {
    dictation.controller.dispatch({ type: 'abort' })
  })

  function statusLine(): string {
    if (!helper.running) return 'The shortcut helper is not running'
    if (!dictation.shortcutsActive()) return 'Waiting for the Accessibility permission'
    return SPEECH_STATUS[speech.state]
  }

  app.on('before-quit', () => {
    helper.stop()
    speech.stop()
  })
  // The last moment: a helper that has not gone by now is not left behind with its key tap.
  app.on('quit', () => helper.kill())

  listenFromOwnPages(IPC.microphones, (payload) => {
    const parsed = microphonesSchema.safeParse(payload)
    if (!parsed.success) return
    microphones = parsed.data
    tray.update({ microphones })
  })

  handleFromOwnPages(IPC.appStatus, async (): Promise<AppStatus> => {
    const ready = helper.ready
    const permissions = helper.running ? await helper.checkPermissions().catch(() => null) : null
    const modelDownloaded = await speech.modelDownloaded()
    // The files can arrive by a route this app did not take (the download command,
    // another build that shares the folder). They are then loaded, not waited for.
    if (modelDownloaded && speech.state === 'modelMissing') void speech.prepare()
    return {
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        node: process.versions.node,
        chrome: process.versions.chrome,
      },
      packaged: app.isPackaged,
      helper: {
        running: helper.running,
        protocol: ready?.protocol ?? null,
        accessibilityTrusted: permissions?.accessibilityTrusted ?? null,
        tapInstalled: permissions?.tapInstalled ?? null,
      },
      speech: {
        state: speech.state,
        modelDownloaded,
        modelLabel: speech.model.label,
        modelBytes: totalBytes(speech.model),
        engine: stt.engine,
        downloadProgress: speech.downloadProgress,
        downloadError: speech.downloadError,
      },
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
      savingDictations: settings.get().evaluationRecording,
    }
  })
  // A page can stop the saving of dictations, and cannot start it: that is done in the
  // menu, by the person at the Mac.
  handleFromOwnPages(IPC.stopSavingDictations, (): void => setEvaluationRecording(false))
  // macOS shows its own prompt for Accessibility once. After that the button would do
  // nothing, so from the second press on it opens the list in System Settings instead.
  let askedForAccessibility = false
  handleFromOwnPages(IPC.requestAccessibility, async (): Promise<void> => {
    const trusted = await helper.promptAccessibility().catch(() => false)
    if (!trusted && askedForAccessibility) {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      )
    }
    askedForAccessibility = true
  })
  handleFromOwnPages(IPC.requestMicrophone, async (): Promise<void> => {
    // macOS asks only once. After a refusal, the switch is in System Settings.
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
    } else {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
      )
    }
  })
  handleFromOwnPages(IPC.downloadModel, (): void => {
    // Not awaited: the download takes minutes, and the status reports its progress.
    void speech.downloadModel()
  })
  handleFromOwnPages(IPC.cancelDownload, (): void => speech.cancelDownload())
  handleFromOwnPages(IPC.repairModel, (): void => {
    // Not awaited either: it may end in a download.
    void speech.repairModel()
  })

  helper.start()
  if (process.env['WHISPER_FLOW_DEBUG_CONTROL']) {
    startDebugControl({
      dictation,
      stt,
      overlay,
      tray,
      changeSettings,
      chooseMicrophone,
      setMode,
      setEvaluationRecording,
      refreshCleanupStatus,
      trayApproached,
    })
  }

  try {
    await loadRenderer(overlay, 'overlay')
    showOverlay(overlay)
  } catch (error) {
    console.error(
      '[main] the overlay did not load:',
      error instanceof Error ? error.message : error,
    )
  }
  // Loaded up front, so the first dictation does not wait for it.
  void speech.prepare()
  refreshCleanupStatus()

  if (!startHidden) showHubWindow()
  app.on('second-instance', () => showHubWindow())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().every((win) => win === overlay || !win.isVisible())) {
      showHubWindow()
    }
  })
  // The app keeps running with no window open: the pill and shortcuts are the product.
  app.on('window-all-closed', () => {})
}

/** Where the log file goes: beside a test's own data, otherwise in `~/Library/Logs`. */
function logsDir(): string {
  return userDataDir ? join(userDataDir, 'logs') : app.getPath('logs')
}

const SPEECH_STATUS: Record<SpeechState, string> = {
  ready: 'Ready. Hold Fn to dictate',
  // The model is loaded again on the next dictation, so this is still "ready" to the user.
  stopped: 'Ready. Hold Fn to dictate',
  loading: 'Loading the speech model…',
  modelMissing: 'The speech model is not downloaded',
  failed: 'Speech recognition could not start',
}
