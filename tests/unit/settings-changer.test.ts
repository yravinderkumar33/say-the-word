import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsStore, type Settings } from '../../src/main/store/settings'
import { NOT_SAVED_MESSAGE, createSettingsChanger } from '../../src/main/store/settings-changer'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'settings-changer-'))
  file = join(dir, 'settings.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** The real store on a folder of its own, and a menu and a pill that record what they are told. */
function setup() {
  const settings = new SettingsStore(file)
  settings.update({ mode: 'verbatim' })
  const shown: Settings[] = []
  const told: string[] = []
  const change = createSettingsChanger({
    settings,
    showCurrent: (current) => shown.push(current),
    tell: (message) => told.push(message),
  })
  /** A folder where the file is first written: every save fails until it is removed. */
  const blockSaving = (): void => mkdirSync(`${file}.tmp`)
  const allowSaving = (): void => rmSync(`${file}.tmp`, { recursive: true })
  const onDisk = (): Settings => JSON.parse(readFileSync(file, 'utf8')) as Settings
  return { settings, shown, told, change, blockSaving, allowSaving, onDisk }
}

describe('changing a setting from the menu', () => {
  it('makes the change, shows it, and says nothing', () => {
    const t = setup()

    const made = t.change({ mode: 'cleaned' })

    expect(made).toBe(true)
    expect(t.settings.get().mode).toBe('cleaned')
    expect(t.onDisk().mode).toBe('cleaned')
    expect(t.shown.at(-1)?.mode).toBe('cleaned')
    expect(t.told).toEqual([])
  })

  it.each([
    ['the mode', { mode: 'cleaned' as const }],
    ['the microphone', { microphoneId: 'usb-mic-1' }],
    ['saving every dictation', { evaluationRecording: true }],
    ['the cleanup model', { cleanupModel: 'gemma4:e4b' }],
  ])('leaves %s as it was when the change cannot be saved', (_what, patch) => {
    const t = setup()
    const before = t.settings.get()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.blockSaving()

    const made = t.change(patch)

    expect(made).toBe(false)
    expect(t.settings.get()).toEqual(before)
    expect(t.onDisk()).toEqual(before)
    // The menu ticked the item by itself when it was clicked: it is drawn again as it was.
    expect(t.shown.at(-1)).toEqual(before)
    expect(t.told).toEqual([NOT_SAVED_MESSAGE])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('names the entry in the log, and not its value', () => {
    const t = setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    t.blockSaving()

    t.change({ dictionary: [{ from: 'acme', to: 'ACME Private Holdings' }] })

    const line = logged.mock.calls.flat().join(' ')
    expect(line).toContain('dictionary')
    expect(line).not.toContain('ACME')
  })

  it('makes the change when it is asked for again and can be saved', () => {
    const t = setup()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    t.blockSaving()
    expect(t.change({ evaluationRecording: true })).toBe(false)

    t.allowSaving()

    expect(t.change({ evaluationRecording: true })).toBe(true)
    expect(t.settings.get().evaluationRecording).toBe(true)
    expect(t.onDisk().evaluationRecording).toBe(true)
    expect(t.told).toEqual([NOT_SAVED_MESSAGE])
  })

  it('keeps its message short enough for the pill', () => {
    expect(NOT_SAVED_MESSAGE.length).toBeLessThanOrEqual(40)
  })
})
