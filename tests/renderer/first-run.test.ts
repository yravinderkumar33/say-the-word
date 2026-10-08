import { describe, expect, it } from 'vitest'
import type { CleanupFacts, PillState } from '@shared/ipc'
import { RULES_ONLY } from '../../src/renderer/hub/cleanup-view'
import {
  barLine,
  canPractise,
  cleanedModelChange,
  cleanedPick,
  cleanedRows,
  cleanedSkip,
  downloadBar,
  exercises,
  exercisesDone,
  gestureSummary,
  legend,
  legendIndex,
  legendSpoken,
  modeSummary,
  stepOrder,
  stepStates,
} from '../../src/renderer/hub/first-run'
import { status } from './status-fixture'

const speech = (change: Parameters<typeof status>[0] = {}) => status(change).speech
const missing = { state: 'modelMissing', modelDownloaded: false } as const

describe('the steps of the first run', () => {
  it('are six, with one more for the keys only when another app listens to the same key', () => {
    expect(stepOrder(false)).toEqual([
      'welcome',
      'microphone',
      'accessibility',
      'try',
      'cleaned',
      'ready',
    ])
    expect(stepOrder(true)).toContain('keys')
    expect(stepOrder(true).indexOf('keys')).toBe(3)
  })

  it('are named in the list at the side, never numbered, with the one in hand picked out', () => {
    const states = stepStates(stepOrder(false), 'accessibility')

    expect(states.map((item) => `${item.label}: ${item.state}`)).toEqual([
      'Welcome: done',
      'Microphone: done',
      'Accessibility: current',
      'Try it: todo',
      'Cleaned mode: todo',
      'Ready: todo',
    ])
    expect(states.filter((item) => item.optional).map((item) => item.id)).toEqual(['cleaned'])
  })
})

describe('the exercises of "Try it"', () => {
  it('are ticked off as each way of dictating ends in a paste', () => {
    const before = { hold: 2, handsFree: 0, undo: 0 }

    expect(exercisesDone(before, before)).toEqual([false, false, false])
    expect(exercisesDone({ hold: 3, handsFree: 0, undo: 1 }, before)).toEqual([true, false, true])
  })

  it('name the key that is in use, and the keys of each gesture', () => {
    expect(exercises('fn')[1]).toEqual([
      'Press',
      { key: 'Fn' },
      'twice for hands-free, speak, then press',
      { key: 'Fn' },
      'to stop',
    ])
    expect(exercises('fn')[2]).toContainEqual({ key: 'esc' })
  })

  it('are decided by the key that is set, and print it as the keyboard does', () => {
    expect(exercises('ctrlOption')[1]).toEqual([
      'Hold',
      { key: '⌃⌥' },
      'and press',
      { key: 'Space' },
      'for hands-free, speak, then press',
      { key: '⌃⌥' },
      'to stop',
    ])
    expect(exercises('ctrlOption')[0]).toContainEqual({ key: '⌃⌥' })
  })

  it('say what the pill is saying, with its state picked out', () => {
    expect(legend('Fn')).toHaveLength(6)
    expect(legend('⌃⌥')[3]).toBe('Hands-free: press ⌃⌥ to stop')
    expect(legendIndex({ kind: 'resting', waiting: false })).toBe(0)
    expect(legendIndex({ kind: 'starting', slow: false })).toBe(1)
    expect(legendIndex({ kind: 'listening', handsFree: false, startedAt: 0, limitAt: 1 })).toBe(2)
    expect(legendIndex({ kind: 'listening', handsFree: true, startedAt: 0, limitAt: 1 })).toBe(3)
    expect(legendIndex({ kind: 'processing', long: false, hint: null })).toBe(4)
    expect(
      legendIndex({
        kind: 'recovery',
        message: 'Cancelled',
        messageKind: 'plain',
        canCopy: false,
        sound: false,
      }),
    ).toBe(5)
  })

  it('tell a screen reader what the pill is saying, but never while the microphone may be live', () => {
    const listening = (handsFree: boolean): PillState => ({
      kind: 'listening',
      handsFree,
      startedAt: 0,
      limitAt: 1,
    })
    // A voice would be recorded with the dictation; and rest is not news.
    expect(legendSpoken({ kind: 'resting', waiting: false }, 'Fn')).toBe('')
    expect(legendSpoken({ kind: 'starting', slow: false }, 'Fn')).toBe('')
    expect(legendSpoken(listening(false), 'Fn')).toBe('')
    expect(legendSpoken(listening(true), 'Fn')).toBe('')
    expect(legendSpoken({ kind: 'processing', long: false, hint: null }, 'Fn')).toBe(
      'Processing: the text is on its way',
    )
    expect(
      legendSpoken(
        {
          kind: 'recovery',
          message: 'Cancelled',
          messageKind: 'plain',
          canCopy: false,
          sound: false,
        },
        'Fn',
      ),
    ).toBe('Message: what happened, and what can be done')
  })

  it('wait for the speech model', () => {
    expect(canPractise(speech())).toBe(true)
    expect(canPractise(speech({ speech: { state: 'stopped' } }))).toBe(true)
    expect(canPractise(speech({ speech: missing }))).toBe(false)
    expect(canPractise(speech({ speech: { ...missing, downloadProgress: 0.4 } }))).toBe(false)
  })
})

