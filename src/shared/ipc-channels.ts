/**
 * Channel names shared by main, preloads and renderers.
 *
 * They live in a module of their own, with no imports, so that a preload script can
 * use them without the message schemas (and the validation library behind them) being
 * bundled into it.
 */
export const IPC = {
  /** main → overlay: delivers the MessagePort that leads to the speech worker. */
  sttPort: 'stt:port',
  /** main → overlay: run the renderer half of the smoke check. */
  smokeRun: 'smoke:run',
  /** overlay → main: result of the renderer half of the smoke check. */
  smokeReport: 'smoke:report',
  /** main → overlay: start, stop or cancel microphone capture for a session. */
  captureCommand: 'capture:command',
  /** overlay → main: what happened to a capture. */
  captureEvent: 'capture:event',
  /** overlay → main: the microphones the system offers. */
  microphones: 'capture:microphones',
  /** main → overlay: list the microphones again (the permission has just been granted). */
  listMicrophones: 'capture:list-microphones',
  /** main → overlay: what the pill should show. */
  pillState: 'pill:state',
  /** main → overlay: a brief signal that does not change what the pill shows. */
  pillCue: 'pill:cue',
  /** overlay → main: the user clicked an action on the pill. */
  pillAction: 'pill:action',
  /** overlay → main: whether the window should take mouse events or let them through. */
  overlayInteractive: 'overlay:interactive',
  /** hub → main (invoke): current status of the app's parts. */
  appStatus: 'app:status',
  /** hub → main (invoke): show the macOS prompt for the Accessibility permission. */
  requestAccessibility: 'app:request-accessibility',
  /** hub → main (invoke): show the macOS prompt for the Microphone permission. */
  requestMicrophone: 'app:request-microphone',
  /** hub → main (invoke): download the speech model. */
  downloadModel: 'app:download-model',
  /** hub → main (invoke): stop the download that is under way. */
  cancelDownload: 'app:cancel-download',
  /** hub → main (invoke): check the model's files, fetch what is damaged, and load it again. */
  repairModel: 'app:repair-model',
  /** hub → main (invoke): stop writing dictations to disk. There is no channel that starts it. */
  stopSavingDictations: 'app:stop-saving-dictations',
  /** hub → main (invoke): switch between Verbatim and Cleaned. */
  setMode: 'app:set-mode',
  /** hub → main (invoke): choose the microphone, or the system default. */
  chooseMicrophone: 'app:choose-microphone',
  /** hub → main (invoke): open the "Buy me a coffee" page in the browser. The page names no address. */
  /** main → overlay: the settings the overlay acts on (sounds, the pill at rest, the key). */
  overlayPrefs: 'overlay:prefs',
  /** main → hub: what the pill shows, for the page that teaches what it says. */
  hubPill: 'hub:pill',
  /** main → hub: show this page (the menu's "Settings…", for one). */
  hubNavigate: 'hub:navigate',
  /** main → hub: Delete Everything is under way or done: the window lets go of what it shows. */
  privacyReset: 'hub:privacy-reset',
  /** hub → main (invoke): change one of the settings a page may change. */
  changePreference: 'app:change-preference',
  /** hub → main (invoke): the order of preference among microphones, by device id. */
  setMicrophoneOrder: 'app:set-microphone-order',
  /** hub → main (invoke): open the app when the user logs in, or not. */
  setOpenAtLogin: 'app:set-open-at-login',
  /** hub → main (invoke): switch every shortcut off for an hour. */
  /** hub → main (invoke): switch the shortcuts on again before the hour is up. */
  resumeDictation: 'app:resume-dictation',
  /** hub → main (invoke): open a page in the browser. The kind is named, never the address. */
  openLink: 'app:open-link',
  /** hub → main (invoke): show the log file in Finder. */
  showLog: 'app:show-log',
  /** hub → main (invoke): put a description of the setup on the clipboard. Never what was said. */
  copyDiagnostics: 'app:copy-diagnostics',
  /** hub → main (invoke): the dictations kept, newest first. */
  historyList: 'history:list',
  /** hub → main (invoke): one dictation in full. */
  historyEntry: 'history:entry',
  /** hub → main (invoke): put a dictation's text on the clipboard. The page names it; it sends no text. */
  historyCopy: 'history:copy',
  /** hub → main (invoke): delete one dictation, by its id. */
  historyDelete: 'history:delete',
  /** hub → main (invoke): delete every dictation, after a system dialog has asked. */
  historyDeleteAll: 'history:delete-all',
  /** hub → main (invoke): how long dictations are kept. Keeping them on disk is asked in a system dialog. */
  historySetKeep: 'history:set-keep',
  /** hub → main (invoke): the menu of a row, shown by the system. */
  historyMenu: 'history:menu',
  /** hub → main (invoke): Ollama's state and the models that run on this Mac. */
  cleanupFacts: 'cleanup:facts',
  /** hub → main (invoke): the model Cleaned mode uses, or none for the rules only. */
  cleanupChooseModel: 'cleanup:choose-model',
  /** hub → main (invoke): start Ollama, where it is installed. */
  cleanupStartOllama: 'cleanup:start-ollama',
  /** hub → main (invoke): one sentence as Verbatim, with the rules only, and Cleaned. */
  cleanupTry: 'cleanup:try',
  /** hub → main (invoke): what is stored and what has been contacted. */
  privacyFacts: 'privacy:facts',
  /** hub → main (invoke): show one kind of stored thing in Finder. */
  privacyReveal: 'privacy:reveal',
  /** hub → main (invoke): delete one kind of stored thing, or all, after a system dialog has asked. */
  privacyDelete: 'privacy:delete',
  /** hub → main (invoke): the first run is done; the window closes. */
  firstRunFinish: 'first-run:finish',
  /** hub → main (invoke): go through the first run again. */
  firstRunAgain: 'first-run:again',
} as const
