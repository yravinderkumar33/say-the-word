// First, for its effect: a release build drops the test switches from its environment.
import './test-switch-policy'
import { app, BrowserWindow, clipboard, dialog, session, shell, systemPreferences } from 'electron'
import { mkdirSync } from 'node:fs'
import { arch, cpus, totalmem } from 'node:os'
import { join } from 'node:path'
import {
  IPC,
  microphonesSchema,
  type AppStatus,
  type DictationMode,
  type ExternalLink,
  type Microphone,
  type PillState,
} from '@shared/ipc'
import { dictationKeyLabel } from '@shared/keycodes'
import { handleAppProtocol, registerAppScheme } from './app-protocol'
import { findOllama, isInstalled, startOllama } from './cleanup/ollama-app'
import { startDebugControl } from './debug-control'
import { userDataPath } from './data-paths'
import { evaluationDir } from './dictation/evaluation-recorder'
import { wireDictation } from './dictation/wire-dictation'
import { historyEntry, historyTimings } from './history/from-session'
import { StorageHost } from './storage/storage-host'
import { wireHub, type Doors } from './hub/wire-hub'
import { latestOnly } from './latest-only'
import { kindAndPlace, LogFile, mirrorConsoleTo } from './log-file'
import {
  microphoneToUse,
  orderFrom,
  rankedMicrophones,
  withFirst,
  withFreshNames,
} from './microphones'
import { HelperBridge } from './native/helper-bridge'
import { helperBinaryPath, rendererDir } from './paths'
import { NetworkLedger, hostOf } from './privacy/network-ledger'
import { pageRequestAllowed } from './privacy/page-requests'
import { goneWithin, quitAfter } from './quitting'
import {
  handleFromOwnPages,
  listenFromOwnPages,
  lockDownWebContents,
  restrictPermissions,
} from './security'
import { runSmoke } from './smoke'
import { SettingsStore } from './store/settings'
import { createSettingsChanger } from './store/settings-changer'
import { firstDayOfWeek, usageDatabasePath } from './store/usage'
import { totalBytes } from './stt/model-store'
import { SttHost } from './stt/stt-host'
import { OLLAMA_DOWNLOAD_URL, sourcePage, supportHost, supportPage } from './support'
import { askForTests, askInDialog } from './system/confirm'
import { diagnostics } from './system/diagnostics'
import { noLoginItem, pretendLoginItem, systemLoginItem } from './system/login-item'
import { OtherDictationApp } from './system/other-dictation-app'
import { installAppMenu } from './windows/app-menu'
import { closeHubWindow, currentHubWindow, showHubWindow } from './windows/hub-window'
import { loadRenderer } from './windows/load-renderer'
import { createOverlayWindow, showOverlay } from './windows/overlay-window'
import { AppTray, RECENT_IN_MENU, type TrayModel } from './windows/tray'
import { trayStatus } from './windows/tray-status'

/**
 * Not asked for more often than this: the menu's line about Ollama, as the pointer comes
 * and goes, and the microphones' names, while the window asks for its status.
 */
const TRAY_REFRESH_EVERY_MS = 2_000
/** Quitting waits this long at most for the helper to leave: a little more than the second it gives itself. */
const HELPER_EXIT_WITHIN_MS = 1_500
/** How many dictations Home lists. */
const RECENT_ON_HOME = 3

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
/** Keeps a test's settings away from the real ones. The legacy default preserves existing installs. */
const userDataDir = process.env['WHISPER_FLOW_USER_DATA_DIR']
app.setPath('userData', userDataPath(app.getPath('appData'), userDataDir))
/**
 * For tests that must not disturb the person using the Mac. The app never listens to
 * the keyboard (the helper creates no key tap, so it cannot see or swallow anyone's
 * keys) and never comes to the front (no Dock icon, no activation at launch). A smoke
 * run is always one: it runs unattended, often beside the app the person is using, and
 * asks of the helper only that it answers.
 */
