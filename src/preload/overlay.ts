import { contextBridge, ipcRenderer } from 'electron'
import type { OverlayBridge } from '@shared/bridge'
import type { CaptureCommand, OverlayPrefs, PillCue, PillState, SmokeRequest } from '@shared/ipc'
import { IPC } from '@shared/ipc-channels'

// A MessagePort cannot pass through contextBridge, so the port to the speech worker
// is handed to the page with window.postMessage, addressed to our own origin only.
ipcRenderer.on(IPC.sttPort, (event) => {
  window.postMessage({ channel: IPC.sttPort }, window.location.origin, event.ports)
})

const bridge: OverlayBridge = {
  onCaptureCommand(handle) {
    ipcRenderer.on(IPC.captureCommand, (_event, command: CaptureCommand) => handle(command))
  },
  sendCaptureEvent(event) {
    ipcRenderer.send(IPC.captureEvent, event)
  },
  reportMicrophones(microphones) {
    ipcRenderer.send(IPC.microphones, microphones)
  },
  onListMicrophones(handle) {
    ipcRenderer.on(IPC.listMicrophones, () => handle())
  },
  onPillState(handle) {
    ipcRenderer.on(IPC.pillState, (_event, state: PillState) => handle(state))
  },
  onPillCue(handle) {
    ipcRenderer.on(IPC.pillCue, (_event, cue: PillCue) => handle(cue))
  },
  onPrefs(handle) {
    ipcRenderer.on(IPC.overlayPrefs, (_event, prefs: OverlayPrefs) => handle(prefs))
  },
  sendPillAction(action) {
    ipcRenderer.send(IPC.pillAction, action)
  },
  setInteractive(interactive) {
    ipcRenderer.send(IPC.overlayInteractive, interactive)
  },
  onSmokeRun(run) {
    ipcRenderer.on(IPC.smokeRun, (_event, request: SmokeRequest) => run(request))
  },
  reportSmoke(report) {
    ipcRenderer.send(IPC.smokeReport, report)
  },
}

contextBridge.exposeInMainWorld('flow', bridge)
