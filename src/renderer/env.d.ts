/// <reference types="vite/client" />

import type { HubBridge, OverlayBridge } from '@shared/bridge'

declare global {
  interface Window {
    /** Present in the overlay window only. */
    flow: OverlayBridge
    /** Present in the hub window only. */
    flowHub: HubBridge
  }
}
