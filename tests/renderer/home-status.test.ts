import { describe, expect, it } from 'vitest'
import {
  figures,
  gestures,
  homeStatus,
  microphoneCaption,
  modeCaption,
} from '../../src/renderer/hub/home-status'
import { status, type StatusChange } from './status-fixture'

const notDownloaded = { state: 'modelMissing', modelDownloaded: false } as const
const top = (change?: StatusChange) => homeStatus(status(change), 'Fn')

describe('the status line of Home', () => {
  it('says ready when everything dictation needs is in place', () => {
    expect(top()).toMatchObject({ ready: true, action: null })
    // A model unloaded after a while without dictation is loaded again when needed.
    expect(top({ speech: { state: 'stopped' } }).ready).toBe(true)
    expect(top({ speech: { state: 'loading' } }).ready).toBe(true)
  })

  it('asks for Accessibility, in the words that say what it is for', () => {
    expect(top({ helper: { accessibilityTrusted: false, tapInstalled: false } })).toMatchObject({
      ready: false,
      title: 'Waiting for the Accessibility permission',
      detail:
        'Lets Say the Word notice the Fn key and paste into the app you are using. ' +
        'It sees shortcut keys only, never what you type.',
      action: { does: 'accessibility', label: 'Open System Settings' },
      needsUser: true,
    })
  })

  it('names the key the shortcuts use, whichever it is', () => {
    const asked = homeStatus(
      status({ helper: { accessibilityTrusted: false, tapInstalled: false } }),
      '⌃⌥',
    )
    expect(asked.detail).toContain('notice the ⌃⌥ key')
  })

  it('asks for the microphone, and sends a refusal to System Settings', () => {
    expect(top({ microphone: 'not-determined' })).toMatchObject({
      title: 'The microphone is not allowed yet',
      action: { does: 'microphone', label: 'Allow the microphone' },
    })
    for (const refused of ['denied', 'restricted'] as const) {
      expect(top({ microphone: refused }), refused).toMatchObject({
        title: 'The microphone is switched off',
        action: { does: 'microphone', label: 'Open System Settings' },
      })
    }
    // What it says about the microphone is what the app does, hands-free and saving included.
    expect(top({ microphone: 'not-determined' }).detail).toContain('hands-free')
    expect(top({ microphone: 'not-determined' }).detail).toContain('“Save every dictation”')
  })

  it('offers the download first: it takes the longest, and needs one click', () => {
    expect(
      top({
        speech: notDownloaded,
        helper: { accessibilityTrusted: false, tapInstalled: false },
        microphone: 'not-determined',
      }),
    ).toMatchObject({
      title: 'The speech model is not downloaded',
      action: { does: 'download', label: 'Download (671 MB)' },
      needsUser: true,
    })
  })

  it('goes on to the permissions while the model downloads, and says that it does', () => {
    const during = top({
      speech: { ...notDownloaded, downloadProgress: 0.426 },
      helper: { accessibilityTrusted: false, tapInstalled: false },
    })
    expect(during.title).toBe('Waiting for the Accessibility permission')
    expect(during.detail).toContain('The speech model is downloading meanwhile: 42%.')
  })

  it('shows the download, with Cancel, once nothing else needs doing', () => {
    expect(top({ speech: { ...notDownloaded, downloadProgress: 0.426 } })).toMatchObject({
      ready: false,
      title: 'Downloading the speech model, 42%',
      action: { does: 'cancel', label: 'Cancel' },
      progress: 0.426,
      needsUser: false,
    })
  })

  it('writes the size of the download in the unit a person would use', () => {
    expect(top({ speech: { ...notDownloaded, modelBytes: 1_200_000_000 } }).action).toEqual({
      does: 'download',
      label: 'Download (1.2 GB)',
    })
  })

  it('tells a screen reader of a change, and not of every step a download makes', () => {
    const at = (progress: number, change: StatusChange = {}) =>
      top({ ...change, speech: { ...notDownloaded, downloadProgress: progress } }).spoken

    expect(at(0.3)).toBe('Downloading the speech model')
    expect(at(0.33)).toBe(at(0.3))
    // Beside a permission, the download's figure is in the detail only.
    const waiting = { helper: { accessibilityTrusted: false, tapInstalled: false } }
    expect(at(0.3, waiting)).toBe('Waiting for the Accessibility permission')
    expect(at(0.33, waiting)).toBe(at(0.3, waiting))
  })

  it('tells a screen reader that dictation is ready, with the key in words', () => {
    expect(top().spoken).toBe('Ready. Hold Fn to dictate.')
    expect(homeStatus(status({ dictationKey: 'ctrlOption' }), '⌃⌥').spoken).toBe(
      'Ready. Hold Control Option to dictate.',
    )
    expect(
      homeStatus(status({ dictationKey: 'ctrlOption', conflict: 'Wispr Flow' }), '⌃⌥').spoken,
    ).toBe('Wispr Flow is also listening to Control Option')
  })

  it('tells a screen reader why a download stopped', () => {
    expect(top({ speech: { ...notDownloaded, downloadError: 'no space left' } }).spoken).toBe(
      'The speech model is not downloaded. The download stopped: no space left. ' +
        'What was downloaded is kept.',
    )
  })

  it('says why a download stopped, and offers to try again', () => {
    expect(
      top({
        speech: {
          ...notDownloaded,
          downloadError: 'Download of encoder.int8.onnx stalled: nothing arrived for 30 seconds',
        },
      }),
    ).toMatchObject({
      title: 'The speech model is not downloaded',
      problem:
        'The download stopped: Download of encoder.int8.onnx stalled: nothing arrived for ' +
        '30 seconds. What was downloaded is kept.',
      action: { does: 'tryAgain', label: 'Try again' },
    })
  })

  it('offers to check the files of a model that is there and will not start', () => {
    expect(top({ speech: { state: 'failed' } })).toMatchObject({
      title: 'Speech recognition could not start',
      action: { does: 'checkFiles', label: 'Check the model files' },
      needsUser: true,
    })
  })

  it('has nothing to press while the model is read or taken in', () => {
    expect(top({ speech: { state: 'loading', modelDownloaded: false } })).toMatchObject({
      ready: false,
      title: 'Checking the model files…',
      action: null,
    })
    expect(top({ speech: { state: 'modelMissing' } })).toMatchObject({
      ready: false,
      title: 'Loading the speech model…',
      action: null,
    })
  })

  it('waits for the shortcuts after the grant, and says when the helper is down', () => {
    expect(top({ helper: { tapInstalled: false } })).toMatchObject({
      ready: false,
      title: 'Starting the shortcuts…',
      action: null,
    })
    expect(
      top({ helper: { running: false, accessibilityTrusted: null, tapInstalled: null } }),
    ).toMatchObject({ title: 'The shortcut helper is not running', action: null, needsUser: true })
  })

  it('says whose permission macOS asks for in a development build', () => {
    const asked = top({
      packaged: false,
      helper: { accessibilityTrusted: false, tapInstalled: false },
    })
    expect(asked.detail).toContain('on behalf of the terminal that started the app')
    expect(
      top({ helper: { accessibilityTrusted: false, tapInstalled: false } }).detail,
    ).not.toContain('terminal')
  })

  it('always has a button for a thing the user has to do, bar a helper that restarts itself', () => {
    const cases: StatusChange[] = [
      { helper: { accessibilityTrusted: false, tapInstalled: false } },
      { microphone: 'not-determined' },
      { microphone: 'denied' },
      { speech: notDownloaded },
      { speech: { ...notDownloaded, downloadError: 'no space left' } },
      { speech: { state: 'failed' } },
    ]
    for (const change of cases) {
      const shown = top(change)
      expect(shown.needsUser && shown.action !== null, JSON.stringify(change)).toBe(true)
    }
  })
})

