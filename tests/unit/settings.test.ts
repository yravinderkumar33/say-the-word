import type * as FsRuntime from 'node:fs'
import {
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/main/store/settings'

// The real file system, with the calls that make a write last watched.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof FsRuntime>()
  return { ...real, fsyncSync: vi.fn(real.fsyncSync), renameSync: vi.fn(real.renameSync) }
})

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
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(
      Object.fromEntries(Object.entries(saved).filter(([key]) => key !== 'historyKeep')),
    )
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
      // The system's default microphone is followed until the user puts one first.
      microphoneOrder: [],
      dictationKey: 'fn',
      sounds: true,
      soundVolume: 0.45,
      pillAtRest: true,
      showInDock: false,
      modelKeep: 'tenMinutes',
      // What is said is kept in memory only, unless the user chooses otherwise.
      historyKeep: 'session',
      historyPaused: false,
    })
  })

  it('keeps nothing that was said on disk, and plays no part in a first run, unless told to', () => {
    const settings = new SettingsStore(file)
    expect(settings.existedAtLaunch).toBe(false)
    expect(settings.get().historyKeep).toBe('session')
    // A file written before there was a first run names no state for it: such an install is set up.
    expect(settings.get().firstRun).toBeUndefined()

    settings.update({ historyKeep: 'week', firstRun: 'pending' })

    const again = new SettingsStore(file)
    expect(again.existedAtLaunch).toBe(true)
    expect(again.get()).toMatchObject({ historyKeep: 'week', firstRun: 'pending' })
  })

  it('leaves out a history setting it does not know, and keeps the rest', () => {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, historyKeep: 'a year', mode: 'cleaned' }))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const settings = new SettingsStore(file).get()

    // An unknown choice must never be read as "keep on disk".
    expect(settings.historyKeep).toBe('session')
    expect(settings.mode).toBe('cleaned')
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

  it('copies a damaged file aside at the next save when neither could be made before', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mkdirSync(join(file, '..'), { recursive: true })
    const damaged = '{ "version": 1, "dictionary": [{ "from": "a", "to": "b" },] }'
    writeFileSync(file, damaged)
    const store = new SettingsStore(file)
    // For now, neither the copy nor the settings can be written.
    mkdirSync(store.asidePath)
    mkdirSync(`${file}.tmp`)
    expect(() => store.update({ mode: 'cleaned' })).toThrow()

    rmSync(store.asidePath, { recursive: true })
    rmSync(`${file}.tmp`, { recursive: true })
    store.update({ mode: 'cleaned' })

    expect(readFileSync(store.asidePath, 'utf8')).toBe(damaged)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ mode: 'cleaned' })
  })

  it('puts the settings on the disk itself before they take the place of the file', () => {
    // A crash between the two would otherwise leave an empty file, and the defaults.
    vi.mocked(fsyncSync).mockClear()
    vi.mocked(renameSync).mockClear()
    new SettingsStore(file).update({ mode: 'cleaned' })

    const synced = vi.mocked(fsyncSync).mock.invocationCallOrder
    const renamed = vi.mocked(renameSync).mock.invocationCallOrder
    expect(synced).toHaveLength(1)
    expect(renamed).toHaveLength(1)
    expect(synced[0]).toBeLessThan(renamed[0]!)
  })

  it('tells a setting the file states from one that is only the default', () => {
    // No file: everything is a default.
    expect(new SettingsStore(file).stated('historyKeep')).toBe(false)

    // A file from a build that did not know the entry: the default, and not a choice.
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, mode: 'cleaned' }))
    const older = new SettingsStore(file)
    expect(older.get().historyKeep).toBe('session')
    expect(older.stated('historyKeep')).toBe(false)
    expect(older.stated('mode')).toBe(true)

    // Saving an unrelated setting does not turn an unstated retention default into consent.
    older.update({ mode: 'verbatim' })
    expect(older.stated('historyKeep')).toBe(false)
    expect(new SettingsStore(file).stated('historyKeep')).toBe(false)
  })

  it('does not take a default for a choice when the file cannot be used', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // A comma too many, after an edit by hand: the whole file falls back to the defaults.
    writeFileSync(file, '{ "version": 1, "historyKeep": "forever", }')
    const damaged = new SettingsStore(file)
    expect(damaged.get().historyKeep).toBe('session')
    expect(damaged.stated('historyKeep')).toBe(false)

    // The entry itself cannot be used: the rest of the file is, and this one is the default.
    writeFileSync(file, JSON.stringify({ version: 1, mode: 'cleaned', historyKeep: 'a fortnight' }))
    const oneWrong = new SettingsStore(file)
    expect(oneWrong.stated('historyKeep')).toBe(false)
    expect(oneWrong.stated('mode')).toBe(true)

    // From another version of the app: none of it is taken.
    writeFileSync(file, JSON.stringify({ version: 2, historyKeep: 'forever' }))
    expect(new SettingsStore(file).stated('historyKeep')).toBe(false)

    // Stated, and "only until I quit": that is a choice.
    writeFileSync(file, JSON.stringify({ version: 1, historyKeep: 'session' }))
    expect(new SettingsStore(file).stated('historyKeep')).toBe(true)
  })

  it('fills in a setting that an older file does not have', () => {
    new SettingsStore(file).update({ microphoneId: null })
    writeFileSync(file, JSON.stringify({ version: 1 }))

    expect(new SettingsStore(file).get()).toEqual(DEFAULT_SETTINGS)
  })

  describe('when the file cannot be written', () => {
    /** A folder where the file is first written: every save fails until it is removed. */
    const blockSaving = (): void => mkdirSync(`${file}.tmp`)
    const allowSaving = (): void => rmSync(`${file}.tmp`, { recursive: true })

    it.each([
      [{ mode: 'cleaned' as const }],
      [{ microphoneId: 'usb-mic-1' }],
      [{ evaluationRecording: true }],
      [{ cleanupModel: 'gemma4:e4b' }],
    ])('does not make the change either: %o', (patch) => {
      const store = new SettingsStore(file)
      store.update({ mode: 'verbatim' })
      const before = store.get()
      blockSaving()

      expect(() => store.update(patch)).toThrow()

      // What is in force and what is on disk still agree.
      expect(store.get()).toEqual(before)
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(
        Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'historyKeep')),
      )
    })

    it('makes the same change once the file can be written again', () => {
      const store = new SettingsStore(file)
      store.update({ mode: 'verbatim' })
      blockSaving()
      expect(() => store.update({ mode: 'cleaned' })).toThrow()

      allowSaving()
      store.update({ mode: 'cleaned' })

      expect(store.get().mode).toBe('cleaned')
      expect(new SettingsStore(file).get().mode).toBe('cleaned')
    })

    it('refuses a change that is not a valid setting, and keeps what it had', () => {
      const store = new SettingsStore(file)
      store.update({ mode: 'cleaned' })

      expect(() => store.update({ mode: 'loud' as unknown as 'cleaned' })).toThrow()

      expect(store.get().mode).toBe('cleaned')
      expect(new SettingsStore(file).get().mode).toBe('cleaned')
    })
  })
})

describe('retention consent survives unrelated settings updates (QA-01)', () => {
  it('keeps unknown consent absent across two restarts', () => {
    mkdirSync(join(dir, 'nested'), { recursive: true })
    writeFileSync(file, 'broken settings')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    new SettingsStore(file).update({ mode: 'cleaned' })
    const second = new SettingsStore(file)
    expect(second.stated('historyKeep')).toBe(false)
    second.update({ soundVolume: 0.4 })
    expect(new SettingsStore(file).stated('historyKeep')).toBe(false)
    expect(Object.hasOwn(JSON.parse(readFileSync(file, 'utf8')), 'historyKeep')).toBe(false)
  })
  it('an explicit choice equal to the fallback establishes consent', () => {
    new SettingsStore(file).update({ historyKeep: 'session' })
    expect(new SettingsStore(file).stated('historyKeep')).toBe(true)
  })
})
