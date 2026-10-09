import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { userDataPath } from '../../src/main/data-paths'
import { evaluationDir } from '../../src/main/dictation/evaluation-recorder'
import { SettingsStore } from '../../src/main/store/settings'
import { modelsRoot } from '../../src/main/stt/models-dir'

let appData: string

beforeEach(() => {
  appData = mkdtempSync(join(tmpdir(), 'say-the-word-data-'))
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(appData, { recursive: true, force: true })
})

describe('storage compatibility after the product rename', () => {
  it('opens the existing settings and preserves the explicit history choice', () => {
    const previousProfile = join(appData, 'Whisper Flow')
    mkdirSync(previousProfile)
    writeFileSync(
      join(previousProfile, 'settings.json'),
      JSON.stringify({
        version: 1,
        firstRun: 'done',
        historyKeep: 'forever',
        dictationKey: 'ctrlOption',
      }),
    )

    const settings = new SettingsStore(join(userDataPath(appData), 'settings.json'))

    expect(settings.get().firstRun).toBe('done')
    expect(settings.get().dictationKey).toBe('ctrlOption')
    expect(settings.get().historyKeep).toBe('forever')
    expect(settings.stated('historyKeep')).toBe(true)
    expect(join(userDataPath(appData), 'history')).toBe(join(previousProfile, 'history'))
  })

  it('keeps an explicit test profile separate from the real profile', () => {
    const testProfile = join(appData, 'isolated-test')
    expect(userDataPath(appData, testProfile)).toBe(testProfile)
    expect(userDataPath(appData, '')).toBe(join(appData, 'Whisper Flow'))
  })

  it('continues using the downloaded models and saved evaluation recordings', () => {
    vi.stubEnv('WHISPER_FLOW_MODELS_DIR', '')
    vi.stubEnv('WHISPER_FLOW_EVAL_DIR', '')
    const previousProfile = join(homedir(), 'Library', 'Application Support', 'Whisper Flow')
    expect(modelsRoot()).toBe(join(previousProfile, 'models'))
    expect(evaluationDir()).toBe(join(previousProfile, 'evaluation'))
  })

  it('preserves the tooling overrides for models and recordings', () => {
    vi.stubEnv('WHISPER_FLOW_MODELS_DIR', join(appData, 'test-models'))
    vi.stubEnv('WHISPER_FLOW_EVAL_DIR', join(appData, 'test-recordings'))
    expect(modelsRoot()).toBe(join(appData, 'test-models'))
    expect(evaluationDir()).toBe(join(appData, 'test-recordings'))
  })
})
