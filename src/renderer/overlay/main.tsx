import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { MicCapture, openMicrophoneCount } from './capture/mic-capture'
import { Pill } from './Pill'
import { acceptsClicks, initPillStore, setLevel, setMicrophone } from './pill-store'
import { registerSmoke } from './smoke'
import { listenForSttPort } from './stt-port'

const capture = new MicCapture({
  onLevel: setLevel,
  onEvent: (event) => window.flow.sendCaptureEvent(event),
})

listenForSttPort((port) => capture.attachPort(port))
// For the automated tests, which check that the microphone is let go after every session,
// and that a recording is not held longer than the offer to use it.
Object.assign(window, {
  flowOpenMicrophones: openMicrophoneCount,
  flowHoldsRecording: () => capture.holdsRecording,
  // A test's click must wait as a hand would: see `CLICK_GUARD_MS`.
  flowPillAcceptsClicks: () => acceptsClicks(),
})
registerSmoke()
initPillStore()

/** The tray's microphone menu is filled from here; only this page can list devices. */
async function reportMicrophones(): Promise<void> {
  try {
    window.flow.reportMicrophones(await capture.listMicrophones())
  } catch {
    // The list simply stays as it was.
  }
}

window.flow.onCaptureCommand((command) => {
  switch (command.kind) {
    case 'start':
      // Device names only become visible once the microphone has been opened once.
      void capture.start(command.session, command.deviceId).then(() => {
        // The one that was opened: the pill names it if it turns out to hear nothing.
        setMicrophone(capture.microphoneLabel)
        return reportMicrophones()
      })
      return
    case 'stop':
      void capture.stop(command.session)
      return
    case 'cancel':
      capture.cancel(command.session)
      return
    case 'release':
      capture.forget(command.session)
      return
    case 'resend':
      capture.resend(command.session)
      return
    case 'loseMicrophone':
      capture.loseMicrophone(command.session)
      return
  }
})

navigator.mediaDevices.addEventListener('devicechange', () => void reportMicrophones())
// Their names can only be read once the microphone is allowed: the main process says when to look again.
window.flow.onListMicrophones(() => void reportMicrophones())
void reportMicrophones()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Pill />
  </StrictMode>,
)
