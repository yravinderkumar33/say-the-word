import {
  app,
  nativeImage,
  nativeTheme,
  session,
  systemPreferences,
  type BrowserWindow,
  type WebContents,
} from 'electron'
import { writeFileSync } from 'node:fs'
import type { TrayIconState } from '@shared/icon-shapes'
import {
  HUB_PAGES,
  IPC,
  type CaptureCommand,
  type HistoryEntry,
  type HubPage,
  type PrivacyFacts,
} from '@shared/ipc'
import { wordErrorRate } from '@shared/wer'
import type { Dictation } from './dictation/wire-dictation'
import { NO_TIMINGS } from './history/from-session'
import { STOP_WITHIN_MS, type HistoryRepository } from './storage/storage-host'
import type { MachineEvent } from './hotkeys/session-machine'
import type { SettingsPatch, SettingsStore } from './store/settings'
import type { SttHost } from './stt/stt-host'
import type { Question } from './system/confirm'
import type { OtherDictationApp } from './system/other-dictation-app'
import { createHubWindow } from './windows/hub-window'
import { isOverlayInteractive } from './windows/overlay-window'
import type { AppTray } from './windows/tray'

/**
 * How long the quit that a test's going sets off may take before the app is made to go:
 * longer than quitting waits for the storage process to finish its writes, so that a
 * test that starts again on the same data does not lose them.
 */
