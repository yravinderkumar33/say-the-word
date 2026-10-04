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
} as const
