import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/store/settings'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-'))
  file = join(dir, 'nested', 'settings.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('SettingsStore', () => {
  it('starts with defaults when there is no file', () => {
    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('saves a change and reads it back in a new store', () => {
    new SettingsStore(file).update({ microphoneId: 'usb-mic-1' })

    const saved = { ...DEFAULT_SETTINGS, microphoneId: 'usb-mic-1' }
    expect(new SettingsStore(file).get()).toEqual(saved)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(saved)
  })

  it('starts in Verbatim mode, with Ollama on this machine and an empty dictionary', () => {
    expect(DEFAULT_SETTINGS).toEqual({
      version: 1,
      microphoneId: null,
      evaluationRecording: false,
      mode: 'verbatim',
      cleanupModel: 'qwen3.5:4b',
      ollamaUrl: 'http://127.0.0.1:11434',
      allowRemoteOllama: false,
      dictionary: [],
    })
  })

  it('keeps the mode, the model and the dictionary across restarts', () => {
    new SettingsStore(file).update({
      mode: 'cleaned',
      cleanupModel: null,
      dictionary: [{ from: 'kubernetes', to: 'Kubernetes' }],
    })

    expect(new SettingsStore(file).get()).toMatchObject({
      mode: 'cleaned',
      cleanupModel: null,
      dictionary: [{ from: 'kubernetes', to: 'Kubernetes' }],
    })
  })

  it('keeps evaluation recording off unless it was switched on', () => {
    expect(new SettingsStore(file).get().evaluationRecording).toBe(false)

    new SettingsStore(file).update({ evaluationRecording: true })

    expect(new SettingsStore(file).get()).toMatchObject({
      evaluationRecording: true,
      microphoneId: null,
    })
  })

  it('can set a value back to null', () => {
    const store = new SettingsStore(file)
    store.update({ microphoneId: 'usb-mic-1' })

    expect(store.update({ microphoneId: null }).microphoneId).toBeNull()
  })

  it.each([
    ['not JSON', '{ this is not json'],
    ['the wrong shape', JSON.stringify({ version: 1, microphoneId: 42 })],
    ['an unknown version', JSON.stringify({ version: 99, microphoneId: null })],
  ])('falls back to defaults when the file holds %s', (_label, contents) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    new SettingsStore(file).update({ microphoneId: 'x' })
    writeFileSync(file, contents)

    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps the rest of a file in which one entry is wrong', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    new SettingsStore(file).update({ microphoneId: null })
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        mode: 'cleaned',
        microphoneId: 42,
        dictionary: [{ from: 'kubernetes', to: 'Kubernetes' }, { from: 'no replacement' }],
      }),
    )

    expect(new SettingsStore(file).get()).toEqual({
      ...DEFAULT_SETTINGS,
      mode: 'cleaned',
      dictionary: [{ from: 'kubernetes', to: 'Kubernetes' }],
    })
    // The log names what was left out, and none of the values.
    const logged = said.mock.calls.flat().join(' ')
    expect(logged).toContain('microphoneId')
    expect(logged).toContain('part of dictionary')
    expect(logged).not.toContain('kubernetes')
  })

  it('copies a damaged file aside before writing over it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    new SettingsStore(file).update({ microphoneId: null })
    const damaged = '{ "version": 1, "dictionary": [{ "from": "a", "to": "b" },] }'
    writeFileSync(file, damaged)

    const store = new SettingsStore(file)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    store.update({ mode: 'cleaned' })

    expect(readFileSync(store.asidePath, 'utf8')).toBe(damaged)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ mode: 'cleaned' })
  })

  it('fills in a setting that an older file does not have', () => {
    new SettingsStore(file).update({ microphoneId: null })
    writeFileSync(file, JSON.stringify({ version: 1 }))

    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })
})
