import { describe, expect, it } from 'vitest'
import { isTestSwitch, switchesToIgnore } from '@shared/test-switches'

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
