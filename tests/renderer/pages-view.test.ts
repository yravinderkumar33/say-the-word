import { describe, expect, it } from 'vitest'
import type { CleanupFacts, PrivacyFacts, TryResult } from '@shared/ipc'
import {
  RULES_ONLY,
  modelNote,
  modelOptions,
  ollamaLine,
  ollamaRow,
  refusalWords,
  tryColumns,
} from '../../src/renderer/hub/cleanup-view'
import { bytes, clockLength, counted, seconds, timeOfDay } from '../../src/renderer/hub/format'
import {
  contactedLines,
  everythingNote,
  problemWords,
  storedRows,
} from '../../src/renderer/hub/privacy-view'
import {
  SYSTEM_DEFAULT,
  microphoneOptions,
  microphoneRows,
  modelState,
  moved,
  shortcutRows,
} from '../../src/renderer/hub/settings-view'

describe('numbers as the window writes them', () => {
  it('writes sizes in the unit a person would use', () => {
    expect(bytes(512)).toBe('512 bytes')
    expect(bytes(84_000)).toBe('84 KB')
    expect(bytes(1_200_000)).toBe('1.2 MB')
    expect(bytes(671_122_626)).toBe('671 MB')
    expect(bytes(1_900_000_000)).toBe('1.9 GB')
    expect(bytes(7_000_000)).toBe('7 MB')
  })

  it('rounds before it chooses the unit, so that no size reads "1000"', () => {
    expect(bytes(999_499)).toBe('999 KB')
    expect(bytes(999_500)).toBe('1 MB')
    expect(bytes(999_500_000)).toBe('1 GB')
    expect(bytes(999_999_999)).toBe('1 GB')
    expect(bytes(999.6)).toBe('1 KB')
  })

  it('counts whole bytes, and one byte as one byte', () => {
    expect(bytes(1)).toBe('1 byte')
    expect(bytes(0)).toBe('0 bytes')
    expect(bytes(512.25)).toBe('512 bytes')
  })

  it('writes durations to the precision that means something', () => {
    expect(seconds(430)).toBe('0.43 s')
    expect(seconds(10)).toBe('0.01 s')
    expect(seconds(1_100)).toBe('1.1 s')
    expect(seconds(4_200)).toBe('4.2 s')
    expect(clockLength(6_150)).toBe('0:06')
    expect(clockLength(760_000)).toBe('12:40')
  })

  it('counts with the right noun, and tells the time of day', () => {
    expect(counted(1, 'dictation')).toBe('1 dictation')
    expect(counted(1_284, 'word')).toBe('1,284 words')
    expect(timeOfDay(new Date(2026, 9, 4, 9, 5).getTime())).toBe('09:05')
  })
})

const cleanup = (change: Partial<CleanupFacts> = {}): CleanupFacts => ({
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
  typicalMs: 930,
  ...change,
})