describe('the gestures and the microphone on Home', () => {
  it('lists the gestures of the key that is set', () => {
    expect(gestures('fn')).toEqual([
      { keys: ['Fn'], does: 'Hold to dictate' },
      { keys: ['Fn', 'Fn'], does: 'Press twice for hands-free' },
      { keys: ['esc'], does: 'Cancel' },
      { keys: ['⌘', '⌃', 'V'], does: 'Paste the last dictation' },
    ])
    expect(gestures('ctrlOption')[1]).toEqual({
      keys: ['⌃⌥', 'Space'],
      does: 'Lock on for hands-free',
    })
  })

  const builtIn = { deviceId: 'built-in', label: 'MacBook Pro Microphone (Built-in)' }
  const airpods = { deviceId: 'airpods', label: 'AirPods Pro' }

  it('says that the microphone is on only while dictating', () => {
    expect(microphoneCaption(status({ microphones: [builtIn] }))).toBe('On only while you dictate.')
  })

  it('says when the first choice is not connected', () => {
    const away = status({ microphones: [builtIn], microphoneOrder: [airpods, builtIn] })

    expect(microphoneCaption(away)).toBe('AirPods Pro is not connected.')
    expect(
      microphoneCaption(
        status({ microphones: [builtIn], microphoneOrder: [{ deviceId: 'x', label: '' }] }),
      ),
    ).toBe('Your first choice is not connected.')
  })
})