describe('the bar about the speech model', () => {
  it('says nothing when the model was there all along', () => {
    expect(downloadBar(speech(), false)).toEqual({ kind: 'hidden' })
  })

  it('offers the download, which only a click starts', () => {
    expect(downloadBar(speech({ speech: missing }), true)).toEqual({
      kind: 'needed',
      size: '671 MB',
    })
  })

  it('says how far the download has got', () => {
    const running = speech({ speech: { ...missing, downloadProgress: 0.614 } })

    expect(downloadBar(running, true)).toEqual({
      kind: 'running',
      progress: 0.614,
      got: '412 MB',
      size: '671 MB',
    })
  })

  it('says that the download stopped, and that a model on disk would not start', () => {
    expect(
      downloadBar(
        speech({ speech: { ...missing, downloadError: 'the connection was lost' } }),
        true,
      ),
    ).toEqual({ kind: 'stopped' })
    expect(downloadBar(speech({ speech: { state: 'failed' } }), true)).toEqual({ kind: 'damaged' })
  })

  it('says that the model has arrived, when it was not there before', () => {
    expect(downloadBar(speech(), true)).toEqual({ kind: 'done', size: '671 MB' })
    expect(
      downloadBar(speech({ speech: { state: 'loading', modelDownloaded: false } }), true),
    ).toEqual({ kind: 'checking' })
  })

  it('counts what has arrived in whole bytes', () => {
    const begun = speech({ speech: { ...missing, modelBytes: 1_025, downloadProgress: 0.5 } })

    expect(downloadBar(begun, true)).toMatchObject({ got: '513 bytes' })
  })

  it('has a sentence that changes with what is happening, and not with how far it has got', () => {
    const at = (progress: number) =>
      barLine(downloadBar(speech({ speech: { ...missing, downloadProgress: progress } }), true))

    expect(at(0.3)).toBe('Downloading the speech model')
    expect(at(0.33)).toBe(at(0.3))
    expect(barLine({ kind: 'stopped' })).toBe('The download stopped. What was downloaded is kept.')
    expect(barLine({ kind: 'done', size: '671 MB' })).toBe(
      'The speech model is ready. 671 MB, stored on this Mac.',
    )
    expect(barLine({ kind: 'hidden' })).toBe('')
  })
})