describe('the Cleanup page', () => {
  it('says where Ollama runs, and offers nothing when it does', () => {
    expect(ollamaLine(cleanup(), 'Say the Word')).toEqual({
      text: 'Running on this Mac, at 127.0.0.1',
      ok: true,
      action: null,
    })
  })

  it('offers to start Ollama when it is installed, and to get it when it is not', () => {
    expect(ollamaLine(cleanup({ ollama: 'notRunning' }), 'Say the Word')).toMatchObject({
      text: 'Installed on this Mac, and not running.',
      action: 'start',
    })
    expect(ollamaLine(cleanup({ ollama: 'notInstalled' }), 'Say the Word')).toEqual({
      text: 'Not installed. A separate free app that runs the model; Say the Word does not include it.',
      ok: false,
      action: 'get',
    })
  })

  it('does not offer to start anything at an address that is not this Mac', () => {
    const elsewhere = cleanup({ ollama: 'notRunning', host: '192.168.1.20', local: false })

    expect(ollamaLine(elsewhere, 'Say the Word')).toMatchObject({ action: null, ok: false })
    expect(ollamaLine(cleanup({ host: '192.168.1.20', local: false }), 'Say the Word').text).toBe(
      'Running at 192.168.1.20, which is not this Mac',
    )
  })

  it('has one row about Ollama for every page, from the moment it is looked for', () => {
    expect(ollamaRow(null, false, 'Say the Word')).toEqual({
      text: 'Looking for Ollama…',
      icon: null,
      action: null,
    })
    expect(ollamaRow(cleanup(), false, 'Say the Word')).toEqual({
      text: 'Running on this Mac, at 127.0.0.1',
      icon: 'tick',
      action: null,
    })
    expect(ollamaRow(cleanup({ ollama: 'notRunning' }), false, 'Say the Word')).toEqual({
      text: 'Installed on this Mac, and not running.',
      icon: 'stopped',
      action: 'start',
    })
    // Being started: said so, and not offered again meanwhile.
    expect(ollamaRow(cleanup({ ollama: 'notRunning' }), true, 'Say the Word')).toEqual({
      text: 'Starting Ollama…',
      icon: 'stopped',
      action: null,
    })
    expect(ollamaRow(cleanup({ ollama: 'notInstalled' }), false, 'Say the Word')).toMatchObject({
      icon: 'absent',
      action: 'get',
    })
    expect(
      ollamaRow(cleanup({ host: '192.168.1.20', local: false }), false, 'Say the Word').text,
    ).toBe('Running at 192.168.1.20, which is not this Mac')
  })

  it('lists the models that run on this Mac, then the rules alone', () => {
    expect(modelOptions(cleanup()).map((option) => option.label)).toEqual([
      'qwen3.5:4b',
      'llama3.2:3b',
      'Rules only (no model)',
    ])
    expect(modelOptions(cleanup()).at(-1)?.value).toBe(RULES_ONLY)
  })

  it('still shows the model that is chosen when it is not among them', () => {
    const refused = cleanup({ chosen: 'big:cloud', refusal: 'remote' })

    expect(modelOptions(refused)[0]).toEqual({ value: 'big:cloud', label: 'big:cloud' })
  })

  it('says beside the model what it costs, or why it is not in use', () => {
    expect(modelNote(cleanup())).toBe('Usually 0.93 s from release to text · 3.4 GB')
    expect(modelNote(cleanup({ typicalMs: null }))).toBe('3.4 GB')
    expect(modelNote(cleanup({ refusal: 'remote' }))).toBe('Refused · rules only in use')
    expect(modelNote(cleanup({ ollama: 'notInstalled', models: [] }))).toBe(
      'Models appear here when Ollama is running',
    )
    expect(modelNote(cleanup({ chosen: null }))).toBe(
      'Hesitations and repeated words are removed by fixed rules.',
    )
  })

  it('gives the reason a model is refused in the app’s own words', () => {
    expect(refusalWords(cleanup({ chosen: 'big:cloud', refusal: 'remote' }))).toEqual({
      title: 'The chosen model does not run on this Mac',
      body:
        'Ollama would run big:cloud on another machine. What you say is never sent there. ' +
        'Cleaned uses rules only until then.',
    })
    expect(refusalWords(cleanup({ refusal: 'notInstalled' }))?.title).toBe(
      'The chosen model is not installed',
    )
    expect(refusalWords(cleanup())).toBeNull()
  })

  const tried: TryResult = {
    verbatim: { text: 'um so lets meet', ms: 0.2 },
    rules: { text: 'So lets meet', ms: 6 },
    cleaned: { text: 'So let’s meet.', ms: 840, model: 'qwen3.5:4b', used: true, why: null },
  }

  it('says what each column is for before anything is typed', () => {
    const columns = tryColumns(null, cleanup(), false)

    expect(columns.map((column) => column.label)).toEqual(['Verbatim', 'Rules only', 'Cleaned'])
    expect(columns.map((column) => column.model)).toEqual([null, null, 'qwen3.5:4b'])
    expect(columns[0]?.text).toBe('Type a sentence above to compare.')
    expect(tryColumns(null, cleanup({ ollama: 'notInstalled' }), false)[2]?.text).toBe(
      'Needs Ollama. Rules only is used until then.',
    )
    expect(tryColumns(null, cleanup({ chosen: null }), false)[2]?.text).toBe(
      'No model is chosen. Rules only is used.',
    )
  })

  it('shows the three results with the time each took', () => {
    expect(tryColumns(tried, cleanup(), false)).toEqual([
      {
        label: 'Verbatim',
        model: null,
        time: '0.00 s',
        text: 'um so lets meet',
        dim: false,
        problem: null,
        said: true,
      },
      {
        label: 'Rules only',
        model: null,
        time: '0.01 s',
        text: 'So lets meet',
        dim: false,
        problem: null,
        said: true,
      },
      {
        label: 'Cleaned',
        model: 'qwen3.5:4b',
        time: '0.84 s',
        text: 'So let’s meet.',
        dim: false,
        problem: null,
        said: true,
      },
    ])
  })

  it('dims a result a dictation would not have used, and says why', () => {
    const slow: TryResult = {
      ...tried,
      cleaned: {
        text: 'So let’s meet.',
        ms: 4_200,
        model: 'gemma2:27b',
        used: false,
        why: 'Too slow to use',
      },
    }

    expect(tryColumns(slow, cleanup(), false)[2]).toEqual({
      label: 'Cleaned',
      model: 'gemma2:27b',
      time: '4.2 s',
      text: 'So let’s meet.',
      dim: true,
      problem: 'Too slow to use',
      said: true,
    })
  })

  it('says that the model is being asked while it is', () => {
    expect(tryColumns({ ...tried, cleaned: null }, cleanup(), true)[2]?.text).toBe(
      'Asking the model…',
    )
  })

  it('names no model when none would be asked', () => {
    expect(tryColumns(null, cleanup({ ollama: 'notRunning' }), false)[2]?.model).toBeNull()
    expect(tryColumns(null, cleanup({ chosen: null }), false)[2]?.model).toBeNull()
  })

  it('marks as said a text made from the sentence, which may have been dictated, and no hint', () => {
    expect(tryColumns(tried, cleanup(), false).map((column) => column.said)).toEqual([
      true,
      true,
      true,
    ])
    expect(tryColumns(null, cleanup(), false).map((column) => column.said)).toEqual([
      false,
      false,
      false,
    ])
    expect(tryColumns({ ...tried, cleaned: null }, cleanup(), true)[2]?.said).toBe(false)
  })
})