describe('modeCaption', () => {
  it('says what each mode does', () => {
    expect(modeCaption('verbatim', '')).toBe('Every word, with the recognizer’s punctuation.')
    expect(modeCaption('cleaned', 'Cleaned with qwen3.5:4b')).toBe(
      'The same words, tidied by a model on this Mac.',
    )
  })

  it("says why Cleaned is using the rules only, in the menu's own words", () => {
    expect(modeCaption('cleaned', 'Cleaned: rules only (Ollama is not running)')).toBe(
      'Rules only: Ollama is not running.',
    )
    expect(
      modeCaption('cleaned', 'Cleaned: rules only (the chosen model does not run on this Mac)'),
    ).toBe('Rules only: the chosen model does not run on this Mac.')
  })
})

describe('a pause and a second app on the key', () => {
  const until = new Date(2026, 9, 4, 11, 42).getTime()

  it('says until when dictation is paused, with the way to resume', () => {
    expect(top({ pausedUntil: until })).toMatchObject({
      ready: false,
      title: 'Paused until 11:42',
      action: { does: 'resume', label: 'Resume Dictation' },
      // A pause is the user's own doing: nothing needs their attention.
      needsUser: false,
    })
  })

  it('names the other app that listens to the key, and offers the other key', () => {
    expect(top({ conflict: 'Wispr Flow' })).toMatchObject({
      ready: false,
      title: 'Wispr Flow is also listening to Fn',
      action: { does: 'otherKey', label: 'Use ⌃⌥ Instead' },
      needsUser: true,
    })
  })

  it('puts what dictation cannot do without before either', () => {
    const blocked = top({
      pausedUntil: until,
      conflict: 'Wispr Flow',
      helper: { accessibilityTrusted: false, tapInstalled: false },
    })
    expect(blocked.title).toBe('Waiting for the Accessibility permission')
    expect(top({ pausedUntil: until, conflict: 'Wispr Flow' }).title).toBe('Paused until 11:42')
  })
})

describe('figures', () => {
  const said = (usage: Parameters<typeof figures>[0], short = false): string =>
    figures(usage)
      .map((figure) => figure.before + figure.number + (short ? figure.afterShort : figure.after))
      .join(' · ')

  it('gives the words of today and of the week, and the usual time', () => {
    expect(said({ wordsToday: 1_284, wordsThisWeek: 9_410, typicalMs: 384 })).toBe(
      '1,284 words today · 9,410 this week · usually 0.4 s from release to text',
    )
    expect(said({ wordsToday: 1_284, wordsThisWeek: 9_410, typicalMs: 1_100 }, true)).toBe(
      '1,284 words today · 9,410 this week · usually 1.1 s',
    )
  })

  it('leaves the usual time out until there is one', () => {
    expect(said({ wordsToday: 0, wordsThisWeek: 0, typicalMs: null })).toBe(
      '0 words today · 0 this week',
    )
  })

  it('counts one word as one word', () => {
    expect(said({ wordsToday: 1, wordsThisWeek: 1, typicalMs: null })).toBe(
      '1 word today · 1 this week',
    )
  })
})
