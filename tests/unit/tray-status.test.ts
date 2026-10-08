import { describe, expect, it } from 'vitest'
import { trayStatus, type TrayFacts } from '../../src/main/windows/tray-status'

/** A Mac where everything is in place. */
const READY: TrayFacts = {
  helperRunning: true,
  shortcutsOn: true,
  speech: { state: 'ready', downloadProgress: null },
  microphone: 'granted',
  key: 'Fn',
}
const FIRST_LAUNCH: TrayFacts = {
  ...READY,
  shortcutsOn: false,
  speech: { state: 'modelMissing', downloadProgress: null },
  microphone: 'not-determined',
}

describe("the menu-bar icon's status", () => {
  it('says that dictation is ready, with the key, and asks for nothing', () => {
    expect(trayStatus(READY)).toEqual({ line: 'Ready. Hold Fn to dictate', attention: false })
    // The model is loaded again at the next dictation: unloaded, it is still ready.
    expect(trayStatus({ ...READY, speech: { state: 'stopped', downloadProgress: null } })).toEqual({
      line: 'Ready. Hold Fn to dictate',
      attention: false,
    })
  })

  it('puts the speech model first on a first launch, as Home does', () => {
    expect(trayStatus(FIRST_LAUNCH)).toEqual({
      line: 'The speech model is not downloaded',
      attention: true,
    })
  })

  it('says how far a download has got once the permissions are in place', () => {
    const downloading = { state: 'modelMissing' as const, downloadProgress: 0.427 }
    expect(trayStatus({ ...READY, speech: downloading })).toEqual({
      line: 'Downloading the speech model, 42%',
      attention: false,
    })
    // A permission still to give is what needs the user meanwhile.
    expect(trayStatus({ ...FIRST_LAUNCH, speech: downloading })).toEqual({
      line: 'Waiting for the Accessibility permission',
      attention: true,
    })
  })

  it('names a microphone that is switched off, and asks for the user', () => {
    expect(trayStatus({ ...READY, microphone: 'denied' })).toEqual({
      line: 'The microphone is switched off',
      attention: true,
    })
    expect(trayStatus({ ...READY, microphone: 'restricted' })).toEqual({
      line: 'The microphone is switched off',
      attention: true,
    })
    expect(trayStatus({ ...READY, microphone: 'not-determined' })).toEqual({
      line: 'The microphone is not allowed yet',
      attention: true,
    })
  })

  it('puts the helper before everything, and a model that will not start before the permissions', () => {
    expect(trayStatus({ ...FIRST_LAUNCH, helperRunning: false })).toEqual({
      line: 'The shortcut helper is not running',
      attention: true,
    })
    expect(
      trayStatus({ ...FIRST_LAUNCH, speech: { state: 'failed', downloadProgress: null } }),
    ).toEqual({ line: 'Speech recognition could not start', attention: true })
  })

  it('says the model is loading, which needs nothing from the user', () => {
    expect(trayStatus({ ...READY, speech: { state: 'loading', downloadProgress: null } })).toEqual({
      line: 'Loading the speech model…',
      attention: false,
    })
  })
})