describe('the Cleaned step', () => {
  const facts = (change: Partial<CleanupFacts> = {}): CleanupFacts => ({
    ollama: 'running',
    host: '127.0.0.1',
    local: true,
    models: [
      { name: 'qwen3.5:4b', bytes: 3_383_000_000 },
      { name: 'llama3.2:3b', bytes: 2_000_000_000 },
    ],
    chosen: 'qwen3.5:4b',
    refusal: null,
    alternative: null,
    typicalMs: null,
    ...change,
  })
  const away = facts({ ollama: 'notInstalled', models: [] })

  it('is skipped on a first run by keeping Verbatim', () => {
    expect(cleanedSkip('first', 'verbatim')).toEqual({
      label: 'Skip and keep Verbatim',
      mode: 'verbatim',
    })
  })

  it('shown again, is skipped without changing the mode, and says which mode is kept', () => {
    expect(cleanedSkip('again', 'cleaned')).toEqual({ label: 'Skip and keep Cleaned', mode: null })
    expect(cleanedSkip('again', 'verbatim')).toEqual({
      label: 'Skip and keep Verbatim',
      mode: null,
    })
  })

  it('offers the models that run on this Mac, with their sizes', () => {
    expect(cleanedRows(facts())).toEqual([
      { name: 'qwen3.5:4b', note: 'Runs on this Mac', size: '3.4 GB' },
      { name: 'llama3.2:3b', note: 'Runs on this Mac', size: '2 GB' },
    ])
    expect(cleanedRows(null)).toEqual([])
  })

  it('still shows the model chosen when Ollama does not list it', () => {
    expect(cleanedRows(away)).toEqual([
      { name: 'qwen3.5:4b', note: 'Needs Ollama. Rules only is used until then.', size: '' },
    ])
    const missingModel = facts({
      models: [{ name: 'llama3.2:3b', bytes: null }],
      refusal: 'notInstalled',
    })
    expect(cleanedRows(missingModel)[0]).toEqual({
      name: 'qwen3.5:4b',
      note: 'The chosen model is not installed.',
      size: '',
    })
    expect(cleanedRows(facts({ chosen: null })).map((row) => row.name)).toEqual([
      'qwen3.5:4b',
      'llama3.2:3b',
    ])
  })

  it('does not say "this Mac" of a server that is elsewhere', () => {
    const elsewhere = facts({ host: '192.168.1.20', local: false })

    expect(cleanedRows(elsewhere).map((row) => row.note)).toEqual([
      'Runs at 192.168.1.20',
      'Runs at 192.168.1.20',
    ])
  })

  it('starts from what the setting says until something is picked', () => {
    expect(cleanedPick(null, facts())).toBe('qwen3.5:4b')
    // Ollama is not there: the model chosen is still what will be used, once it is.
    expect(cleanedPick(null, away)).toBe('qwen3.5:4b')
    expect(cleanedPick(null, facts({ chosen: null }))).toBe(RULES_ONLY)
    // Still looking: nothing is drawn as chosen.
    expect(cleanedPick(null, null)).toBeNull()
  })

  it('keeps a pick that was made, while it is on offer', () => {
    expect(cleanedPick('llama3.2:3b', facts())).toBe('llama3.2:3b')
    expect(cleanedPick(RULES_ONLY, facts())).toBe(RULES_ONLY)
    expect(cleanedPick(RULES_ONLY, away)).toBe(RULES_ONLY)
    // A model that is gone from the list is not shown as picked: the setting is.
    expect(cleanedPick('llama3.2:3b', away)).toBe('qwen3.5:4b')
  })

  it('changes the model only when one was picked', () => {
    expect(cleanedModelChange(null)).toBeNull()
    expect(cleanedModelChange(RULES_ONLY)).toEqual({ model: null })
    expect(cleanedModelChange('llama3.2:3b')).toEqual({ model: 'llama3.2:3b' })
  })
})

describe('the last step', () => {
  it('sums up the gestures with the key in use', () => {
    expect(gestureSummary('fn').map((gesture) => gesture.caps)).toEqual([
      ['Fn'],
      ['Fn', 'Fn'],
      ['esc'],
      ['⌘', '⌃', 'V'],
      ['⌘', '⌃', 'C'],
    ])
    expect(gestureSummary('ctrlOption')[1]).toEqual({
      caps: ['⌃⌥', 'Space'],
      what: 'Lock on for hands-free; press ⌃⌥ again to stop',
    })
  })

  it('says which mode the setup ended in', () => {
    expect(modeSummary({ mode: 'verbatim', cleanup: '' })).toBe('Verbatim')
    expect(modeSummary({ mode: 'cleaned', cleanup: 'Cleaned with qwen3.5:4b' })).toBe('Cleaned')
    expect(modeSummary({ mode: 'cleaned', cleanup: 'Cleaned: rules only (no model chosen)' })).toBe(
      'Cleaned (rules only)',
    )
  })
})
