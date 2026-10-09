import { describe, expect, it } from 'vitest'
import { findOllama, isInstalled } from '../../src/main/cleanup/ollama-app'
import { ollamaAddress } from '../../src/main/hub/ollama-address'
import { OLLAMA_DOWNLOAD_URL, sourcePage, supportPage } from '../../src/main/support'
import { diagnostics } from '../../src/main/system/diagnostics'
import { OtherDictationApp, findDictationApp } from '../../src/main/system/other-dictation-app'

describe('the Ollama address a page may set', () => {
  it('takes an address on this Mac, and keeps only where it is', () => {
    expect(ollamaAddress(' http://127.0.0.1:11434/api/tags ', false)).toEqual({
      ok: true,
      url: 'http://127.0.0.1:11434',
    })
    expect(ollamaAddress('http://localhost:9000', false)).toMatchObject({ ok: true })
    expect(ollamaAddress('http://[::1]:11434', false)).toMatchObject({ ok: true })
  })

  it('refuses an address elsewhere: what is said would go to another machine', () => {
    expect(ollamaAddress('http://192.168.1.20:11434', false)).toEqual({
      ok: false,
      problem: 'Only an address on this Mac is accepted, such as http://127.0.0.1:11434.',
    })
    expect(ollamaAddress('https://ollama.example.com', false)).toMatchObject({ ok: false })
    // A name that only looks local is not this Mac.
    expect(ollamaAddress('http://127.0.0.1.example.com', false)).toMatchObject({ ok: false })
  })

  it('takes one elsewhere only when the settings file already allows it', () => {
    expect(ollamaAddress('http://192.168.1.20:11434', true)).toEqual({
      ok: true,
      url: 'http://192.168.1.20:11434',
    })
  })

  it('refuses what is not an address, and one that carries a password', () => {
    expect(ollamaAddress('ollama', false)).toMatchObject({ ok: false })
    expect(ollamaAddress('ftp://127.0.0.1', false)).toMatchObject({ ok: false })
    expect(ollamaAddress('http://user:secret@127.0.0.1:11434', false)).toMatchObject({ ok: false })
  })
})

describe('the pages the app can open in a browser', () => {
  it('opens only secure pages, and none before there is an address', () => {
    expect(sourcePage('', null)).toBeNull()
    expect(sourcePage('/issues/new', 'https://github.com/someone/whisper-flow/')?.href).toBe(
      'https://github.com/someone/whisper-flow/issues/new',
    )
    expect(sourcePage('', 'http://github.com/someone/whisper-flow')).toBeNull()
    expect(supportPage('https://elsewhere.example/coffee')).toBeNull()
    expect(new URL(OLLAMA_DOWNLOAD_URL).hostname).toBe('ollama.com')
  })
})

describe('whether Ollama is on this Mac', () => {
  it('finds the app, or the command-line tool, or neither', () => {
    const only = (place: string) => (path: string) => path === place

    expect(findOllama(only('/Applications/Ollama.app'))).toEqual({
      app: '/Applications/Ollama.app',
      tool: null,
    })
    expect(findOllama(only('/opt/homebrew/bin/ollama'))).toEqual({
      app: null,
      tool: '/opt/homebrew/bin/ollama',
    })
    expect(isInstalled(findOllama(() => false))).toBe(false)
    expect(isInstalled(findOllama(only('/usr/local/bin/ollama')))).toBe(true)
  })
})

describe('another dictation app on the same key', () => {
  const running = [
    '/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder',
    '/Applications/Wispr Flow.app/Contents/MacOS/Wispr Flow',
    '/Applications/Wispr Flow.app/Contents/Frameworks/Wispr Flow Helper.app/Contents/MacOS/Wispr Flow Helper',
  ].join('\n')

  it('is found among the running programs by its own executable', () => {
    expect(findDictationApp(running)).toBe('Wispr Flow')
    expect(findDictationApp('/Applications/Safari.app/Contents/MacOS/Safari')).toBeNull()
    // Its helper processes alone are not the app.
    expect(findDictationApp(running.split('\n')[2] ?? '')).toBeNull()
  })

  it('is looked for now and then, not at every asking', async () => {
    let looks = 0
    let now = 0
    const other = new OtherDictationApp(
      () => {
        looks += 1
        return Promise.resolve(running)
      },
      () => now,
    )

    expect(other.current()).toBeNull()
    await Promise.resolve()
    await Promise.resolve()
    expect(other.current()).toBe('Wispr Flow')
    expect(looks).toBe(1)

    now += 5_000
    other.current()
    expect(looks).toBe(2)
  })

  it('is not a conflict when the looking fails', async () => {
    const other = new OtherDictationApp(() => Promise.reject(new Error('no ps')))

    other.current()
    await Promise.resolve()
    await Promise.resolve()

    expect(other.current()).toBeNull()
  })

  it('can be told what to find, for a test', async () => {
    const other = new OtherDictationApp(() => Promise.resolve(running))
    // Left to itself it finds the app that is running.
    other.current()
    await Promise.resolve()
    await Promise.resolve()
    expect(other.current()).toBe('Wispr Flow')

    // Told that there is none, it says so although one is running; told a name, it says that.
    other.pretend(null)
    expect(other.current()).toBeNull()
    other.pretend('Another Dictation App')
    expect(other.current()).toBe('Another Dictation App')
  })
})

describe('the diagnostics', () => {
  it('describe the setup, and leave out what was said and the log', () => {
    const text = diagnostics({
      appVersion: '0.0.1',
      build: 'packaged',
      macOS: '26.6',
      chip: 'Apple M4 (arm64)',
      memoryGb: 16,
      electron: '44.5.1',
      helper: 'running, protocol 3, key tap on',
      accessibility: 'on',
      microphone: 'granted',
      speech: 'Parakeet v3, ready',
      mode: 'cleaned',
      cleanup: 'Cleaned with qwen3.5:4b',
      dictationKey: 'Fn',
      history: 'session, 23 listed',
      savingDictations: false,
      paused: false,
    })

    expect(text).toContain('Say the Word: 0.0.1 (packaged)')
    expect(text).toContain('Mac: Apple M4 (arm64), 16 GB')
    expect(text).toContain('Cleanup: Cleaned with qwen3.5:4b')
    expect(text).toContain('Saving every dictation: off')
    expect(text).toContain('The log is not included.')
  })
})
