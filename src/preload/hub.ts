import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HubBridge } from '@shared/bridge'
import type { HubPage, PillState } from '@shared/ipc'
import { IPC } from '@shared/ipc-channels'

/** Asks the main process, and hands back what it answers. */
const ask =
  <Answer>(channel: string) =>
  (...payload: unknown[]): Promise<Answer> =>
    ipcRenderer.invoke(channel, ...payload) as Promise<Answer>

// The menu can ask for a page before the window's own script is listening (the window
// has only just been made). The request is kept here until it is.
let showPage: ((page: HubPage) => void) | null = null
let pageAskedFor: HubPage | null = null
ipcRenderer.on(IPC.hubNavigate, (_event: IpcRendererEvent, page: HubPage) => {
  if (showPage) showPage(page)
  else pageAskedFor = page
})

const bridge: HubBridge = {
  getStatus: ask(IPC.appStatus),
  requestAccessibility: ask(IPC.requestAccessibility),
  requestMicrophone: ask(IPC.requestMicrophone),
  downloadModel: ask(IPC.downloadModel),
  cancelDownload: ask(IPC.cancelDownload),
  repairModel: ask(IPC.repairModel),
  stopSavingDictations: ask(IPC.stopSavingDictations),
  setMode: ask(IPC.setMode),
  chooseMicrophone: ask(IPC.chooseMicrophone),
  setMicrophoneOrder: ask(IPC.setMicrophoneOrder),
  openLink: ask(IPC.openLink),
  changePreference: ask(IPC.changePreference),
  setOpenAtLogin: ask(IPC.setOpenAtLogin),
  resumeDictation: ask(IPC.resumeDictation),
  showLog: ask(IPC.showLog),
  copyDiagnostics: ask(IPC.copyDiagnostics),
  onPill(handle) {
    const listener = (_event: IpcRendererEvent, state: PillState): void => handle(state)
    ipcRenderer.on(IPC.hubPill, listener)
    return () => ipcRenderer.removeListener(IPC.hubPill, listener)
  },
  onPrivacyReset(handle) {
    // The page is told, and given nothing: the IPC event would hand it `ipcRenderer` itself.
    const listener = (): void => handle()
    ipcRenderer.on(IPC.privacyReset, listener)
    return () => ipcRenderer.removeListener(IPC.privacyReset, listener)
  },
  onNavigate(handle) {
    showPage = handle
    // Asked for before the page was listening: shown now.
    if (pageAskedFor) handle(pageAskedFor)
    pageAskedFor = null
    return () => {
      if (showPage === handle) showPage = null
    }
  },

  getHistory: ask(IPC.historyList),
  getHistoryEntry: ask(IPC.historyEntry),
  copyHistoryEntry: (id, which) => ipcRenderer.invoke(IPC.historyCopy, { id, which }),
  deleteHistoryEntry: ask(IPC.historyDelete),
  deleteAllHistory: ask(IPC.historyDeleteAll),
  setHistoryKeep: ask(IPC.historySetKeep),
  historyMenu: ask(IPC.historyMenu),

  getCleanupFacts: ask(IPC.cleanupFacts),
  chooseCleanupModel: ask(IPC.cleanupChooseModel),
  startOllama: ask(IPC.cleanupStartOllama),
  tryCleanup: ask(IPC.cleanupTry),

  getPrivacyFacts: ask(IPC.privacyFacts),
  revealStored: ask(IPC.privacyReveal),
  deleteStored: ask(IPC.privacyDelete),

  finishFirstRun: ask(IPC.firstRunFinish),
  showFirstRunAgain: ask(IPC.firstRunAgain),
}

contextBridge.exposeInMainWorld('flowHub', bridge)
