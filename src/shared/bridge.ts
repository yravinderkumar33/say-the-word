import type {
  AppStatus,
  CaptureCommand,
  CaptureEvent,
  ChangeResult,
  CleanupFacts,
  DictationMode,
  ExternalLink,
  HistoryEntry,
  HistoryKeep,
  HistoryPage,
  HistoryQuery,
  HubPage,
  Microphone,
  ModelChoiceResult,
  OverlayPrefs,
  OverlaySmokeReport,
  PillAction,
  PillCue,
  PillState,
  PreferencePatch,
  PrivacyFacts,
  SmokeRequest,
  StoredKind,
  TryResult,
} from './ipc'

/** What the overlay preload exposes to the overlay page as `window.flow`. */
export interface OverlayBridge {
  onCaptureCommand(handle: (command: CaptureCommand) => void): void
  sendCaptureEvent(event: CaptureEvent): void
  reportMicrophones(microphones: Microphone[]): void
  /** The main process asks for the microphones to be listed again. */
  onListMicrophones(handle: () => void): void
  onPillState(handle: (state: PillState) => void): void
  onPillCue(handle: (cue: PillCue) => void): void
  /** The settings the overlay acts on: whether to play sounds, whether to draw the pill at rest. */
  onPrefs(handle: (prefs: OverlayPrefs) => void): void
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
  /** Stops the download. What has arrived is kept, and the next download resumes from it. */
  cancelDownload(): Promise<void>
  /** Checks the model's files, fetches any that are damaged, and loads the model again. */
  repairModel(): Promise<void>
  /** Switches "Save every dictation" off. Switching it on is done in the menu only. */
  stopSavingDictations(): Promise<void>
  /** Verbatim or Cleaned. A change that cannot be saved is not made, and the status says so. */
  setMode(mode: DictationMode): Promise<void>
  /** The microphone to use, by its device id; null follows the system default. */
  chooseMicrophone(deviceId: string | null): Promise<void>
  /** The order of preference among microphones, by device id. Empty follows the system default. */
  setMicrophoneOrder(deviceIds: string[]): Promise<void>
  /** Opens one of the pages the app knows of in the browser. The page names the kind, never an address. */
  openLink(link: ExternalLink): Promise<void>
  /** Changes a setting. The answer says whether it was made and, if not, why. */
  changePreference(patch: PreferencePatch): Promise<ChangeResult>
  setOpenAtLogin(on: boolean): Promise<void>
  /** Switches the shortcuts on again before the hour of a pause is over. */
  resumeDictation(): Promise<void>
  showLog(): Promise<void>
  /** Puts a description of the setup on the clipboard: versions, permissions, settings. Never what was said. */
  copyDiagnostics(): Promise<void>
  /** Calls back with what the pill shows, as it changes. Returns the way to stop. */
  onPill(handle: (state: PillState) => void): () => void
  /** Calls back while Delete Everything runs, so that a page drops what it holds. Returns the way to stop. */
  onPrivacyReset(handle: () => void): () => void
  /** Calls back when the menu asks for a page of the window to be shown. Returns the way to stop. */
  onNavigate(handle: (page: HubPage) => void): () => void

  getHistory(query: HistoryQuery): Promise<HistoryPage>
  getHistoryEntry(id: string): Promise<HistoryEntry | null>
  /** Puts a dictation's text on the clipboard: what was written, or what was heard. */
  copyHistoryEntry(id: string, which: 'written' | 'heard'): Promise<boolean>
  deleteHistoryEntry(id: string): Promise<void>
  /** Deletes every dictation, if the system dialog that asks is answered with yes. */
  deleteAllHistory(): Promise<boolean>
  /** How long dictations are kept. A system dialog asks first; false when it was answered with no. */
  setHistoryKeep(keep: HistoryKeep): Promise<boolean>
  /** Shows a row's menu. Copy and Delete are done there; `open` is for the page to do. */
  historyMenu(id: string): Promise<'open' | null>

  getCleanupFacts(): Promise<CleanupFacts>
  /** The model Cleaned mode uses; null for the rules only. */
  chooseCleanupModel(name: string | null): Promise<ModelChoiceResult>
  startOllama(): Promise<void>
  tryCleanup(text: string): Promise<TryResult>

  getPrivacyFacts(): Promise<PrivacyFacts>
  revealStored(kind: StoredKind): Promise<void>
  /** Deletes one kind of stored thing, or everything, if the system dialog is answered with yes. */
  deleteStored(kind: StoredKind | 'everything'): Promise<PrivacyFacts>

  /** The first run is over: the window closes, and the app opens at login if that was chosen. */
  finishFirstRun(openAtLogin: boolean): Promise<void>
  showFirstRunAgain(): Promise<void>
}
