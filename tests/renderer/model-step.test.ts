import { describe, expect, it } from 'vitest'
import type { AppStatus } from '@shared/ipc'
import { modelStep } from '../../src/renderer/hub/model-step'

type Speech = AppStatus['speech']

const speech = (overrides: Partial<Speech> = {}): Speech => ({
  state: 'ready',
  modelDownloaded: true,
  modelLabel: 'Parakeet v3',
  modelLicence: 'Parakeet: CC-BY-4.0 (NVIDIA). Silero VAD: MIT.',
  modelBytes: 671_000_000,
  modelLanguages: 25,
  engine: 'sherpa-parakeet',
  downloadProgress: null,
  downloadError: null,
  ...overrides,
})

describe('the speech model step of the setup window', () => {
  it('is done, with nothing to press, when the model is on disk and loaded', () => {
    expect(modelStep(speech())).toEqual({
      done: true,
      checking: false,
      action: null,
      wouldNotStart: false,
    })
  })

  it('is done while the model is unloaded to save memory', () => {
    expect(modelStep(speech({ state: 'stopped' }))).toMatchObject({ done: true, action: null })
  })

  it('offers the download when the model is not there', () => {
    expect(modelStep(speech({ modelDownloaded: false, state: 'modelMissing' }))).toEqual({
      done: false,
      checking: false,
      action: 'download',
      wouldNotStart: false,
    })
  })

  it('offers to cancel a download that is under way', () => {
    const view = modelStep(
      speech({ modelDownloaded: false, state: 'modelMissing', downloadProgress: 0.426 }),
    )

    expect(view).toEqual({
      done: false,
      checking: false,
      action: 'cancel',
      wouldNotStart: false,
    })
  })

  it('offers to try again after a download that stopped', () => {
    const view = modelStep(
      speech({
        modelDownloaded: false,
        state: 'modelMissing',
        downloadError: 'Download of encoder.int8.onnx stalled',
      }),
    )

    expect(view).toMatchObject({ done: false, action: 'tryAgain' })
  })

  it('offers to check the files of a model that is on disk and would not start', () => {
    expect(modelStep(speech({ state: 'failed' }))).toEqual({
      done: false,
      checking: false,
      action: 'checkFiles',
      wouldNotStart: true,
    })
  })

  it('offers the download again once a damaged file has been found and removed', () => {
    // What the app reports after reading the files: no longer vouched for.
    const view = modelStep(speech({ modelDownloaded: false, state: 'modelMissing' }))

    expect(view).toMatchObject({ done: false, action: 'download' })
  })

  it('shows the repair as a download, with a way to stop it', () => {
    const view = modelStep(speech({ state: 'failed', downloadProgress: 0.97 }))

    expect(view).toMatchObject({ action: 'cancel', wouldNotStart: false })
  })

  it('has nothing to press while files on disk are being read, and says that they are', () => {
    expect(modelStep(speech({ modelDownloaded: false, state: 'loading' }))).toEqual({
      done: false,
      checking: true,
      action: null,
      wouldNotStart: false,
    })
    // Vouched for, and being taken in: loading, not checking.
    expect(modelStep(speech({ state: 'loading' }))).toMatchObject({
      checking: false,
      action: null,
    })
  })

  it('always has a way forward when the model cannot be used', () => {
    const stuck: Speech[] = [
      speech({ modelDownloaded: false, state: 'modelMissing' }),
      speech({ modelDownloaded: false, state: 'modelMissing', downloadError: 'HTTP 503' }),
      speech({ modelDownloaded: false, state: 'failed' }),
      speech({ modelDownloaded: true, state: 'failed' }),
    ]

    for (const state of stuck) {
      expect(modelStep(state).action, JSON.stringify(state)).not.toBeNull()
    }
  })
})