const QUIT_HANGS_AFTER_MS = STOP_WITHIN_MS + 2_000

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
 *   own-window <on|off|auto>                  as if one of the app's own windows had the keyboard
 *                                        (a practice in the first run), or as it really is
 *   expect <base64 text>                 the words the test is about to play; texts are
 *                                        scored against them (word error rate)
 *   microphone <device id|default>       what choosing a microphone in the tray does
 *   evaluation <on|off>                  what the tray's "Save every dictation" does
 *   mode <verbatim|cleaned>              what the tray's Mode menu does
 *   ollama-url <url>                     where Cleaned mode looks for Ollama
 *   cleanup-model <name|none>            the model Cleaned mode uses
 *   sweep-history                        delete what is older than the history is kept for, as
 *                                        the hourly sweep does
 *   kill-storage                         end the storage process as a crash would
 *   approach-tray                        what moving the pointer onto the menu-bar icon does
 *   appearance <light|dark|system>       which appearance the windows are drawn in
 *   draw-as <more-contrast|less-transparency|less-motion|usual>
 *                                        draw both pages as they are drawn with that setting of
 *                                        System Settings › Accessibility on; the setting itself
 *                                        is not touched
 *   hover-pill | unhover-pill            rest the pointer on the pill, or take it away again
 *   capture-pill <png path>              save a picture of the pill as it looks right now
 *   capture-hub <png path> [<w>x<h>]     save a picture of the main window, without showing it,
 *                                        at that size if one is given. What was dictated is
 *                                        left out of it, unless a test's recording said it
 *   size-hub <w>x<h>                     give the main window that size, without showing it
 *   check-selection                      select each text of a dictation that is open, and log
 *                                        how many of the words meant for a screen reader only
 *                                        a copy of the selection would carry (a count, no text)
 *   page-request <url>                   ask for an address through the pages' own session, as
 *                                        a page that had lost its content policy could
 *   press-hub <label>                    press the button of the main window with that label
 *                                        (underscores for spaces), if a click can reach it and
 *                                        the button is not switched off
 *   choose-hub <label> <value>           choose in the pop-up of that label (underscores for spaces)
 *   type-hub <label> <base64 text>       type into the field of that label
 *   key-hub <key> [meta|held|meta+held]  press a key where the keyboard is in the main window;
 *                                        `held` makes it a repeat of a key that is kept down
 *   focus-hub <css selector>             put the keyboard on that part of the main window
 *   hub-page <page>                      show a page of the main window, as the menu's Settings… does
 *   capture-tray <png path> [state]      save a picture of the menu-bar icon, in a state if one is given
 *   pause [off]                          what the menu's "Pause Dictation for 1 Hour" does, or Resume
 *   conflict <name|none>                 behave as if this dictation app were running too
 *   answer-dialogs <yes|no>              how the system dialogs that ask before deleting or
 *                                        keeping are answered; they are refused until told
 *   setting <name> <value>               change one of the settings the Settings page changes
 *   pretend-ready <on|off|no-accessibility>
 *                                        behave as if Accessibility and the microphone were granted
 *                                        and the key tap installed: the instance has no tap, and
 *                                        could otherwise never show what a Mac that is ready shows.
 *                                        `no-accessibility`: as if Accessibility had not been
 *                                        granted yet, which the terminal's own grant would hide
 *   first-run <again|done>               show the steps of the first launch again, or end them
 *   first-run-step <step>                show that step of the first launch, whatever the
 *                                        permissions of the Mac the test runs on
 *   add-history <base64 JSON>            add a dictation with the test's own text to the history
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
  /** A setting the pill, the menu or the Dock depends on has changed. */
  settingsChanged(): void
  trayApproached(): void
  settings: SettingsStore
  history: HistoryRepository
  otherApp: OtherDictationApp
  /** The system dialogs' stand-in: what was asked, and how the next one is answered. */
  dialogs: { asked: Question[]; answer: { value: boolean | null } }
  /** What would have reached outside the app (Finder, the browser, the clipboard), by kind. */
  reached: Record<string, number>
  /** What a test has said is so although it is not: that the permissions and the key tap are in place. */
  pretend: { ready: boolean; noAccessibility: boolean }
  /** The menu's status line and icon may have changed. */
  statusChanged(): void
  privacyFacts(): PrivacyFacts
  /** Whether the app is opened at login, as the (pretended) system says. */
  openAtLogin(): boolean | null
  /** What the main window shows of the dictations so far: counts and outcomes, never text. */
  figures(): { wordsToday: number; wordsThisWeek: number; recent: string[] }
}): void {
  const { dictation, stt, overlay, tray, history, settings } = parts
  const { controller, speech, debug } = dictation
  const dispatch = (event: MachineEvent): void => controller.dispatch(event)
  /** As the helper reports a shortcut: one that would start something is ignored while paused. */
  const shortcut = (event: MachineEvent): void => dictation.shortcut(event)
  /** Only the time between a press and its release matters, so any steady clock will do. */
  const now = (): number => performance.now()

  let expected: string | null = null
  const score = (text: string | null): number | null =>
    expected !== null && text ? Number(wordErrorRate(expected, text).toFixed(3)) : null
  /** Every paste made while `quiet-paste` is on: which session, how long, how accurate. */
  const pastes: Array<{ session: number | null; chars: number; wer: number | null }> = []

  /** A path as it is written on the control line, which splits at spaces: one in the path comes as `%20`. */
  const pathOf = (written: string): string => {
    try {
      return decodeURI(written)
    } catch {
      return written
    }
  }

  const run = (line: string): void => {
    const [command, argument, option] = line.trim().split(/\s+/)
    switch (command) {
      case 'press':
        return shortcut({ type: 'pttDown', t: now() })
      case 'release':
        return shortcut({ type: 'pttUp', t: now() })
      case 'hands-free':
        return shortcut({ type: 'handsFreeDown', t: now() })
      case 'stop':
        return dispatch({ type: 'stop' })
      case 'escape':
        return dispatch({ type: 'escape' })
      case 'abort':
        return dispatch({ type: 'abort' })
      case 'paste-last':
        return shortcut({ type: 'pasteLast' })
      case 'copy-last':
        return shortcut({ type: 'copyLast' })
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
      case 'own-window':
        debug.ownWindow = argument === 'on' ? true : argument === 'off' ? false : null
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
      // Then what the app does after the same change made in the window, which asks about
      // Cleaned mode again.
      case 'ollama-url':
        if (argument) parts.changeSettings({ ollamaUrl: argument })
        return parts.settingsChanged()
      case 'cleanup-model':
        parts.changeSettings({ cleanupModel: !argument || argument === 'none' ? null : argument })
        return parts.settingsChanged()
      case 'sweep-history':
        history.sweep()
        return
      case 'kill-storage':
        history.crashWorker()
        return
      case 'approach-tray':
        return parts.trayApproached()
      case 'appearance':
        nativeTheme.themeSource =
          argument === 'light' ? 'light' : argument === 'dark' ? 'dark' : 'system'
        return
      case 'draw-as':
        void drawAs(argument)
        return
      case 'hover-pill':
        void hoverPill()
        return
      case 'unhover-pill':
        overlay.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 })
        return
      case 'capture-pill':
        if (argument) void capturePill(pathOf(argument))
        return
      case 'capture-hub':
        if (argument) void captureHub(pathOf(argument), option)
        return
      case 'size-hub':
        void sizeHub(argument)
        return
      case 'check-selection':
        void checkSelection()
        return
      case 'page-request':
        if (argument) void pageRequest(argument)
        return
      case 'press-hub':
        if (argument) void pressHub(argument.replace(/_/g, ' '))
        return
      case 'capture-tray':
        if (argument) {
          const state = (option as TrayIconState | undefined) ?? tray.iconState
          writeFileSync(pathOf(argument), tray.icon(state).toPNG({ scaleFactor: 2 }))
          console.log(`[debug] captured ${pathOf(argument)}`)
        }
        return
      case 'choose-hub':
        if (argument && option !== undefined) void fillHub(argument.replace(/_/g, ' '), option)
        return
      case 'type-hub':
        if (argument) {
          void fillHub(
            argument.replace(/_/g, ' '),
            Buffer.from(option ?? '', 'base64').toString('utf8'),
          )
        }
        return
      case 'key-hub':
        if (argument) {
          void keyHub(
            argument,
            Boolean(option?.includes('meta')),
            Boolean(option?.includes('held')),
          )
        }
        return
      case 'focus-hub':
        if (argument) void focusHub(line.trim().slice('focus-hub'.length).trim())
        return
      case 'hub-page':
        if (HUB_PAGES.includes(argument as HubPage)) {
          void hubPage().then((hub) => hub.webContents.send(IPC.hubNavigate, argument))
        }
        return
      case 'pause':
        return argument === 'off' ? dictation.pause.end() : dictation.pause.start()
      case 'conflict':
        return parts.otherApp.pretend(
          !argument || argument === 'none' ? null : argument.replace(/_/g, ' '),
        )
      case 'answer-dialogs':
        parts.dialogs.answer.value = argument === 'yes' ? true : argument === 'no' ? false : null
        return
      case 'setting':
        if (argument && option !== undefined) changeSetting(argument, option)
        return
      case 'pretend-ready':
        parts.pretend.ready = argument === 'on'
        parts.pretend.noAccessibility = argument === 'no-accessibility'
        return parts.statusChanged()
      case 'first-run':
        parts.changeSettings({ firstRun: argument === 'again' ? 'pending' : 'done' })
        return
      case 'first-run-step':
        if (argument && /^[a-z]+$/.test(argument)) {
          void hubPage().then((hub) =>
            hub.webContents.executeJavaScript(
              `window.dispatchEvent(new CustomEvent('flow-test-step', { detail: '${argument}' }))`,
            ),
          )
        }
        return
      case 'add-history':
        if (argument) addHistory(argument)
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
        // Said, so that a test that relies on a command since renamed does not go on
        // unaware; by its name only, because what follows a command can be text.
        if (command) {
          const name = /^[a-z][a-z-]{0,39}$/.test(command) ? command : '(not a command name)'
          console.error(`[debug] unknown command: ${name}`)
        }
        return
    }
  }

  /** One of the settings the Settings page changes, by the name a test gives it. */
  const changeSetting = (name: string, value: string): void => {
    const on = value === 'on'
    const patches: Record<string, SettingsPatch> = {
      sounds: { sounds: on },
      'pill-at-rest': { pillAtRest: on },
      'history-paused': { historyPaused: on },
      key: { dictationKey: value === 'ctrlOption' ? 'ctrlOption' : 'fn' },
      'model-keep': {
        modelKeep: value === 'hour' ? 'hour' : value === 'always' ? 'always' : 'tenMinutes',
      },
    }
    const patch = patches[name]
    if (!patch || !parts.changeSettings(patch)) return
    if (patch.historyPaused !== undefined) history.setPaused(patch.historyPaused)
    parts.settingsChanged()
  }

  /** A dictation whose text the test wrote itself: for pictures, and for what a list does with many. */
  let added = 0
  const addHistory = (encoded: string): void => {
    const given = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Partial<
      HistoryEntry & { agoMs: number }
    >
    const written = given.written ?? ''
    history.put({
      id: `test-${++added}`,
      endedAt: Date.now() - (given.agoMs ?? 0),
      app: given.app ?? null,
      outcome: given.outcome ?? 'pasted',
      fetched: given.fetched ?? null,
      mode: given.mode ?? 'verbatim',
      note: given.note ?? null,
      heard: given.heard ?? written,
      written,
      failure: given.failure ?? null,
      audioMs: given.audioMs ?? null,
      timings: given.timings ?? NO_TIMINGS,
    })
  }

  /**
   * What the main window shows, as far as a test may know: its heading, the labels of
   * its buttons and chips, and how many rows it lists. Never what a row says.
   */
  const hubLooks = async (): Promise<unknown> => {
    const hub = await hubPage()
    return hub.webContents
      .executeJavaScript(
        `(() => {
           // A button that holds more than its name (an example sentence, say) names itself.
           const text = (item) =>
             (item.dataset.name ?? item.getAttribute('aria-label') ?? item.textContent ?? '').trim()
           // What is drawn, and only that: the History list is kept, undrawn, while one of
           // its dictations is open over it.
           const shown = (item) => item.getClientRects().length > 0
           const all = (selector) => [...document.querySelectorAll(selector)].filter(shown)
           return {
             heading: all('h1')[0]?.textContent?.trim() ?? null,
             // A row is a button too, and what it says is what was dictated: left out.
             buttons: all('button:not([data-row])').map(text),
             chips: all('[data-chip]').map((item) => item.textContent.trim()),
             notices: all('[data-notice]').map((item) => item.dataset.notice),
             rows: all('[data-row]').length,
             selected: all('[data-row][aria-selected="true"]')[0]?.dataset.row ?? null,
             steps: all('[data-step]').map((item) => item.dataset.step + ':' + item.dataset.stepState),
             ticks: all('[data-done="true"]').length,
             // Where the keyboard is: by name, never by content. A row holds what was dictated.
             focus: (() => {
               const active = document.activeElement
               if (!active || active === document.body) return null
               if (active.closest('[data-row]')) return 'row'
               return (
                 active.dataset.name ?? active.getAttribute('aria-label') ?? active.tagName.toLowerCase()
               )
             })(),
             // The options that are chosen, by name: of a group of which one is.
             checked: all('[role="radio"][aria-checked="true"]').map(
               (item) => item.dataset.name ?? item.getAttribute('aria-label') ?? item.textContent.trim(),
             ),
           }
         })()`,
      )
      .catch(() => null)
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
        trayStatus: tray.statusLine,
        trayIcon: tray.iconState,
        // How many dictations the Recent menu offers. Never what they say.
        trayRecent: tray.state.recent.filter((row) => row.text.length > 0).length,
        namedMicrophones: tray.state.microphones.filter((item) => item.label !== '').length,
        // The first of the order of preference, as it is saved.
        chosenMicrophone: settings.get().microphoneOrder[0]?.deviceId ?? null,
        paused: dictation.pause.active,
        practice: dictation.practice(),
        history: {
          count: history.count,
          keep: history.keep,
          paused: history.paused,
          onDisk: history.onDisk,
          bytes: history.bytesOnDisk(),
          // Days' files on disk that are not listed: left by a setting that could not be read.
          left: history.leftOnDisk,
          diskProblem: history.diskProblem,
          // Dictations held in memory that went with a storage process that stopped.
          lost: history.summary().lost ?? 0,
          newest: history.newest(5).map((row) => ({
            outcome: row.outcome,
            fetched: row.fetched,
            mode: row.mode,
            app: row.app,
            hasText: row.text.length > 0,
          })),
        },
        // The system dialogs that were put, by kind, and what would have left the app.
        asked: parts.dialogs.asked.map((question) => question.kind),
        reached: parts.reached,
        privacy: privacySummary(),
        hub: await hubLooks(),
        prefs: {
          sounds: settings.get().sounds,
          pillAtRest: settings.get().pillAtRest,
          key: settings.get().dictationKey,
          modelKeep: settings.get().modelKeep,
          ollamaUrl: settings.get().ollamaUrl,
          firstRun: settings.get().firstRun ?? null,
          cleanupModel: settings.get().cleanupModel,
          openAtLogin: parts.openAtLogin(),
        },
        evaluationRecording: tray.state.evaluationRecording,
        mode: tray.state.mode,
        cleanup: tray.state.cleanup,
        pill: await pillState(),
        // How the pill is drawn: its shape, the mark for text left waiting, and whether
        // Cancel is on offer.
        ...(await pillLooks()),
        // What the menu-bar menu offers beside the pill.
        trayOffer: tray.state.offer,
        trayHandsFree: tray.state.handsFree,
        // The menu as it was built for the state it was told, by label: what a person opening it sees.
        trayItems: tray.itemLabels,
        figures: parts.figures(),
        // True when the pill shows the hands-free buttons.
        pillHandsFree: await overlay.webContents
          .executeJavaScript(`document.querySelector('.pill')?.dataset.handsFree === 'true'`)
          .catch(() => false),
        // True only while the pointer is over a pill button; otherwise clicks pass through.
        overlayTakesClicks: isOverlayInteractive(overlay),
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

  /** The Privacy page's facts: hosts, counts and sizes. */
  const privacySummary = (): unknown => {
    const facts = parts.privacyFacts()
    return {
      contacted: facts.contacted.map(
        (contact) => `${contact.what}:${contact.host}:${contact.answered ? 'answered' : 'tried'}`,
      ),
      recordings: facts.recordings.count,
      countsBytes: facts.counts.bytes,
      problem: facts.problem,
    }
  }

  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** What the pill is showing, read from the page itself. */
  const pillState = (): Promise<string | null> =>
    overlay.webContents
      .executeJavaScript(`document.querySelector('.pill')?.dataset.state ?? null`)
      .catch(() => null) as Promise<string | null>

  const pillLooks = (): Promise<{ pillShape: string | null }> =>
    overlay.webContents
      .executeJavaScript(
        `(() => {
           const pill = document.querySelector('.pill')
           return {
             pillShape: pill?.dataset.shape ?? null,
             pillWaiting: pill?.dataset.waiting === 'true',
             pillCancel: Boolean(pill?.querySelector('[aria-label="Cancel"]')),
           }
         })()`,
      )
      .catch(() => ({ pillShape: null })) as Promise<{ pillShape: string | null }>

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

    // A button may not be there yet: Cancel is offered only once the text has taken a
    // second to arrive. A hand would wait for it too.
    let centre = await find()
    for (let tries = 0; !centre && tries < 30; tries++) {
      await pause(100)
      centre = await find()
    }
    // The pill changes size with an animation, and a button rides along with it. Wait
    // until the button has stopped moving, as a hand would, or the click lands beside it.
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
  /** Puts the pointer on the pill and leaves it there, as a hand that has stopped moving. */
  const hoverPill = async (): Promise<void> => {
    const centre = (await overlay.webContents
      .executeJavaScript(
        `(() => {
           const box = document.querySelector('.pill')?.getBoundingClientRect()
           return box ? { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) } : null
         })()`,
      )
      .catch(() => null)) as { x: number; y: number } | null
    if (centre) overlay.webContents.sendInputEvent({ type: 'mouseMove', ...centre })
  }

  const save = async (page: WebContents, path: string, stayHidden: boolean): Promise<void> => {
    const image = await page.capturePage(undefined, { stayHidden })
    writeFileSync(path, image.toPNG())
    console.log(`[debug] captured ${path}`)
  }

  /**
   * A picture of the overlay page alone, on a plain backdrop: nothing else on the screen
   * is in it. The page is transparent, and the backdrop is put behind the pill in the
   * picture, not in the window. The window is on the screen, above the Dock: painted grey
   * for every picture, it would be seen by whoever is at the Mac.
   */
  const capturePill = async (path: string): Promise<void> => {
    const image = await overlay.webContents.capturePage()
    const scale = image.getScaleFactors()[0] ?? 1
    const size = image.getSize(scale)
    const width = Math.round(size.width * scale)
    const height = Math.round(size.height * scale)
    const pixels = image.toBitmap({ scaleFactor: scale })
    if (pixels.length !== width * height * 4) {
      // Not the layout that is expected: saved as it is, on nothing, and not guessed at.
      writeFileSync(path, image.toPNG())
      console.log(`[debug] captured ${path}`)
      return
    }
    // Four bytes to a point: blue, green, red and how solid it is, the colours already
    // scaled by that. What shows through is the backdrop.
    const backdrop = [0xa3, 0x97, 0x8d]
    for (let at = 0; at < pixels.length; at += 4) {
      const through = 255 - (pixels[at + 3] ?? 255)
      for (const [channel, colour] of backdrop.entries()) {
        pixels[at + channel] = Math.min(
          255,
          (pixels[at + channel] ?? 0) + Math.round((colour * through) / 255),
        )
      }
      pixels[at + 3] = 255
    }
    const onBackdrop = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: scale })
    writeFileSync(path, onBackdrop.toPNG({ scaleFactor: scale }))
    console.log(`[debug] captured ${path}`)
  }

  /** The main window, created if need be and never shown, once its page has loaded. */
  const hubPage = async (): Promise<BrowserWindow> => {
    const hub = createHubWindow()
    if (hub.webContents.isLoading()) {
      await new Promise<void>((resolve) => hub.webContents.once('did-finish-load', () => resolve()))
    }
    return hub
  }

  /**
   * Draws the pill and the main window the way they are drawn with Increase Contrast,
   * Reduce Transparency or Reduce Motion on. The Mac's own setting is the user's and is
   * left alone: each page is told through the protocol of the developer tools, which
   * only an instance under test attaches.
   */
  const drawAs = async (setting: string | undefined): Promise<void> => {
    const features = [
      { name: 'prefers-contrast', value: setting === 'more-contrast' ? 'more' : '' },
      {
        name: 'prefers-reduced-transparency',
        value: setting === 'less-transparency' ? 'reduce' : '',
      },
      { name: 'prefers-reduced-motion', value: setting === 'less-motion' ? 'reduce' : '' },
    ]
    const hub = await hubPage()
    for (const page of [overlay.webContents, hub.webContents]) {
      try {
        if (!page.debugger.isAttached()) page.debugger.attach('1.3')
        await page.debugger.sendCommand('Emulation.setEmulatedMedia', { features })
      } catch (error) {
        console.log(`[debug] draw-as failed: ${error instanceof Error ? error.message : error}`)
        return
      }
    }
    console.log(`[debug] drawn as ${setting ?? 'usual'}`)
  }

  /** The main window at a size, as it is when someone has made it smaller. It stays hidden. */
  const sizeHub = async (size: string | undefined): Promise<void> => {
    const hub = await hubPage()
    const [width, height] = (size ?? '').split('x').map(Number)
    if (width && height) hub.setContentSize(width, height)
    console.log(`[debug] hub size: ${hub.getContentSize().join('x')}`)
  }

  /**
   * Selects each text of an opened dictation as a triple-click would, and counts the
   * words meant for a screen reader only that a copy of the selection would carry.
   * Logged as a number: what the texts say stays in the page.
   */
  const checkSelection = async (): Promise<void> => {
    const hub = await hubPage()
    const carried = (await hub.webContents
      .executeJavaScript(
        `(() => {
           let carried = 0
           let texts = 0
           for (const block of document.querySelectorAll('[data-said]')) {
             // Only what is drawn: the list behind an opened dictation is kept, and not shown.
             if (block.getClientRects().length === 0) continue
             const spoken = [...block.querySelectorAll('.only-spoken')].map((item) => item.textContent ?? '')
             const range = document.createRange()
             range.selectNodeContents(block)
             const selection = getSelection()
             selection.removeAllRanges()
             selection.addRange(range)
             const copied = selection.toString()
             selection.removeAllRanges()
             texts += 1
             carried += spoken.filter((words) => words && copied.includes(words)).length
           }
           return texts + ' texts, ' + carried + ' spoken-only'
         })()`,
      )
      .catch(() => 'failed')) as string
    console.log(`[debug] selection: ${carried}`)
  }

  /** A request in the session the pages use, which is where a page's own would be made. */
  const pageRequest = async (url: string): Promise<void> => {
    const outcome = await session.defaultSession.fetch(url).then(
      () => 'answered',
      () => 'refused',
    )
    console.log(`[debug] page request: ${outcome}`)
  }

  const captureHub = async (path: string, size?: string): Promise<void> => {
    const hub = await hubPage()
    const [width, height] = (size ?? '').split('x').map(Number)
    if (width && height) hub.setContentSize(width, height)
    // Long enough for the page to ask for the status and draw it.
    await pause(700)
    // The window lists the last dictations. With a real microphone those are what
    // someone said, and no picture is made of that: the words are left blank.
    const spoken = !process.env['WHISPER_FLOW_FAKE_MIC']
    const blank = spoken
      ? await hub.webContents.insertCSS('[data-said] { visibility: hidden !important; }')
      : null
    try {
      await save(hub.webContents, path, true)
    } finally {
      if (blank) await hub.webContents.removeInsertedCSS(blank)
    }
  }

  /**
   * Presses a button of the main window as a click would: only if the button is what
   * lies topmost at its own centre. A button with something lying over it is reported
   * as covered, and is not pressed.
   */
  const pressHub = async (label: string): Promise<void> => {
    const hub = await hubPage()
    const outcome = (await hub.webContents
      .executeJavaScript(
        `(() => {
           const label = ${JSON.stringify(label)}
           // Among what is drawn: a button of a page that is kept but not shown is not there to press.
           const button = [...document.querySelectorAll('button, [role="radio"], [role="switch"]')].find(
             (item) =>
               item.getClientRects().length > 0 &&
               (item.dataset.name === label ||
                 (item.getAttribute('aria-label') ?? '') === label ||
                 item.textContent.trim() === label),
           )
           if (!button) return 'missing'
           if (button.disabled) return 'disabled'
           // Brought into view first, as a hand would scroll to it: below the edge of the
           // window there is nothing under the pointer at all.
           button.scrollIntoView({ block: 'nearest' })
           const box = button.getBoundingClientRect()
           const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
           if (top !== button && !button.contains(top)) return 'covered'
           button.click()
           return 'pressed'
         })()`,
      )
      .catch(() => 'missing')) as string
    console.log(`[debug] hub button "${label}": ${outcome}`)
  }

  /**
   * Sets a pop-up or a text field of the main window, found by its label, the way a
   * hand would: the page hears of it through the same events.
   */
  const fillHub = async (label: string, value: string): Promise<void> => {
    const hub = await hubPage()
    const outcome = (await hub.webContents
      .executeJavaScript(
        `(() => {
           const label = ${JSON.stringify(label)}
           const value = ${JSON.stringify(value)}
           const field = [...document.querySelectorAll('select, input, textarea')].find(
             (item) => item.getClientRects().length > 0 && item.getAttribute('aria-label') === label,
           )
           if (!field) return 'missing'
           const proto = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype
             : field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
             : HTMLInputElement.prototype
           Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, value)
           field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
           return 'set'
         })()`,
      )
      .catch(() => 'missing')) as string
    console.log(`[debug] hub field "${label}": ${outcome}`)
  }

  /**
   * Presses a key where the keyboard is in the main window. `held`: one of the repeats of
   * a key that is kept down.
   */
  const keyHub = async (key: string, meta: boolean, held: boolean): Promise<void> => {
    const hub = await hubPage()
    await hub.webContents
      .executeJavaScript(
        `(() => {
           const target = document.activeElement ?? document.body
           target.dispatchEvent(new KeyboardEvent('keydown', {
             key: ${JSON.stringify(key)}, metaKey: ${meta}, repeat: ${held},
             bubbles: true, cancelable: true,
           }))
         })()`,
      )
      .catch(() => {})
    console.log(`[debug] hub key "${key}"`)
  }

  const focusHub = async (selector: string): Promise<void> => {
    const hub = await hubPage()
    const found = (await hub.webContents
      .executeJavaScript(
        `(() => {
           const target = document.querySelector(${JSON.stringify(selector)})
           target?.focus()
           return Boolean(target)
         })()`,
      )
      .catch(() => false)) as boolean
    console.log(`[debug] hub focus "${selector}": ${found ? 'set' : 'missing'}`)
  }

  // What the overlay page logs is otherwise invisible. It never handles transcript text.
  overlay.webContents.on('console-message', (event) => {
    console.log(`[overlay] ${event.message}`)
  })

  // The test that opened this line has gone, because it ended or because it died: the
  // app it started goes with it. Left running, it would hold the helper's binary and the
  // build's files, and the next build would be made under it.
  let over = false
  const testHasGone = (): void => {
    if (over) return
    over = true
    app.quit()
    // A quit that hangs is not waited for.
    setTimeout(() => app.exit(0), QUIT_HANGS_AFTER_MS).unref()
  }
  process.stdin.on('end', testHasGone)
  process.stdin.on('close', testHasGone)
  // What the app says goes to the test through pipes. A line that cannot be written
  // because nobody is reading is nobody's loss, and must not become an error of the app.
  process.stdout.on('error', () => {})
  process.stderr.on('error', () => {})

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
