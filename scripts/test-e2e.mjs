// End-to-end test of the running app: synthetic Fn presses go through the real event
// tap, a recording stands in for the microphone, and the transcript is pasted by the
// real paste transaction into a TextEdit document.
//
// It needs the Accessibility permission for whatever runs it (your terminal), and for
// about forty seconds it takes keyboard focus and listens to the Fn key: leave the
// keyboard and mouse alone while it runs. Everything that can be tested without
// doing that is in `npm run test:app` instead.
//
// What keeps it out of the way of someone who is using the Mac:
//   - it does not start while a call, a video or a recording is on;
//   - the app is started so that it refuses to paste into anything but TextEdit;
//   - before every synthetic key press the test confirms TextEdit is still frontmost,
//     and stops if it is not.
//
//   npm run test:e2e                       against the built output, run by Electron
//   npm run test:e2e -- --packaged          against the packaged app in dist/
//   npm run test:e2e -- --only "focus"      only the checks whose name contains the text
//   npm run test:e2e -- --when-idle 120     start once nobody has touched the Mac for 120 s
//   npm run test:e2e -- --even-if-in-use    run although a call or a video is on
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mayTakeTheKeyboard } from './lib/mac-in-use.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const helperPath = join(root, 'resources', 'bin', 'flow-helper')
const electronPath = createRequire(import.meta.url)('electron')
const packaged = process.argv.includes('--packaged')
const option = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : (process.argv[index + 1] ?? '')
}
const only = option('--only')
const whenIdle = Number(option('--when-idle') ?? 0)
const evenIfInUse = process.argv.includes('--even-if-in-use')
// Started directly rather than with `open`, so macOS attributes the Accessibility
// permission to the terminal running this test, which already holds it.
const packagedBinary = join(
  root,
  'dist',
  'mac-arm64',
  'Whisper Flow Dev.app',
  'Contents',
  'MacOS',
  'Whisper Flow Dev',
)
const toolEnv = { ...process.env, FLOW_HELPER_TEST_TOOLS: '1' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const TEXTEDIT = 'com.apple.TextEdit'
const FN = 63
const ESCAPE = 53
const COMMAND = 55
const CONTROL = 59
const LETTER_V = 9
/** How long the helper pretends Accessibility has not been granted yet. */
const GRANT_AFTER_MS = 2_500
// Not A, C, D, E, F, H, M, N or Q: with Fn held those are system Globe shortcuts
// (Fn+A moves keyboard focus to the Dock, for example).
const LETTER_B = 11
/** A key code no keyboard has, so the "another key" press does nothing in any app. */
const INERT_KEY = 255

// The recording that stands in for the microphone, and the words it contains.
const recording = join(root, 'tests', 'fixtures', 'audio', 'short.daniel.wav')
const SPOKEN = existsSync(recording)
  ? readFileSync(join(root, 'tests', 'fixtures', 'audio', 'short.txt'), 'utf8').trim()
  : ''
/** A word of the recording that appears once per paste, and nowhere else. */
const MARKER = 'quarterly'
/** Long enough to hold the key while the whole recording plays. */
const SPEAK_MS = existsSync(recording)
  ? Math.round(((statSync(recording).size - 44) / 32_000) * 1_000) + 400
  : 0
const words = (text) => text.toLowerCase().match(/[a-z0-9']+/g) ?? []

class FocusLost extends Error {}

const results = []
function record(name, status, detail = '') {
  results.push({ name, status })
  const mark = { ok: '  ok  ', FAIL: '  FAIL', skip: '  skip' }[status]
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}
let focusLost = false
/** `always`: part of the setup, so it runs whatever `--only` says. */
async function check(name, run, { always = false } = {}) {
  if (only && !always && !name.includes(only)) return
  if (focusLost) return record(name, 'skip', 'focus left TextEdit earlier')
  try {
    record(name, 'ok', (await run()) ?? '')
  } catch (error) {
    if (error instanceof FocusLost) {
      focusLost = true
      record(name, 'skip', error.message)
    } else {
      record(name, 'FAIL', error.message)
    }
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function focused() {
  const result = spawnSync(helperPath, ['--focused-value'], { env: toolEnv, encoding: 'utf8' })
  return JSON.parse(result.stdout || '{"found":false}')
}
/** The document's text, or FocusLost if TextEdit is no longer the frontmost app. */
function documentText() {
  const state = focused()
  if (state.bundleId !== TEXTEDIT) {
    throw new FocusLost(`focus moved to ${state.bundleId || 'another app'}; stopped posting keys`)
  }
  return state.value ?? ''
}
/** Posts key events, but only while TextEdit is frontmost. */
function postKeys(script) {
  documentText()
  const result = spawnSync(helperPath, ['--post-keys', script], { env: toolEnv, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`post-keys failed: ${result.stderr.trim()}`)
}
const occurrences = (text, part) => text.split(part).length - 1
const clipboardText = () => spawnSync('pbpaste', { encoding: 'utf8' }).stdout

if (packaged && !existsSync(packagedBinary)) {
  console.error('Package first: npm run pack')
  process.exit(1)
}
if (!packaged && !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('Build first: npm run build')
  process.exit(1)
}
if (!existsSync(recording)) {
  console.error('Generate the test recordings first: npm run fixtures')
  process.exit(1)
}
if (spawnSync('pgrep', ['-x', 'TextEdit']).status === 0) {
  console.log('  skip everything: TextEdit is already open; close it and run again.')
  process.exit(77)
}

if (!(await mayTakeTheKeyboard({ idleFor: whenIdle, evenIfInUse }))) process.exit(77)

const scratch = mkdtempSync(join(tmpdir(), 'flow-e2e-'))
let log = ''
console.log(packaged ? 'Testing the packaged app.' : 'Testing the built output under Electron.')
const [command, args] = packaged
  ? [packagedBinary, ['--hidden']]
  : [electronPath, [root, '--hidden']]
const app = spawn(command, args, {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WHISPER_FLOW_PASTE_ONLY_INTO: TEXTEDIT,
    WHISPER_FLOW_FAKE_MIC: `${recording}%noloop`,
    WHISPER_FLOW_MUTE: '1',
    WHISPER_FLOW_DEBUG_CONTROL: '1',
    WHISPER_FLOW_USER_DATA_DIR: scratch,
    // The helper behaves for a while as if Accessibility had not been granted yet, so
    // every run goes through what a first launch goes through.
    FLOW_HELPER_TEST_TOOLS: '1',
    FLOW_HELPER_GRANT_AFTER_MS: String(GRANT_AFTER_MS),
  },
})
/** The debug control line; used here only to slow processing down for one check. */
const control = (line) => app.stdin.write(`${line}\n`)
app.stdout.on('data', (chunk) => (log += chunk))
app.stderr.on('data', (chunk) => (log += chunk))
const clipboardBefore = clipboardText()

async function waitForLog(text, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (!log.includes(text)) {
    if (Date.now() > deadline) throw new Error(`app never logged "${text}"`)
    await sleep(100)
  }
}
async function waitForDocument(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = focused()
    if (state.found && state.bundleId === TEXTEDIT && state.role === 'AXTextArea') return
    if (Date.now() > deadline) throw new Error('the TextEdit document never took focus')
    await sleep(150)
  }
}

/** How many dictations the document holds: the marker word appears once in each. */
const pastes = () => occurrences(documentText(), MARKER)
const dictateChord = `${FN}:down,wait:${SPEAK_MS},${FN}:up`
const pasteLastChord = `${COMMAND}:down,${CONTROL}:down,${LETTER_V}:down,${LETTER_V}:up,${CONTROL}:up,${COMMAND}:up`

try {
  await check(
    'Accessibility granted after launch: a fresh helper takes over and shortcuts become active',
    async () => {
      await waitForLog('[dictation] waiting for the Accessibility permission', 10_000)
      await waitForLog('[helper] Accessibility was granted while it was running', 15_000)
      // Once for the helper that was running at the grant, once for the fresh one.
      const deadline = Date.now() + 15_000
      while (occurrences(log, '[dictation] shortcuts active') < 2) {
        if (Date.now() > deadline) throw new Error('the fresh helper never became active')
        await sleep(100)
      }
      expect(occurrences(log, '[helper] ready:') === 2, 'the helper was not replaced exactly once')
      await waitForLog('[speech] ready', 30_000)
    },
    { always: true },
  )

  const file = join(scratch, 'paste-target.txt')
  writeFileSync(file, '')
  spawnSync('open', ['-a', 'TextEdit', file])
  await waitForDocument()
  await sleep(500)

  await check('holding Fn while speaking pastes what was said into the document', async () => {
    postKeys(dictateChord)
    await sleep(1_500)
    const text = documentText()
    expect(
      words(text).join(' ') === words(SPOKEN).join(' '),
      `the document holds ${words(text).length} words, ${text.length} characters`,
    )
    return `${text.length} characters, word for word`
  })

  await check(
    'focus moved during processing: nothing is pasted, and the text is kept',
    async () => {
      const before = pastes()
      const refusals = occurrences(log, '[dictation] targetChanged')
      control('text-delay 2500')
      postKeys(dictateChord)
      // The destination was TextEdit when the key was released. Now another app comes
      // forward while the text is still being prepared. (Only from TextEdit: Finder is
      // not put over an app somebody has just brought forward.)
      documentText()
      spawnSync('open', ['-a', 'Finder'])
      await sleep(3_500)
      control('text-delay 0')
      expect(
        occurrences(log, '[dictation] targetChanged') === refusals + 1,
        'the app did not refuse the paste',
      )

      // Back to the document, unless someone has brought an app of their own forward.
      const front = focused().bundleId
      if (front !== 'com.apple.finder' && front !== TEXTEDIT) {
        throw new FocusLost(`focus moved to ${front || 'another app'}; stopped posting keys`)
      }
      spawnSync('open', ['-a', 'TextEdit'])
      await waitForDocument()
      await sleep(400)
      expect(pastes() === before, 'the document changed although focus had moved')

      // What was said is not lost: the paste-last shortcut brings it back.
      postKeys(pasteLastChord)
      await sleep(1_200)
      expect(pastes() === before + 1, 'paste-last did not bring the text back')
    },
  )

  await check('a second dictation pastes again', async () => {
    const before = pastes()
    postKeys(dictateChord)
    await sleep(1_500)
    expect(pastes() === before + 1, `the document holds ${pastes()} dictations`)
  })

  await check('the paste-last shortcut pastes the previous text again', async () => {
    // Cmd+Ctrl+V. Copy-last is covered by unit tests only: running it here would
    // replace whatever is on your clipboard.
    const before = pastes()
    postKeys(pasteLastChord)
    await sleep(1_200)
    expect(pastes() === before + 1, `the document holds ${pastes()} dictations`)
  })

  await check('a quick tap pastes nothing', async () => {
    const before = pastes()
    postKeys(`${FN}:down,wait:100,${FN}:up`)
    await sleep(900)
    expect(pastes() === before, `the document holds ${pastes()} dictations`)
  })

  await check('another key during the hold cancels silently', async () => {
    const before = pastes()
    postKeys(`${FN}:down,wait:200,${INERT_KEY}:down,${INERT_KEY}:up,wait:400,${FN}:up`)
    await sleep(900)
    expect(pastes() === before, `the document holds ${pastes()} dictations`)
  })

  await check(
    'typing while Fn is held reaches the document and cancels the dictation',
    async () => {
      const before = pastes()
      postKeys(`${FN}:down,wait:150,${LETTER_B}:down,${LETTER_B}:up,wait:400,${FN}:up`)
      await sleep(900)
      const text = documentText()
      expect(pastes() === before, `the document holds ${pastes()} dictations`)
      expect(text.endsWith('b'), 'the typed letter did not arrive')
    },
  )

  await check('Escape during the hold cancels the dictation', async () => {
    const before = pastes()
    postKeys(`${FN}:down,wait:400,${ESCAPE}:down,${ESCAPE}:up,wait:200,${FN}:up`)
    await sleep(900)
    expect(pastes() === before, `the document holds ${pastes()} dictations`)
    expect(log.includes('[dictation] cancelled'), 'the app did not log a cancel')
  })

  await check('the clipboard is back to what it was', async () => {
    await sleep(600)
    expect(clipboardText() === clipboardBefore, 'clipboard text differs from before the test')
  })

  await check('the log never contains what was said', async () => {
    expect(!log.toLowerCase().includes(MARKER), 'transcript text appeared in the app log')
  })
} finally {
  spawnSync('pkill', ['-x', 'TextEdit'])
  app.kill()
  rmSync(scratch, { recursive: true, force: true })
}

// Timings of the dictations that were pasted, through the real key tap and the real paste.
const pasted = log
  .split('\n')
  .filter((line) => line.startsWith('[metrics]') && line.includes('outcome=pasted'))
  .map((line) =>
    Object.fromEntries(
      line
        .split(' ')
        .slice(1)
        .map((field) => field.split('=')),
    ),
  )
if (pasted.length > 0) {
  const list = (field) => pasted.map((row) => row[field] ?? '?').join(', ')
  console.log(`\nTimings of the ${pasted.length} pasted dictations (ms):`)
  console.log(`  key press to audio flowing   ${list('micLiveMs')}`)
  console.log(`  key release to paste sent    ${list('releaseToPasteMs')}`)
  console.log(`  the paste itself             ${list('pasteMs')}`)
}

const failed = results.filter((result) => result.status === 'FAIL').length
const skipped = results.filter((result) => result.status === 'skip').length
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`)
if (skipped > 0)
  console.log('Some checks did not run. Run the test again without touching the keyboard or mouse.')
if (failed > 0) console.log(`--- app log ---\n${log.slice(-1500)}`)
process.exit(failed > 0 ? 1 : skipped > 0 ? 77 : 0)
