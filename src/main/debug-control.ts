import { systemPreferences, type BrowserWindow, type WebContents } from 'electron'
import { writeFileSync } from 'node:fs'
import { IPC, type CaptureCommand } from '@shared/ipc'
import { wordErrorRate } from '@shared/wer'
import type { Dictation } from './dictation/wire-dictation'
import type { MachineEvent } from './hotkeys/session-machine'
import type { SettingsPatch } from './store/settings'
import type { SttHost } from './stt/stt-host'
import { createHubWindow } from './windows/hub-window'
import { isOverlayInteractive } from './windows/overlay-window'
import type { AppTray } from './windows/tray'

/**
 * A control line for the automated tests, which cannot unplug a microphone, crash a
 * process or put the Mac to sleep. It reads one command per line from standard input,
 * and exists only when the app is started with `WHISPER_FLOW_DEBUG_CONTROL=1`.
 *
 * It can start, stop and disturb dictations. It cannot read what was said: everything
 * it prints is a state, a count, or a score against text the test itself supplied.
 *
 *   press | release | escape | abort     the same events the shortcut helper reports
 *   hands-free                           the hands-free shortcut (Fn+Space)
 *   stop                                 the pill's stop button
 *   paste-last | copy-last               the other two shortcuts
 *   click-pill <Cancel|Dismiss|Stop|Undo|Retry|Pill> [stay]
 *                                        click a button on the pill, or the pill itself, as
 *                                        the mouse would; `stay` leaves the pointer there
 *   kill-worker                          end the speech worker as a crash would
 *   lose-microphone                      end the recording as an unplugged microphone would
 *   unload-model                         free the model, as the idle timer does
 *   download-model                       what the setup window's Download button does
 *   cancel-download                      what its Cancel button does
 *   repair-model                         what its "Check the model files" button does
 *   text-delay <ms>                      hold every session in "processing" this much longer
 *   fail-next-transcript                 make the next decode fail, with the recording kept
 *   max-recording <ms>                   a shorter recording limit
 *   quiet-paste                          count pastes instead of typing them into the app
 *                                        in front, and stop reading that app's focus
 *   expect <base64 text>                 the words the test is about to play; texts are
 *                                        scored against them (word error rate)
 *   microphone <device id|default>       what choosing a microphone in the tray does
 *   evaluation <on|off>                  what the tray's "Save every dictation" does
 *   mode <verbatim|cleaned>              what the tray's Mode menu does
 *   ollama-url <url>                     where Cleaned mode looks for Ollama
 *   cleanup-model <name|none>            the model Cleaned mode uses
 *   approach-tray                        what moving the pointer onto the menu-bar icon does
 *   capture-pill <png path>              save a picture of the pill as it looks right now
 *   capture-hub <png path>               save a picture of the setup window, without showing it
 *   capture-tray <png path>              save a picture of the menu-bar icon
 *   devices                              print `DEBUG_DEVICES […]`: the audio inputs by name
 *   status                               print `DEBUG_STATUS {…}`
 */
