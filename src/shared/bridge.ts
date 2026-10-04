import type {
  AppStatus,
  CaptureCommand,
  CaptureEvent,
  Microphone,
  OverlaySmokeReport,
  PillAction,
  PillCue,
  PillState,
  SmokeRequest,
} from './ipc'

/** What the overlay preload exposes to the overlay page as `window.flow`. */
export interface OverlayBridge {
  onCaptureCommand(handle: (command: CaptureCommand) => void): void
  sendCaptureEvent(event: CaptureEvent): void
  reportMicrophones(microphones: Microphone[]): void
  onPillState(handle: (state: PillState) => void): void
  onPillCue(handle: (cue: PillCue) => void): void
  sendPillAction(action: PillAction): void
  /** While true the window takes mouse events; otherwise clicks pass through to the app below. */
  setInteractive(interactive: boolean): void
  onSmokeRun(run: (request: SmokeRequest) => void): void
  reportSmoke(report: OverlaySmokeReport): void
}

/** What the hub preload exposes to the hub page as `window.flowHub`. */
export interface HubBridge {
  getStatus(): Promise<AppStatus>
  /** Shows the macOS prompt that leads to the Accessibility setting. */
  requestAccessibility(): Promise<void>
  /** Shows the macOS prompt for the microphone, or opens its settings pane if already denied. */
  requestMicrophone(): Promise<void>
  /** Starts downloading the speech model; progress appears in the status. */
  downloadModel(): Promise<void>
}
