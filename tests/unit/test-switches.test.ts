import { describe, expect, it } from 'vitest'
import { debuggingSwitchesToRefuse, isTestSwitch, switchesToIgnore } from '@shared/test-switches'

const environment = [
  'PATH',
  'HOME',
  'WHISPER_FLOW_DEBUG_CONTROL',
  'WHISPER_FLOW_FAKE_MIC',
  'WHISPER_FLOW_EVAL_DIR',
  'WHISPER_FLOW_USER_DATA_DIR',
  'FLOW_HELPER_TEST_TOOLS',
  'ELECTRON_RENDERER_URL',
]

describe('test switches', () => {
  it('are honoured when running from the source tree', () => {
    expect(switchesToIgnore(environment, { packaged: false, devBuild: false })).toEqual([])
  })

  it('are honoured in the build made for development', () => {
    expect(switchesToIgnore(environment, { packaged: true, devBuild: true })).toEqual([])
  })

  it('are all ignored by a release build, and nothing else is', () => {
    expect(switchesToIgnore(environment, { packaged: true, devBuild: false })).toEqual([
      'WHISPER_FLOW_DEBUG_CONTROL',
      'WHISPER_FLOW_FAKE_MIC',
      'WHISPER_FLOW_EVAL_DIR',
      'WHISPER_FLOW_USER_DATA_DIR',
      'FLOW_HELPER_TEST_TOOLS',
      'ELECTRON_RENDERER_URL',
    ])
  })

  it('knows a switch by its name', () => {
    expect(isTestSwitch('WHISPER_FLOW_QUIET')).toBe(true)
    expect(isTestSwitch('ELECTRON_RENDERER_URL')).toBe(true)
    expect(isTestSwitch('ELECTRON_RUN_AS_NODE')).toBe(false)
  })
})

describe('debugging switches', () => {
  // As `open -a "Whisper Flow" --args --remote-debugging-port=9222` would start it.
  const given =
    (...names: string[]) =>
    (name: string) =>
      names.includes(name)
  const release = { packaged: true, devBuild: false }

  it('are refused by a release build', () => {
    expect(debuggingSwitchesToRefuse(given('remote-debugging-port'), release)).toEqual([
      'remote-debugging-port',
    ])
    expect(
      debuggingSwitchesToRefuse(given('remote-debugging-pipe', 'inspect-brk', 'lang'), release),
    ).toEqual(['remote-debugging-pipe', 'inspect-brk'])
  })

  it('leave a release build started without them alone', () => {
    expect(debuggingSwitchesToRefuse(given('lang', 'use-mock-keychain'), release)).toEqual([])
  })

  it('are allowed from the source tree and in the build made for development', () => {
    const all = given('remote-debugging-port', 'remote-debugging-pipe', 'inspect')
    expect(debuggingSwitchesToRefuse(all, { packaged: false, devBuild: false })).toEqual([])
    expect(debuggingSwitchesToRefuse(all, { packaged: true, devBuild: true })).toEqual([])
  })
})