const privacy = (change: Partial<PrivacyFacts> = {}): PrivacyFacts => ({
  recognizer: 'Parakeet v3',
  contacted: [],
  history: { keep: 'session', count: 23, onDisk: false, bytes: 0, left: 0 },
  recordings: { saving: false, count: 0, bytes: 0 },
  log: { bytes: 84_000 },
  counts: { bytes: 220 },
  problem: null,
  ...change,
})

describe('the Privacy page', () => {
  it('says "Nothing" when nothing has been contacted', () => {
    expect(contactedLines([])).toEqual(['Nothing'])
  })

  it('says what each address was for, and whether it is this Mac', () => {
    expect(
      contactedLines([
        { host: '127.0.0.1', what: 'ollama', local: true, answered: true },
        { host: 'huggingface.co', what: 'speechModel', local: false, answered: true },
        { host: 'example.org', what: 'refused', local: false, answered: false },
        { host: 'localhost', what: 'other', local: true, answered: false },
      ]),
    ).toEqual([
      '127.0.0.1, Ollama on this Mac',
      'huggingface.co, for the speech model you downloaded',
      // Stopped in the main process before it left: said, so that it can be looked into.
      'example.org: asked for by a page, and refused',
      'localhost, this Mac',
    ])
    expect(
      contactedLines([{ host: '127.0.0.1', what: 'ollama', local: true, answered: false }]),
    ).toEqual(['127.0.0.1, this Mac: nothing answered'])
    expect(
      contactedLines([{ host: '10.0.0.4', what: 'ollama', local: false, answered: true }]),
    ).toEqual(['10.0.0.4, an Ollama server that is not this Mac'])
  })

  it('says what is stored, how much, and what can be done with it', () => {
    const rows = storedRows(privacy())

    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['History', 'In memory only: 23 dictations, gone when the app quits'],
      ['Evaluation recordings', 'Off. Nothing saved'],
      ['Log', '84 KB. It never contains what you said'],
      ['Word counts', '220 bytes. Words per day and timings: numbers only'],
    ])
    // Nothing of the history is on disk: there is nothing to show in Finder.
    expect(rows[0]).toMatchObject({ canShow: false, canDelete: true })
    expect(rows[1]).toMatchObject({ canShow: false, canDelete: false, saving: false })
  })

  it('says when the history is on disk, and marks recordings that are being saved', () => {
    const rows = storedRows(
      privacy({
        history: { keep: 'month', count: 412, onDisk: true, bytes: 1_200_000, left: 0 },
        recordings: { saving: true, count: 3, bytes: 7_000_000 },
      }),
    )

    expect(rows[0]).toMatchObject({
      value: 'On disk for 30 days: 412 dictations, 1.2 MB',
      canShow: true,
    })
    expect(rows[1]).toMatchObject({
      value: 'On: 3 recordings and their text, 7 MB',
      saving: true,
      canShow: true,
      canDelete: true,
    })
  })

  it('never says that nothing is saved when the folder of recordings could not be read', () => {
    const rows = storedRows(
      privacy({ recordings: { saving: false, count: 0, bytes: 0, scanFailed: true } }),
    )
    expect(rows.find((row) => row.kind === 'recordings')).toMatchObject({
      value: 'Off. The folder could not be checked',
      canShow: true,
      canDelete: true,
    })
    expect(
      problemWords({ kind: 'recordings', deleted: 0, failed: 1, scanFailed: true }).title,
    ).toBe('The folder of recordings could not be checked')
  })

  it('says that recordings are still there after the saving was switched off', () => {
    const rows = storedRows(privacy({ recordings: { saving: false, count: 1, bytes: 1_400_000 } }))

    expect(rows[1]?.value).toBe('Off. 1 recording and its text is still on this Mac, 1.4 MB')
  })

  it('is the promise at its plainest when nothing is kept', () => {
    const rows = storedRows(
      privacy({
        history: { keep: 'session', count: 0, onDisk: false, bytes: 0, left: 0 },
        counts: { bytes: 0 },
      }),
    )

    expect(rows[0]?.value).toBe('Nothing kept yet')
    expect(rows[3]?.value).toBe('Nothing counted yet')
    expect(everythingNote(rows)).toEqual({
      text: 'There is nothing to delete except the log.',
      enabled: true,
    })
    expect(everythingNote(storedRows(privacy()))).toMatchObject({ enabled: true })
  })

  it('does not call the history "in memory only" while files of it are still on disk', () => {
    // The settings no longer say that it is kept, or the files would not be deleted.
    const nothingListed = storedRows(
      privacy({ history: { keep: 'session', count: 0, onDisk: false, bytes: 18_000, left: 3 } }),
    )[0]
    expect(nothingListed).toMatchObject({
      value: 'Nothing listed. 3 files saved earlier are still on disk, 18 KB',
      canShow: true,
      canDelete: true,
    })

    const some = storedRows(
      privacy({ history: { keep: 'session', count: 4, onDisk: false, bytes: 2_000, left: 1 } }),
    )[0]
    expect(some?.value).toBe(
      'In memory only: 4 dictations, gone when the app quits. 1 file saved earlier is still on disk, 2 KB',
    )
  })

  it('says how much a Delete left behind, and what to do', () => {
    expect(problemWords({ kind: 'recordings', deleted: 139, failed: 3 })).toEqual({
      title: '3 recordings could not be deleted',
      body:
        'The files may be open in another app, or protected. Close them there, then try again. ' +
        'The other 139 were deleted.',
    })
    expect(problemWords({ kind: 'log', deleted: 0, failed: 1 }).title).toBe(
      'The log could not be deleted',
    )
  })
})