const quiet = isSmoke || Boolean(process.env['WHISPER_FLOW_QUIET'])
if (quiet) app.setActivationPolicy('accessory')
/**
 * The control line of the automated tests is open. Everything that would reach outside
 * the app (Finder, the browser, the clipboard, the login items, a system dialog) is
 * then counted instead of done.
 */
const underTest = Boolean(process.env['WHISPER_FLOW_DEBUG_CONTROL'])

// The last resort, for what nothing else caught: a line in the log. Electron's own way
// stays as it is: an uncaught exception shows its dialog, and a rejection nothing
// handles ends nothing (Electron 44 runs Node's `warn` mode here).
process.on('uncaughtExceptionMonitor', (error) => {
  console.error(`[app] uncaught exception: ${kindAndPlace(error)}`)
})
// Node prints its own warning for such a rejection as well, and that one carries the
// error's message, which the log mirrors and which can quote input. The line below says
// the kind and the place instead; every other warning is printed as before.
const printWarning = process.listeners('warning')
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'UnhandledPromiseRejectionWarning') return
  for (const print of printWarning) print(warning)
})
process.on('unhandledRejection', (reason) => {
  console.error(`[app] a rejection nothing handled: ${kindAndPlace(reason)}`)
})

registerAppScheme()

// A smoke run may sit beside a normal instance; everything else is single-instance.
if (!isSmoke && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.whenReady().then(main).catch(startFailed)
}

/**
 * A start that went wrong leaves no window and no menu-bar icon: the app would run on
 * unseen, holding the place that the next launch needs. It says so, and ends.
 */
