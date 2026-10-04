import { describe, expect, it } from 'vitest'
import type { AppStatus } from '@shared/ipc'
import { modelStep } from '../../src/renderer/hub/model-step'

type Speech = AppStatus['speech']

const speech = (overrides: Partial<Speech> = {}): Speech => ({
  state: 'ready',
  modelDownloaded: true,
  modelLabel: 'Parakeet v3',
  modelBytes: 671_000_000,
  engine: 'sherpa-parakeet',
  downloadProgress: null,
  downloadError: null,
  ...overrides,
})

describe('the speech model step of the setup window', () => {
  it('is done, with nothing to press, when the model is on disk and loaded', () => {
    expect(modelStep(speech())).toEqual({
      done: true,
      state: 'Downloaded and loaded',
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
      state: 'Not downloaded',
      action: 'download',
      wouldNotStart: false,
    })
  })

  it('offers to cancel a download that is under way, and shows how far it is', () => {
    const view = modelStep(
      speech({ modelDownloaded: false, state: 'modelMissing', downloadProgress: 0.426 }),
    )

    expect(view).toEqual({
      done: false,
      state: 'Downloading, 42%',
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
      state: 'Could not start',
      action: 'checkFiles',
      wouldNotStart: true,
    })
  })

  it('offers the download again once a damaged file has been found and removed', () => {
    // What the app reports after reading the files: no longer vouched for.
    const view = modelStep(speech({ modelDownloaded: false, state: 'modelMissing' }))

    expect(view).toMatchObject({ done: false, state: 'Not downloaded', action: 'download' })
  })

  it('shows the repair as a download, with a way to stop it', () => {
    const view = modelStep(speech({ state: 'failed', downloadProgress: 0.97 }))

    expect(view).toMatchObject({
      state: 'Downloading, 97%',
      action: 'cancel',
      wouldNotStart: false,
    })
  })

  it('has nothing to press while files on disk are being read', () => {
    expect(modelStep(speech({ modelDownloaded: false, state: 'loading' }))).toEqual({
      done: false,
      state: 'Checking the files…',
      action: null,
      wouldNotStart: false,
    })
    expect(modelStep(speech({ state: 'loading' }))).toMatchObject({
      state: 'Loading…',
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