describe('the Settings page', () => {
  it('lists the shortcuts as they are with each dictation key', () => {
    expect(shortcutRows('fn').map((row) => row.caps)).toEqual([
      ['Fn'],
      ['Fn', 'Fn'],
      ['esc'],
      ['⌘', '⌃', 'V'],
      ['⌘', '⌃', 'C'],
    ])
    expect(shortcutRows('ctrlOption')[1]?.caps).toEqual(['⌃⌥', 'Space'])
    // Only the dictation key can be changed for now.
    expect(shortcutRows('fn').map((row) => row.changeable)).toEqual([
      true,
      false,
      false,
      false,
      false,
    ])
  })

  const display = { deviceId: 'display', label: 'Studio Display Microphone' }
  const builtIn = { deviceId: 'built-in', label: 'MacBook Pro Microphone (Built-in)' }
  const airpods = { deviceId: 'airpods', label: 'AirPods Pro' }

  it('lists the microphones in the order they are tried, then the others the system offers', () => {
    const rows = microphoneRows({
      microphones: [builtIn, display],
      microphoneOrder: [airpods, display],
      microphoneInUse: 'display',
    })

    expect(rows).toEqual([
      { deviceId: 'airpods', name: 'AirPods Pro', connected: false, inUse: false },
      { deviceId: 'display', name: 'Studio Display Microphone', connected: true, inUse: true },
      { deviceId: 'built-in', name: 'MacBook Pro Microphone', connected: true, inUse: false },
    ])
  })

  it('offers the system default, then each microphone the system offers, by its name', () => {
    expect(microphoneOptions({ microphones: [builtIn, { deviceId: 'usb', label: '' }] })).toEqual([
      { value: SYSTEM_DEFAULT, label: 'System default' },
      { value: 'built-in', label: 'MacBook Pro Microphone' },
      // Names come only once the microphone has been allowed and opened once.
      { value: 'usb', label: 'Microphone 2' },
    ])
  })

  it('marks none as in use while the system default is followed', () => {
    const rows = microphoneRows({
      microphones: [builtIn],
      microphoneOrder: [],
      microphoneInUse: null,
    })

    expect(rows.map((row) => row.inUse)).toEqual([false])
  })

  it('moves a row to another place', () => {
    expect(moved(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
    expect(moved(['a', 'b', 'c'], 0, 9)).toEqual(['b', 'c', 'a'])
  })

  it('says in a word whether the speech model is in memory', () => {
    expect(modelState({ state: 'ready', modelDownloaded: true })).toEqual({
      word: 'Loaded',
      loaded: true,
    })
    expect(modelState({ state: 'stopped', modelDownloaded: true }).word).toBe('Resting')
    expect(modelState({ state: 'loading', modelDownloaded: true }).word).toBe('Loading…')
    expect(modelState({ state: 'modelMissing', modelDownloaded: false }).word).toBe(
      'Not downloaded',
    )
    expect(modelState({ state: 'failed', modelDownloaded: true }).word).toBe('Could not start')
  })
})