function startFailed(error: unknown): void {
  console.error(`[app] could not start: ${kindAndPlace(error)}`)
  // Said on the screen too, except in a test's run, where a dialog would take the focus
  // and wait for a hand.
  if (!quiet && !underTest) {
    const said = error instanceof Error ? error.message : String(error)
    dialog.showErrorBox(`${app.getName()} could not start`, said)
  }
  app.exit(1)
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

  // Every address the app tries to reach is written down, for the Privacy page. The
  // two that it reaches on purpose (Ollama, the model download) note themselves, and are
  // asked for by the main process. A page of the app asks for nothing: anything one does
  // ask for is refused here, and written down as refused.
  const ledger = new NetworkLedger()
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (details, proceed) => {
      if (pageRequestAllowed(details.url, process.env['ELECTRON_RENDERER_URL'])) {
        ledger.tried(details.url, 'other')
        return proceed({})
      }
      ledger.tried(details.url, 'refused')
      // The host and nothing else: never a path, a query or anything that would have been sent.
      console.error(`[privacy] a page asked for ${hostOf(details.url) ?? 'an address'}: refused`)
      proceed({ cancel: true })
    },
  )

  const helper = new HelperBridge(helperBinaryPath(), { args: quiet ? ['--no-tap'] : [] })
  const stt = new SttHost()
  const overlay = createOverlayWindow()

  if (isSmoke) {
    const report = await runSmoke({ helper, stt, overlay })
    console.log(`SMOKE_RESULT ${JSON.stringify(report)}`)
    // `app.exit` skips `before-quit`: what was started is stopped here.
    helper.stop()
    stt.stop()
    app.exit(report.ok ? 0 : 1)
    return
  }

  // A second launch, or the app opened again from Finder, while it is still starting is
  // not lost: the window is shown once there is everything it asks for.
  let started = false
  let showWhenStarted = false
  const showHub = (): void => {
    if (started) showHubWindow()
    else showWhenStarted = true
  }
  app.on('second-instance', showHub)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().every((win) => win === overlay || !win.isVisible())) {
      showHub()
    }
  })
  // The app keeps running with no window open: the pill and shortcuts are the product.
  app.on('window-all-closed', () => {})

  const settings = new SettingsStore(join(app.getPath('userData'), 'settings.json'))
  // Asked before anything is saved, which states every entry: does the file as it was
  // found say how long the history is kept, or is "only until I quit" merely the default?
  const historyKeepIsKnown = settings.stated('historyKeep')
  // A first launch: there was no settings file. The steps of the first run are shown
  // until they have been gone through, however many launches that takes. A test's
  // instance starts from nothing every time, and is taken to be set up unless it asks.
  if (
    !settings.existedAtLaunch &&
    (!underTest || process.env['WHISPER_FLOW_FIRST_RUN']) &&
    settings.get().firstRun === undefined
  ) {
    try {
      settings.update({ firstRun: 'pending' })
    } catch {
      // Nothing can be saved: Home's status line leads through the setup instead.
    }
  }
  // The Dock icon is a choice. The packaged app starts without one (`LSUIElement`), so
  // none flashes up at launch; a run from the source tree starts with one and hides it.
  if (!quiet) {
    if (settings.get().showInDock) void app.dock?.show()
    else app.dock?.hide()
  }

  // The file the counts were kept in before their database; the database is beside it.
  const usageJson = join(app.getPath('userData'), 'usage.json')
  const usageFile = usageDatabasePath(usageJson)
  let storageChanged = (): void => {}
  const storage = new StorageHost(
    {
      history: {
        dir: join(app.getPath('userData'), 'history'),
        keep: settings.get().historyKeep,
        keepIsKnown: historyKeepIsKnown,
        paused: settings.get().historyPaused,
      },
      usageFile: usageJson,
      weekStartsOn: firstDayOfWeek(app.getSystemLocale()),
    },
    () => storageChanged(),
  )
  await storage.ready
  const usage = storage.usage
  const history = storage.history
  /** Session numbers start again at every launch; a dictation's id in the history does not. */
  const launch = Date.now().toString(36)
  const historyId = (sessionId: number): string => `${launch}-${sessionId}`
  /** The session a dictation in the history came from, when it was made in this launch. */
  const sessionOf = (id: string): number | null => {
    const [from, session, ...more] = id.split('-')
    return from === launch && session !== undefined && more.length === 0 && /^\d+$/.test(session)
      ? Number(session)
      : null
  }

  const loginItem = underTest ? pretendLoginItem() : app.isPackaged ? systemLoginItem : noLoginItem
  const otherApp = new OtherDictationApp()
  // What happens to be running on the Mac under test is not part of the test.
  if (underTest) otherApp.pretend(null)
  const tests = askForTests()
  const ask = underTest ? tests.ask : askInDialog(currentHubWindow)
  /**
   * A test's instance has no key tap, and its microphone permission is whatever the
   * terminal that started it has: it could never show what a Mac that is ready shows.
   * A test can say that both are in place, or that Accessibility has not been granted,
   * which is what a Mac shows at a first launch and the terminal's own grant would hide.
   */
  const pretend = { ready: false, noAccessibility: false }
  const shortcutsOn = (): boolean => dictation.shortcutsActive() || pretend.ready
  const microphoneAccess = (): AppStatus['microphone'] =>
    pretend.ready ? 'granted' : systemPreferences.getMediaAccessStatus('microphone')

  /** What the tests did that would have reached outside the app, by kind. */
  const reached: Record<string, number> = {}
  const count = (what: string): void => {
    reached[what] = (reached[what] ?? 0) + 1
  }
  const pageFor = (link: ExternalLink): string | null => {
    if (link === 'support') return supportPage()?.href ?? null
    if (link === 'source') return sourcePage()?.href ?? null
    if (link === 'issues') return sourcePage('/issues/new')?.href ?? null
    return OLLAMA_DOWNLOAD_URL
  }
  const doors: Doors = underTest
    ? {
        showInFinder: () => count('showInFinder'),
        openFolder: () => count('openFolder'),
        openLink: (link) => count(`openLink:${link}`),
        copy: () => count('copy'),
        startOllama: () => count('startOllama'),
      }
    : {
        showInFinder: (path) => shell.showItemInFolder(path),
        openFolder: (path) => {
          mkdirSync(path, { recursive: true })
          void shell.openPath(path)
        },
        // The address comes from here and nowhere else: a page names the kind of link only.
        openLink: (link) => {
          const page = pageFor(link)
          if (page) {
            shell.openExternal(page).catch(() => console.error('[app] the browser did not open'))
          }
        },
        copy: (text) => {
          clipboard
            .writeText(text)
            .catch(() => console.error('[app] the clipboard could not be written'))
        },
        startOllama: () => {
          if (!startOllama()) console.log('[cleanup] Ollama is not installed: nothing to start')
        },
      }

  let microphones: Microphone[] = []
  /** The microphone a dictation would use now, by device id; null for the system default. */
  const microphoneInUse = (): string | null =>
    microphoneToUse(rankedMicrophones(settings.get()), microphones)
  const showMicrophones = (): void =>
    tray.update({
      microphones,
      microphoneOrder: rankedMicrophones(settings.get()),
      microphoneId: microphoneInUse(),
    })

  // Every change the user makes goes through here: it is made only if it can be saved.
  const changeSettings = createSettingsChanger({
    settings,
    showCurrent: (current) =>
      tray.update({
        microphoneOrder: rankedMicrophones(current),
        microphoneId: microphoneInUse(),
        evaluationRecording: current.evaluationRecording,
        mode: current.mode,
        cleanupModel: current.cleanupModel,
      }),
    tell: (message) => dictation.tell(message),
  })
  /** One microphone put first, or the system default followed again. */
  const chooseMicrophone = (deviceId: string | null): void => {
    const ranked = rankedMicrophones(settings.get())
    const chosen =
      deviceId === null
        ? null
        : (microphones.find((microphone) => microphone.deviceId === deviceId) ??
          ranked.find((microphone) => microphone.deviceId === deviceId) ?? { deviceId, label: '' })
    const order = chosen ? withFirst(ranked, chosen) : []
    changeSettings({ microphoneId: order[0]?.deviceId ?? null, microphoneOrder: order })
  }
  const setMicrophoneOrder = (deviceIds: string[]): void => {
    const order = orderFrom(deviceIds, rankedMicrophones(settings.get()), microphones)
    changeSettings({ microphoneId: order[0]?.deviceId ?? null, microphoneOrder: order })
  }
  /**
   * "Save every dictation", on or off. Turned off, the dictations under way stop being
   * saved even if the setting itself could not be written: that much is in the app's
   * hands, and the pill says that the setting was not saved. Resolves with how many of
   * their files could not be removed.
   */
  const setEvaluationRecording = async (on: boolean): Promise<number> => {
    const saved = changeSettings({ evaluationRecording: on })
    if (saved) console.log(`[evaluation] saving dictations: ${on ? 'on' : 'off'}`)
    if (on) return 0
    const failed = await dictation.stopEvaluation()
    if (failed > 0)
      dictation.tell(
        'Some unfinished recordings could not be removed. Try Delete Everything in Privacy.',
      )
    return failed
  }
  /** The same, from the menu or a test, which wait for nothing: a failure is said on the pill. */
  const switchEvaluationRecording = (on: boolean): void => {
    setEvaluationRecording(on).catch(() =>
      dictation.tell(
        'Some unfinished recordings could not be removed. Try Delete Everything in Privacy.',
      ),
    )
  }
  const setMode = (mode: DictationMode): void => {
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
   * it says may be old: the microphone can be allowed or switched off in System Settings,
   * a download moves on, and Ollama can be started or stopped, and nothing announces any
   * of it. The status is worked out again here; Ollama is asked at most every couple of
   * seconds.
   */
  let trayApproachedAt = -Infinity
  const trayApproached = (): void => {
    showStatus()
    if (settings.get().mode !== 'cleaned') return
    if (performance.now() - trayApproachedAt < TRAY_REFRESH_EVERY_MS) return
    trayApproachedAt = performance.now()
    refreshCleanupStatus()
  }
  const tray = new AppTray({
    approached: trayApproached,
    chooseMicrophone,
    setMode,
    setEvaluationRecording: switchEvaluationRecording,
    showEvaluationFolder: () => doors.openFolder(evaluationDir()),
    showLog: () => {
      if (logFile) doors.showInFinder(logFile.path)
    },
    openHub: () => showHubWindow(),
    // The menu was drawn a while ago: the offer it shows may have lapsed since. Pressed
    // when nothing is offered any more, it does nothing, so that it cannot dismiss
    // whatever the pill is saying now.
    redo: () => {
      if (tray.state.offer) dictation.act('redo')
    },
    pasteLast: () => dictation.controller.dispatch({ type: 'pasteLast' }),
    copyLast: () => dictation.controller.dispatch({ type: 'copyLast' }),
    // The same goes for Stop and Cancel, when the session they were offered for is over.
    // (The menu cannot tell that session from a new one started from the keyboard while
    // it was open: that one would be stopped or cancelled.)
    stop: () => {
      if (tray.state.handsFree) dictation.act('stop')
    },
    cancel: () => {
      if (tray.state.canCancel) dictation.act('cancel')
    },
    openSupportPage: () => doors.openLink('support'),
    // The history may not answer (its process restarting, a request that ran out of time,
    // the app quitting): the pill says so, in words of its own.
    copyRecent: (id) => {
      // The same copy as the History page's, made where the pages' requests are checked.
      copyEntry(id, 'written').catch(() => dictation.tell('That dictation could not be copied.'))
    },
    pause: () => dictation.pause.start(),
    resume: () => dictation.pause.end(),
  })
  // The dictations the History page lists: in memory, unless the user chose otherwise.
  // The menu lists the newest of them, so it is told whenever the history changes.
  storageChanged = () => tray.update({ recent: history.newestWithText(RECENT_IN_MENU) })
  tray.update({
    microphoneOrder: rankedMicrophones(settings.get()),
    microphoneId: microphoneInUse(),
    evaluationRecording: settings.get().evaluationRecording,
    mode: settings.get().mode,
    support: supportHost() !== null,
    recent: history.newestWithText(RECENT_IN_MENU),
  })

  /**
   * The menu offers what the pill offers, so it is told whenever the pill's offer
   * changes; the icon shows when the microphone is live; and a page of the window that
   * teaches what the pill says is told what it shows.
   */
  const followPill = (pill: PillState): void => {
    currentHubWindow()?.webContents.send(IPC.hubPill, pill)
    const offer = pill.kind === 'recovery' ? (pill.redo ?? null) : null
    const handsFree = pill.kind === 'listening' && pill.handsFree
    const canCancel = handsFree || (pill.kind === 'processing' && pill.long)
    const live = pill.kind === 'listening'
    const now = tray.state
    if (
      offer === now.offer &&
      handsFree === now.handsFree &&
      canCancel === now.canCancel &&
      live === now.live
    )
      return
    tray.update({ offer, handsFree, canCancel, live })
  }

  const dictation = wireDictation({
    helper,
    stt,
    overlay,
    settings,
    shortcuts: !quiet,
    microphoneId: microphoneInUse,
    onStatusChange: () => {
      tray.update({ ...currentStatus(), pausedUntil: dictation.pause.until })
      if (settings.get().mode === 'cleaned') refreshCleanupStatus()
    },
    onPillChange: followPill,
    onDictation: (counted) => usage.add(counted),
    // The history is kept from the records the session controller makes. A dictation
    // into one of the app's own windows (a practice, a sentence being tried) is left out.
    onRecorded: (entry, { ownWindow }) => {
      if (ownWindow) return
      const id = historyId(entry.sessionId)
      history.put(historyEntry(entry, id, settings.get().mode), true)
    },
    onTimings: (sessionId, timings) => history.patch(historyId(sessionId), historyTimings(timings)),
    onFetched: (sessionId, how) => history.patch(historyId(sessionId), { fetched: how }),
    onFailed: (sessionId, message) => history.patch(historyId(sessionId), { failure: message }),
    ollamaFetch: ledger.watch('ollama'),
    downloadFetch: ledger.watch('speechModel'),
    copy: (text) => doors.copy(text),
  })
  const { speech } = dictation

  // The overlay page holds the microphone. If its process ends, a session in progress
  // has lost its recording and nobody will stop it: it ends here, and what can be kept is.
  overlay.webContents.on('render-process-gone', () => {
    dictation.controller.dispatch({ type: 'abort' })
  })

  /** The menu's status line, and whether the icon asks for the user, from what is known now. */
  function currentStatus(): Pick<TrayModel, 'status' | 'attention'> {
    const { line, attention } = trayStatus({
      helperRunning: helper.running,
      shortcutsOn: shortcutsOn(),
      speech: { state: speech.state, downloadProgress: speech.downloadProgress },
      microphone: microphoneAccess(),
      key: dictationKeyLabel(settings.get().dictationKey),
    })
    return { status: line, attention }
  }
  /** The same, given to the menu only where it has changed: the menu is built again each time. */
  function showStatus(): void {
    const now = currentStatus()
    if (now.status !== tray.state.status || now.attention !== tray.state.attention) tray.update(now)
  }

  // Quitting waits for the history's last writes, and for the helper to leave by itself:
  // a paste under way then puts the user's clipboard back. Both are bounded.
  quitAfter(app, () => {
    helper.stop()
    speech.stop()
    return Promise.allSettled([storage.stop(), goneWithin(helper, HELPER_EXIT_WITHIN_MS)])
  })
  // The last moment: a helper that has not gone by now is not left behind with its key tap.
  app.on('quit', () => helper.kill())

  listenFromOwnPages(IPC.microphones, (payload) => {
    const parsed = microphonesSchema.safeParse(payload)
    if (!parsed.success) return
    microphones = parsed.data
    // A microphone in the order of preference is remembered with its name, so that it
    // can still be named when it is not connected. Kept quietly: nobody asked for this.
    const fresh = withFreshNames(settings.get().microphoneOrder, microphones)
    if (fresh) {
      try {
        settings.update({ microphoneOrder: fresh })
      } catch {
        // The names are a convenience; the order itself is unchanged.
      }
    }
    showMicrophones()
  })

  /** A setting that the Dock, the pill or the menu depends on has changed. */
  const settingsChanged = (): void => {
    dictation.settingsChanged()
    applyDock()
    showStatus()
    refreshCleanupStatus()
  }
  /** Shows or hides the Dock icon, as the setting says. A test's instance never has one. */
  function applyDock(): void {
    if (quiet || !app.dock) return
    const wanted = settings.get().showInDock
    if (wanted === app.dock.isVisible()) return
    if (wanted) {
      void app.dock.show()
      return
    }
    // Hiding the Dock icon takes the app's windows out of view with it: the one that
    // was open is brought back.
    const hub = currentHubWindow()
    const wasOpen = hub?.isVisible() ?? false
    app.dock.hide()
    if (wasOpen) setTimeout(() => showHubWindow(), 300)
  }

  /** Whether the steps of the first run are shown, and whether for the first time. */
  const firstRunShown = (): AppStatus['firstRun'] => {
    const { firstRun } = settings.get()
    return firstRun === 'pending' ? 'first' : firstRun === 'again' ? 'again' : null
  }

  const { privacyFacts, copyEntry } = wireHub({
    settings,
    changeSettings,
    history,
    dictation,
    usage,
    ledger,
    logFile,
    usageFile,
    evaluationDir: evaluationDir(),
    ask,
    loginItem,
    doors,
    microphones: () => microphones,
    setMicrophoneOrder,
    settingsChanged,
    diagnostics: async () => {
      const permissions = helper.running ? await helper.checkPermissions().catch(() => null) : null
      const current = settings.get()
      return diagnostics({
        appVersion: app.getVersion(),
        build: app.isPackaged ? 'packaged' : 'development',
        macOS: process.getSystemVersion(),
        chip: `${cpus()[0]?.model ?? 'unknown chip'} (${arch()})`,
        memoryGb: Math.round(totalmem() / 2 ** 30),
        electron: process.versions.electron,
        helper: helper.running
          ? `running, protocol ${helper.ready?.protocol ?? 'unknown'}, key tap ${permissions?.tapInstalled ? 'on' : 'off'}`
          : 'not running',
        accessibility: permissions ? (permissions.accessibilityTrusted ? 'on' : 'off') : 'unknown',
        microphone: systemPreferences.getMediaAccessStatus('microphone'),
        speech: `${speech.model.label}, ${speech.state}`,
        mode: current.mode,
        cleanup: tray.state.cleanup,
        dictationKey: dictationKeyLabel(current.dictationKey),
        history: `${history.keep}${history.paused ? ', paused' : ''}, ${history.count} listed`,
        savingDictations: current.evaluationRecording,
        paused: dictation.pause.active,
      })
    },
    hubWindow: currentHubWindow,
    closeHub: closeHubWindow,
    // Asked for from Settings, it is a second look: the steps then start from the
    // choices already made, and not from those of a new installation.
    setFirstRun: (pending) => {
      changeSettings({ firstRun: pending ? 'again' : 'done' })
    },
    sessionOf,
  })

  /**
   * The names of the microphones can be read only once the microphone is allowed, and
   * only the overlay page can read them. While the window is open and they are not
   * known, that page is asked to look again, now and then.
   */
  let listedAt = -Infinity
  const listMicrophonesIfUnknown = (): void => {
    const known = microphones.length > 0 && microphones.every((item) => item.label !== '')
    if (known || microphoneAccess() !== 'granted') return
    if (performance.now() - listedAt < TRAY_REFRESH_EVERY_MS) return
    listedAt = performance.now()
    if (!overlay.isDestroyed()) overlay.webContents.send(IPC.listMicrophones)
  }

  handleFromOwnPages(IPC.appStatus, async (): Promise<AppStatus> => {
    listMicrophonesIfUnknown()
    const ready = helper.ready
    const permissions = helper.running ? await helper.checkPermissions().catch(() => null) : null
    const modelDownloaded = await speech.modelDownloaded()
    // The files can arrive by a route this app did not take (the download command,
    // another build that shares the folder). They are then loaded, not waited for.
    if (modelDownloaded && speech.state === 'modelMissing') void speech.prepare()
    const current = settings.get()
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
        accessibilityTrusted: pretend.ready
          ? true
          : pretend.noAccessibility
            ? false
            : (permissions?.accessibilityTrusted ?? null),
        tapInstalled: pretend.ready
          ? true
          : pretend.noAccessibility
            ? false
            : (permissions?.tapInstalled ?? null),
      },
      speech: {
        state: speech.state,
        modelDownloaded,
        modelLabel: speech.model.label,
        modelLicence: speech.model.licence,
        modelBytes: totalBytes(speech.model),
        modelLanguages: speech.model.languages.length,
        engine: stt.engine,
        downloadProgress: speech.downloadProgress,
        downloadError: speech.downloadError,
      },
      microphone: microphoneAccess(),
      savingDictations: current.evaluationRecording,
      mode: current.mode,
      cleanup: current.mode === 'cleaned' ? tray.state.cleanup : '',
      ollamaInstalled: isInstalled(findOllama()),
      microphones,
      microphoneOrder: rankedMicrophones(current),
      microphoneInUse: microphoneInUse(),
      dictationKey: current.dictationKey,
      pausedUntil: dictation.pause.until,
      // Two apps on `Fn` is the conflict; with another key chosen there is none.
      conflict: current.dictationKey === 'fn' ? otherApp.current() : null,
      firstRun: firstRunShown(),
      recent: history.newest(RECENT_ON_HOME),
      history: history.summary(),
      practice: dictation.practice(),
      usage: usage.summary(current.mode),
      preferences: {
        sounds: current.sounds,
        soundVolume: current.soundVolume,
        pillAtRest: current.pillAtRest,
        showInDock: current.showInDock,
        openAtLogin: loginItem.get(),
        modelKeep: current.modelKeep,
        ollamaUrl: current.ollamaUrl,
      },
      supportHost: supportHost(),
      links: { source: sourcePage() !== null, issues: sourcePage('/issues/new') !== null },
    }
  })
  // What the window can change is what the menu can: the mode and the microphone. Each
  // change goes through the same door, and is made only if it can be saved.
  handleFromOwnPages(IPC.setMode, (_event, mode): void => {
    if (mode === 'verbatim' || mode === 'cleaned') setMode(mode)
  })
  handleFromOwnPages(IPC.chooseMicrophone, (_event, deviceId): void => {
    // Only a microphone the system offers, or none: a page cannot write anything else here.
    if (deviceId === null) chooseMicrophone(null)
    else if (microphones.some((microphone) => microphone.deviceId === deviceId)) {
      chooseMicrophone(deviceId as string)
    }
  })
  // A page can stop the saving of dictations, and cannot start it: that is done in the
  // menu, by the person at the Mac.
  handleFromOwnPages(IPC.stopSavingDictations, async (): Promise<void> => {
    await setEvaluationRecording(false)
  })
  // macOS shows its own prompt for Accessibility once. After that the button would do
  // nothing, so from the second press on it opens the list in System Settings instead.
  let askedForAccessibility = false
  handleFromOwnPages(IPC.requestAccessibility, async (): Promise<void> => {
    if (underTest) return count('requestAccessibility')
    const trusted = await helper.promptAccessibility().catch(() => false)
    if (!trusted && askedForAccessibility) {
      await shell.openExternal(
        'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      )
    }
    askedForAccessibility = true
  })
  handleFromOwnPages(IPC.requestMicrophone, async (): Promise<void> => {
    if (underTest) return count('requestMicrophone')
    // macOS asks only once. After a refusal, the switch is in System Settings.
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      await systemPreferences.askForMediaAccess('microphone')
      // Answered: the menu-bar icon stops asking for it, or says that it is switched off.
      showStatus()
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

  installAppMenu({
    openSettings: () => showHubWindow('settings'),
    openAbout: () => showHubWindow('about'),
  })

  helper.start()
  if (underTest) {
    startDebugControl({
      dictation,
      stt,
      overlay,
      tray,
      settings,
      history,
      changeSettings,
      chooseMicrophone,
      setMode,
      setEvaluationRecording: switchEvaluationRecording,
      settingsChanged,
      trayApproached,
      otherApp,
      dialogs: tests,
      reached,
      pretend,
      statusChanged: showStatus,
      privacyFacts,
      openAtLogin: () => loginItem.get(),
      figures: () => {
        const { wordsToday, wordsThisWeek } = usage.summary(settings.get().mode)
        return {
          wordsToday,
          wordsThisWeek,
          recent: history.newest(RECENT_ON_HOME).map((item) => item.outcome),
        }
      },
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
  // What is older than the time the history is kept for goes, also while nothing is dictated.
  setInterval(() => history.sweep(), 60 * 60_000).unref()

  started = true
  // Opened by the system at login, the app starts as it lives: in the menu bar, with no
  // window, unless the window was asked for while it started.
  if (showWhenStarted || (!startHidden && !loginItem.openedAtLogin())) showHubWindow()
}

/** Where the log file goes: beside a test's own data, otherwise in `~/Library/Logs`. */
function logsDir(): string {
  return userDataDir ? join(userDataDir, 'logs') : app.getPath('logs')
}