export function startDebugControl(parts: {
  dictation: Dictation
  stt: SttHost
  overlay: BrowserWindow
  tray: AppTray
  changeSettings(patch: SettingsPatch): boolean
  chooseMicrophone(deviceId: string | null): void
  setMode(mode: 'verbatim' | 'cleaned'): void
  setEvaluationRecording(on: boolean): void
  refreshCleanupStatus(): void
  trayApproached(): void
}): void {
  const { dictation, stt, overlay, tray } = parts
  const { controller, speech, debug } = dictation
  const dispatch = (event: MachineEvent): void => controller.dispatch(event)
  /** Only the time between a press and its release matters, so any steady clock will do. */
  const now = (): number => performance.now()

  let expected: string | null = null
  const score = (text: string | null): number | null =>
    expected !== null && text ? Number(wordErrorRate(expected, text).toFixed(3)) : null
  /** Every paste made while `quiet-paste` is on: which session, how long, how accurate. */
  const pastes: Array<{ session: number | null; chars: number; wer: number | null }> = []

  const run = (line: string): void => {
    const [command, argument, option] = line.trim().split(/\s+/)
    switch (command) {
      case 'press':
        return dispatch({ type: 'pttDown', t: now() })
      case 'release':
        return dispatch({ type: 'pttUp', t: now() })
      case 'hands-free':
        return dispatch({ type: 'handsFreeDown', t: now() })
      case 'stop':
        return dispatch({ type: 'stop' })
      case 'escape':
        return dispatch({ type: 'escape' })
      case 'abort':
        return dispatch({ type: 'abort' })
      case 'paste-last':
        return dispatch({ type: 'pasteLast' })
      case 'copy-last':
        return dispatch({ type: 'copyLast' })
      case 'click-pill':
        // `stay` leaves the pointer where it clicked, as a hand that has not moved yet.
        if (argument) void clickPill(argument, option === 'stay')
        return
      case 'kill-worker':
        if (stt.pid !== null) process.kill(stt.pid, 'SIGKILL')
        return
      case 'lose-microphone': {
        const session = controller.currentSessionId
        if (session === null) return
        const lose: CaptureCommand = { kind: 'loseMicrophone', session }
        overlay.webContents.send(IPC.captureCommand, lose)
        return
      }
      case 'unload-model':
        return speech.unload()
      case 'download-model':
        void speech.downloadModel()
        return
      case 'cancel-download':
        return speech.cancelDownload()
      case 'repair-model':
        void speech.repairModel()
        return
      case 'fail-next-transcript':
        debug.failNextTranscript = true
        return
      case 'text-delay':
        debug.textDelayMs = Math.max(0, Number(argument) || 0)
        return
      case 'max-recording':
        debug.maxRecordingMs = Number(argument) > 0 ? Number(argument) : null
        return
      case 'quiet-paste':
        debug.target = () => ({ targetId: 1, secure: false })
        debug.paste = (session, text) => {
          pastes.push({ session, chars: text.length, wer: score(text) })
          return 'pasted'
        }
        return
      case 'expect':
        expected = argument ? Buffer.from(argument, 'base64').toString('utf8') : null
        return
      case 'microphone':
        if (argument) parts.chooseMicrophone(argument === 'default' ? null : argument)
        return
      case 'evaluation':
        return parts.setEvaluationRecording(argument === 'on')
      case 'mode':
        return parts.setMode(argument === 'cleaned' ? 'cleaned' : 'verbatim')
      case 'ollama-url':
        if (argument) parts.changeSettings({ ollamaUrl: argument })
        return parts.refreshCleanupStatus()
      case 'cleanup-model':
        parts.changeSettings({ cleanupModel: !argument || argument === 'none' ? null : argument })
        return parts.refreshCleanupStatus()
      case 'approach-tray':
        return parts.trayApproached()
      case 'capture-pill':
        if (argument) void capturePill(argument)
        return
      case 'capture-hub':
        if (argument) void captureHub(argument)
        return
      case 'capture-tray':
        if (argument) {
          writeFileSync(argument, tray.icon.toPNG({ scaleFactor: 2 }))
          console.log(`[debug] captured ${argument}`)
        }
        return
      case 'devices':
        void overlay.webContents
          .executeJavaScript(
            `navigator.mediaDevices.enumerateDevices().then((all) =>
               all.filter((d) => d.kind === 'audioinput').map((d) => d.label))`,
          )
          .then((labels) => console.log(`DEBUG_DEVICES ${JSON.stringify(labels)}`))
        return
      case 'status':
        void printStatus()
        return
      default:
        return
    }
  }

  const printStatus = async (): Promise<void> => {
    // Asked of the overlay page itself: how many microphone streams it holds open.
    const openMicrophones = (await overlay.webContents
      .executeJavaScript('window.flowOpenMicrophones()')
      .catch(() => null)) as number | null
    console.log(
      `DEBUG_STATUS ${JSON.stringify({
        state: controller.stateName,
        session: controller.currentSessionId,
        speech: speech.state,
        workerPid: stt.pid,
        shortcutsActive: dictation.shortcutsActive(),
        microphone: systemPreferences.getMediaAccessStatus('microphone'),
        openMicrophones,
        // True while the overlay still holds a finished or cancelled recording.
        holdsRecording: await overlay.webContents
          .executeJavaScript('window.flowHoldsRecording()')
          .catch(() => null),
        // What the tray menu shows: its status line and the microphones it lists.
        trayStatus: tray.state.status,
        microphones: tray.state.microphones.length,
        namedMicrophones: tray.state.microphones.filter((item) => item.label !== '').length,
        chosenMicrophone: tray.state.microphoneId,
        evaluationRecording: tray.state.evaluationRecording,
        mode: tray.state.mode,
        cleanup: tray.state.cleanup,
        cleanupModels: tray.state.cleanupModels,
        pill: await pillState(),
        // True when the pill shows the hands-free buttons.
        pillHandsFree: await overlay.webContents
          .executeJavaScript(`document.querySelector('.pill')?.dataset.handsFree === 'true'`)
          .catch(() => false),
        // True only while the pointer is over a pill button; otherwise clicks pass through.
        overlayTakesClicks: isOverlayInteractive(overlay),
        overlayBounds: overlay.getBounds(),
        downloadProgress: speech.downloadProgress,
        downloadError: speech.downloadError,
        // Whether the model's files are on disk and vouched for, as the setup window is told.
        modelDownloaded: await speech.modelDownloaded(),
        pastes,
        recovery: controller.recovery.list().map((entry) => ({
          session: entry.sessionId,
          outcome: entry.outcome,
          hasText: Boolean(entry.finalText),
          wer: score(entry.finalText),
          // Cleaned mode: why the final text is what it is, and whether the model's text was used.
          note: entry.cleanupNote ?? null,
        })),
      })}`,
    )
  }

  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** What the pill is showing, read from the page itself. */
  const pillState = (): Promise<string | null> =>
    overlay.webContents
      .executeJavaScript(`document.querySelector('.pill')?.dataset.state ?? null`)
      .catch(() => null) as Promise<string | null>

  /**
   * Moves the pointer onto a pill button and clicks it, through the page's own input
   * handling. The system pointer does not move, and no other app is involved.
   */
  const clickPill = async (label: string, stay: boolean): Promise<void> => {
    const page = overlay.webContents
    const find = (): Promise<{ x: number; y: number } | null> =>
      page
        .executeJavaScript(
          `(() => {
             const name = '${label.replace(/[^A-Za-z]/g, '')}'
             const target = name === 'Pill'
               ? document.querySelector('.pill')
               : document.querySelector('.pill [aria-label="' + name + '"]')
             const box = target?.getBoundingClientRect()
             return box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null
           })()`,
        )
        .catch(() => null) as Promise<{ x: number; y: number } | null>

    // The pill changes size with an animation, and a button rides along with it. Wait
    // until the button has stopped moving, as a hand would, or the click lands beside it.
    let centre = await find()
    for (let tries = 0; centre && tries < 8; tries++) {
      await pause(90)
      const again = await find()
      if (again && again.x === centre.x && again.y === centre.y) break
      centre = again
    }
    if (!centre) {
      console.log(`[debug] no pill button "${label}"`)
      return
    }
    // The pill ignores a click that comes too soon after it changed (a double-click's
    // second click would otherwise land on whatever button took the first one's place).
    for (let tries = 0; tries < 12; tries++) {
      const ready = (await page
        .executeJavaScript('window.flowPillAcceptsClicks?.() ?? true')
        .catch(() => true)) as boolean
      if (ready) break
      await pause(50)
    }
    page.sendInputEvent({ type: 'mouseMove', ...centre })
    await pause(60)
    console.log(
      `[debug] pointer on the pill; window takes clicks: ${isOverlayInteractive(overlay)}`,
    )
    page.sendInputEvent({ type: 'mouseDown', ...centre, button: 'left', clickCount: 1 })
    page.sendInputEvent({ type: 'mouseUp', ...centre, button: 'left', clickCount: 1 })
    if (stay) return
    await pause(60)
    // The pointer leaves again, as it would after a click.
    page.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
  }
  const save = async (page: WebContents, path: string, stayHidden: boolean): Promise<void> => {
    const image = await page.capturePage(undefined, { stayHidden })
    writeFileSync(path, image.toPNG())
    console.log(`[debug] captured ${path}`)
  }

  /** A picture of the overlay page alone: nothing else on the screen is in it. */
  const capturePill = async (path: string): Promise<void> => {
    const page = overlay.webContents
    // The page is transparent, so it is photographed against a plain backdrop.
    const backdrop = (colour: string): Promise<unknown> =>
      page.executeJavaScript(`document.documentElement.style.background = '${colour}'`)
    await backdrop('#8d97a3')
    await pause(80)
    await save(page, path, false)
    await backdrop('')
  }

  /** The setup window is created but never shown, so it cannot take focus. */
  const captureHub = async (path: string): Promise<void> => {
    const hub = createHubWindow()
    if (hub.webContents.isLoading()) {
      await new Promise<void>((resolve) => hub.webContents.once('did-finish-load', () => resolve()))
    }
    // Long enough for the page to ask for the status and draw it.
    await pause(700)
    await save(hub.webContents, path, true)
  }

  // What the overlay page logs is otherwise invisible. It never handles transcript text.
  overlay.webContents.on('console-message', (event) => {
    console.log(`[overlay] ${event.message}`)
  })

  let pending = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      try {
        run(line)
      } catch (error) {
        console.error('[debug] command failed:', error instanceof Error ? error.message : error)
      }
    }
  })
  console.log('[debug] control line open')
}
