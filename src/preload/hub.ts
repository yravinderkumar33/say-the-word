import { contextBridge, ipcRenderer } from 'electron'
import type { HubBridge } from '@shared/bridge'
import type { AppStatus } from '@shared/ipc'
import { IPC } from '@shared/ipc-channels'

const bridge: HubBridge = {
  getStatus: () => ipcRenderer.invoke(IPC.appStatus) as Promise<AppStatus>,
  requestAccessibility: () => ipcRenderer.invoke(IPC.requestAccessibility) as Promise<void>,
  requestMicrophone: () => ipcRenderer.invoke(IPC.requestMicrophone) as Promise<void>,
  downloadModel: () => ipcRenderer.invoke(IPC.downloadModel) as Promise<void>,
}

contextBridge.exposeInMainWorld('flowHub', bridge)
