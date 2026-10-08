import type { AppStatus, HistoryEntry, HistoryRow } from '@shared/ipc'

export type StatusChange = {
  helper?: Partial<AppStatus['helper']>
  speech?: Partial<AppStatus['speech']>
  history?: Partial<AppStatus['history']>
  preferences?: Partial<AppStatus['preferences']>
} & Partial<Omit<AppStatus, 'helper' | 'speech' | 'history' | 'preferences'>>

/** A Mac on which everything is in place. Each test takes one thing away. */
export function status(change: StatusChange = {}): AppStatus {
  const { helper, speech, history, preferences, ...rest } = change
  return {
    versions: { app: '0.0.1', electron: '44', node: '24', chrome: '140' },
    packaged: true,
    helper: {
      running: true,
      protocol: 3,
      accessibilityTrusted: true,
      tapInstalled: true,
      ...helper,
    },
    speech: {
      state: 'ready',
      modelDownloaded: true,
      modelLabel: 'Parakeet v3',
      modelLicence: 'Parakeet: CC-BY-4.0 (NVIDIA). Silero VAD: MIT.',
      modelBytes: 671_122_626,
      modelLanguages: 25,
      engine: 'parakeet-tdt-0.6b-v3-int8',
      downloadProgress: null,
      downloadError: null,
      ...speech,
    },
    microphone: 'granted',
    savingDictations: false,
    mode: 'verbatim',
    cleanup: '',
    ollamaInstalled: false,
    microphones: [],
    microphoneOrder: [],
    microphoneInUse: null,
    dictationKey: 'fn',
    pausedUntil: null,
    conflict: null,
    firstRun: null,
    recent: [],
    history: {
      keep: 'session',
      paused: false,
      count: 0,
      version: 0,
      diskProblem: false,
      leftOnDisk: 0,
      ...history,
    },
    practice: { hold: 0, handsFree: 0, undo: 0 },
    usage: { wordsToday: 0, wordsThisWeek: 0, typicalMs: null },
    preferences: {
      sounds: true,
      soundVolume: 0.45,
      pillAtRest: true,
      showInDock: false,
      openAtLogin: false,
      modelKeep: 'tenMinutes',
      ollamaUrl: 'http://127.0.0.1:11434',
      ...preferences,
    },
    supportHost: null,
    links: { source: false, issues: false },
    ...rest,
  }
}

/** A dictation that was pasted into Slack at 10:42 on 4 October 2026. */
export function entry(change: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'a-1',
    endedAt: new Date(2026, 9, 4, 10, 42).getTime(),
    app: 'Slack',
    outcome: 'pasted',
    fetched: null,
    mode: 'verbatim',
    note: null,
    heard: 'Can we move the review to Thursday?',
    written: 'Can we move the review to Thursday?',
    failure: null,
    audioMs: 6_000,
    timings: { releaseToTextMs: 390, tidyMs: null, pasteMs: 40 },
    ...change,
  }
}

/** The same dictation as a row of the list. */
export function row(change: Partial<HistoryRow> = {}): HistoryRow {
  return {
    id: 'a-1',
    endedAt: new Date(2026, 9, 4, 10, 42).getTime(),
    app: 'Slack',
    text: 'Can we move the review to Thursday?',
    outcome: 'pasted',
    fetched: null,
    mode: 'verbatim',
    note: null,
    failure: null,
    ...change,
  }
}
