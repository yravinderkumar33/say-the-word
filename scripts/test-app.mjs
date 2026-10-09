// Tests whole dictations in the running app, without disturbing the person using the Mac.
//
// The app is started in a test mode that changes three things at its edges:
//   - a WAV file stands in for the microphone (Chromium's fake capture device);
//   - the shortcut helper creates no key tap, so the test neither sees nor swallows keys;
//     dictations are started and stopped through the app's debug control line instead;
//   - pastes are counted and scored instead of being typed into the app in front.
// Everything between those edges is the real thing: the overlay's capture, the speech
// worker and its model, the session rules, the recovery buffer.
//
// What it cannot cover is covered elsewhere: the real key tap and the real paste by
// `npm run test:e2e`, which takes keyboard focus for about half a minute.
//
//   npm run test:app                      every scenario once
//   npm run test:app -- --repeat 10       the dependability run
//   npm run test:app -- --only cancel     scenarios whose name contains "cancel"
//   npm run test:app -- --latency 20      20 dictations of about 9 s, for the latency gate
//   npm run test:app -- --real-mic 20     opens the real microphone 20 times and cancels,
//                                         to time how long it takes to go live
//   npm run test:app -- --packaged        against the packaged app in dist/
//   npm run test:app -- --packaged --package-dir dist/.qa-security-fixes/mac-arm64
//                                         against a separately staged package
//   npm run test:app -- --live-ollama 5   Cleaned mode with the real Ollama on this machine
//                                         and its real model, five dictations
import { DatabaseSync } from 'node:sqlite'
import { spawn, spawnSync } from 'node:child_process'
import {
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { switches } from './lib/args.mjs'
import { take } from './lib/build-output.mjs'
import { wavFileDurationMs } from './lib/wav.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const {
  packaged = false,
  'package-dir': packageDir = join(root, 'dist', 'mac-arm64'),
  repeat = 1,
  only,
  latency: latencyRuns = 0,
  'history-load': historyLoadRows = 0,
  'real-mic': realMicRuns = 0,
  'live-ollama': liveOllamaRuns = 0,
  verbose = false,
} = switches({
  packaged: { type: 'boolean' },
  'package-dir': { type: 'string' },
  repeat: { type: 'number' },
  only: { type: 'string' },
  latency: { type: 'number' },
  'history-load': { type: 'number' },
  'real-mic': { type: 'number' },
  'live-ollama': { type: 'number' },
  verbose: { type: 'boolean' },
})

// The app is run from the build in out/ (or from the package): nobody builds over it meanwhile.
const inUse = take('test:app')
if (inUse) {
  console.error(inUse)
  process.exit(1)
}
const fixtures = join(root, 'tests', 'fixtures', 'audio')
const electronPath = createRequire(import.meta.url)('electron')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const packagedBinary = join(
  packageDir,
  'Say the Word Dev.app',
  'Contents',
  'MacOS',
  'Say the Word Dev',
)

/** The synthetic voice is transcribed word for word; this leaves room for one slip. */
const MAX_WER = 0.15
const VOICE = 'daniel'
/** Words that occur in the recordings and in no log line the app should ever write. */
const SPOKEN_WORDS = ['quarterly', 'invoice', 'Thursday', 'drawings']

// --- Preconditions -------------------------------------------------------------------

if (packaged ? !existsSync(packagedBinary) : !existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error(packaged ? 'Package first: npm run pack' : 'Build first: npm run build')
  process.exit(1)
}
if (!existsSync(join(fixtures, `short.${VOICE}.wav`))) {
  console.error('Generate the test recordings first: npm run fixtures')
  process.exit(1)
}
const MODEL_ID = 'parakeet-tdt-0.6b-v3-int8'
const modelDir =
  process.env.WHISPER_FLOW_MODELS_DIR ??
  join(homedir(), 'Library', 'Application Support', 'Whisper Flow', 'models')
if (!existsSync(join(modelDir, MODEL_ID, '.verified.json'))) {
  console.error('Download the speech model first: npm run models:download')
  process.exit(1)
}

// --- The app under test --------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'flow-app-test-'))
const microphoneFile = join(scratch, 'microphone.wav')
/** Where the app under test saves dictations in evaluation mode: never the real folder. */
const evaluationDir = join(scratch, 'evaluation')
const fixture = (name) => {
  const path = join(fixtures, `${name}.${VOICE}.wav`)
  return {
    name,
    path,
    text: readFileSync(join(fixtures, `${name}.txt`), 'utf8').trim(),
    ms: Math.round(wavFileDurationMs(path)),
  }
}
// The recording with an amount of money in it is left out on purpose: the recognizer
// writes amounts differently from one run of the process to the next (see
// docs/benchmarks.md), which says nothing about the plumbing these scenarios test.
const SHORT = fixture('short')
const MEDIUM = fixture('medium')
const VERY_LONG = fixture('very-long')
copyFileSync(SHORT.path, microphoneFile)

if (historyLoadRows > 0) {
  if (![10000, 100000].includes(historyLoadRows))
    throw new Error('Use --history-load 10000 or 100000')
  mkdirSync(join(scratch, 'history'), { recursive: true, mode: 0o700 })
  writeFileSync(
    join(scratch, 'settings.json'),
    JSON.stringify({ version: 1, historyKeep: 'week', firstRun: 'done' }),
    { mode: 0o600 },
  )
  const database = new DatabaseSync(join(scratch, 'history', 'history.sqlite'))
  const schema = /const CREATE = `([\s\S]*?)`/.exec(
    readFileSync(join(root, 'src/main/history/history-store.ts'), 'utf8'),
  )?.[1]
  if (!schema) throw new Error('Benchmark schema not found')
  database.exec(
    schema +
      ';PRAGMA user_version=1;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA temp_store=MEMORY;PRAGMA secure_delete=ON;BEGIN IMMEDIATE',
  )
  const put = database.prepare(
    'INSERT INTO history(id,ended_at,app,outcome,mode,heard,written,preview,search_text,has_text) VALUES (?,?,?,?,?,?,?,?,?,1)',
  )
  const text = 'synthetic benchmark '.repeat(50)
  for (let i = 0; i < historyLoadRows; i++)
    put.run(
      'seed-' + i,
      Date.now() - i,
      'Synthetic',
      'pasted',
      'verbatim',
      text,
      text,
      text.slice(0, 240),
      (text + '\n' + text + '\nSynthetic').toLowerCase(),
    )
  database.exec('COMMIT')
  database.close()
  console.log(`Seeded ${historyLoadRows} synthetic entries for concurrent history/retention load.`)
}

let app = null
let log = ''
let exited = false

/** Starts the app in its test mode. One instance runs at a time. */
function launch(extraEnv = {}) {
  log = ''
  exited = false
  const [command, commandArgs] = packaged
    ? [packagedBinary, ['--hidden']]
    : [electronPath, [root, '--hidden']]
  const child = spawn(command, commandArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WHISPER_FLOW_DEBUG_CONTROL: '1',
      WHISPER_FLOW_QUIET: '1',
      WHISPER_FLOW_MUTE: '1',
      WHISPER_FLOW_USER_DATA_DIR: scratch,
      WHISPER_FLOW_EVAL_DIR: evaluationDir,
      // Pastes are counted once `quiet-paste` is sent. Were it ever not to take effect, a
      // paste would go to the helper, and this refuses it: no app has this bundle id.
      WHISPER_FLOW_PASTE_ONLY_INTO: 'test.say-the-word.nowhere',
      ...(realMicRuns > 0 ? {} : { WHISPER_FLOW_FAKE_MIC: `${microphoneFile}%noloop` }),
      ...extraEnv,
    },
  })
  const collect = (chunk) => {
    log += chunk
    if (verbose) process.stdout.write(chunk)
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.once('exit', () => {
    if (app === child) exited = true
  })
  // A line sent while the app is going fails to arrive. That is not this script failing:
  // `exited` says what happened, and the scenario that sent it fails of that.
  child.stdin.on('error', () => {})
  app = child
}

async function quit() {
  const child = app
  if (!child || child.exitCode !== null) return
  const gone = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([gone, sleep(3_000)])
  // An app that has not gone by now is not left running beside the next one.
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await Promise.race([gone, sleep(2_000)])
  }
}

// Whatever ends this script, the app it started ends with it, and its data folder goes.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    console.error(`\nThe test script itself failed: ${error?.stack ?? error}`)
    app?.kill('SIGKILL')
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // A process of the app's that has not gone yet may still be writing there.
    }
    process.exit(1)
  })
}

const send = (line) => app.stdin.write(`${line}\n`)
const count = (text) => log.split(text).length - 1

async function waitForLog(text, timeoutMs, from = 0) {
  const deadline = Date.now() + timeoutMs
  while (!log.includes(text, from)) {
    if (exited) throw new Error('the app exited')
    if (Date.now() > deadline) throw new Error(`the app never logged "${text}"`)
    await sleep(25)
  }
}

/** The app's own account of itself: states and counts, never text. */
async function status() {
  const marker = 'DEBUG_STATUS '
  const before = count(marker)
  send('status')
  const deadline = Date.now() + 5_000
  while (count(marker) === before) {
    if (exited) throw new Error('the app exited')
    if (Date.now() > deadline) throw new Error('the app did not answer a status request')
    await sleep(15)
  }
  const line = log.slice(log.lastIndexOf(marker) + marker.length).split('\n')[0]
  return JSON.parse(line)
}

async function waitUntil(what, test, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const state = await status()
    if (test(state)) return state
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; state: ${JSON.stringify(state)}`)
    }
    await sleep(60)
  }
}
const waitIdle = (timeoutMs) => waitUntil('idle', (state) => state.state === 'idle', timeoutMs)

/** The timings the app logged for a session, as an object of numbers. */
function metricsOf(session) {
  const match = new RegExp(`\\[metrics\\] session=${session} (.*)`).exec(log)
  if (!match) return null
  return Object.fromEntries(
    match[1].split(' ').map((field) => {
      const [name, value] = field.split('=')
      return [name, Number.isNaN(Number(value)) ? value : Number(value)]
    }),
  )
}

/** Makes the fake microphone play this recording, and tells the app what to score against. */
function play(recording) {
  copyFileSync(recording.path, microphoneFile)
  send(`expect ${Buffer.from(recording.text).toString('base64')}`)
}

/** Presses the shortcut and returns the session that started. */
async function press() {
  send('press')
  const state = await waitUntil('a session to start', (now) => now.session !== null, 3_000)
  return state.session
}

/** A whole dictation: press, speak the recording, release, wait for the outcome. */
async function dictate(recording, extraHoldMs = 400) {
  play(recording)
  const session = await press()
  await sleep(recording.ms + extraHoldMs)
  send('release')
  const state = await waitIdle(20_000)
  return { session, state }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}
const pastesOf = (state, session) => state.pastes.filter((paste) => paste.session === session)
const entryOf = (state, session) => state.recovery.find((entry) => entry.session === session)

function expectPastedIntact(state, session, what = 'the dictation') {
  const pastes = pastesOf(state, session)
  expect(pastes.length === 1, `${what}: expected one paste, saw ${pastes.length}`)
  expect(
    pastes[0].wer !== null && pastes[0].wer <= MAX_WER,
    `${what}: word error rate ${pastes[0].wer}`,
  )
  expect(entryOf(state, session)?.outcome === 'pasted', `${what}: not recorded as pasted`)
}

async function expectMicrophoneReleased() {
  const state = await waitUntil(
    'the microphone to be released',
    (now) => now.openMicrophones === 0,
    2_000,
  )
  return state
}

// --- The main window -------------------------------------------------------------------

const base64 = (text) => Buffer.from(text).toString('base64')

/** Shows a page of the main window (which is never shown on screen) and waits until it is drawn. */
async function showPage(name, heading) {
  send(`hub-page ${name}`)
  return waitUntil(`the ${name} page`, (now) => (now.hub?.heading ?? '').startsWith(heading), 6_000)
}

/**
 * The History page as it is when one comes to it: nothing selected, so that the first
 * arrow key selects the newest row. Shown a second time without leaving, it keeps the
 * row that the scenario before selected.
 */
async function historyFromTheTop() {
  send('hub-page home')
  await waitUntil('another page', (now) => now.hub !== null && now.hub.heading !== 'History', 4_000)
  await showPage('history', 'History')
  // The page hears of new rows when it next asks: the keys wait until they are drawn.
  return waitUntil('the rows', (now) => now.hub.rows === now.history.count, 5_000)
}

/**
 * Presses a button of the main window by its label, as a click would. Returns what
 * became of it: `pressed`, `covered` (something lies over it) or `missing`.
 */
async function pressHub(label, tries = 12) {
  let outcome = 'missing'
  for (let attempt = 0; attempt < tries && outcome === 'missing'; attempt++) {
    if (attempt > 0) await sleep(300)
    const from = log.length
    send(`press-hub ${label.replace(/ /g, '_')}`)
    await waitForLog(`hub button "${label}": `, 3_000, from)
    outcome = log.slice(from).split(`hub button "${label}": `)[1]?.split('\n')[0] ?? 'missing'
  }
  return outcome
}

/** How often the app has been asked a question of this kind in a system dialog. */
const askedOf = (state, kind) => state.asked.filter((asked) => asked === kind).length

/** A dictation with the test's own words, put straight into the history. */
function addToHistory(entry) {
  send(`add-history ${base64(JSON.stringify(entry))}`)
}

/** The files of the history on disk: one to a day. */
const historyFiles = () => {
  const dir = join(scratch, 'history')
  return existsSync(dir)
    ? readdirSync(dir).filter((name) =>
        /^(?:history\.sqlite(?:-journal)?|\d{4}-\d{2}-\d{2}\.json(?:\.tmp)?)$/.test(name),
      )
    : []
}

// --- A stand-in for Ollama -----------------------------------------------------------

/**
 * Cleaned mode is tested against this instead of a real model: it answers on a loopback
 * port the way Ollama does, and can be told to be slow, wrong, or not local.
 */
const ollama = {
  /** echo | slow | garbage | remoteModel | remoteAlias | remoteReply | remoteWarmUp | emptyWarmUp | incompleteWarmUp */
  behaviour: 'echo',
  /** How long the model list takes to come back. */
  tagsDelayMs: 0,
  /** Every request of any kind. */
  requests: 0,
  /** Every chat request, warm-ups included. */
  chats: 0,
  /** Warm-up requests only; no transcript content. */
  warms: 0,
  /** The transcripts that chat requests carried. They are compared, never printed. */
  transcripts: [],
  url: '',
}
const ollamaServer = createServer((request, response) => {
  ollama.requests += 1
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const json = (value) => response.end(JSON.stringify(value))
    const lines = (...values) =>
      response.end(values.map((value) => `${JSON.stringify(value)}\n`).join(''))
    if (request.url === '/api/version') return json({ version: 'stand-in' })
    if (request.url === '/api/tags') {
      // A new fingerprint for each behaviour, so the app looks at the model again.
      const entry = (name) => ({
        name,
        digest: `${name}-${ollama.behaviour}`,
        capabilities: ['completion'],
        ...(ollama.behaviour === 'remoteModel' ? { remote_host: 'https://ollama.com' } : {}),
      })
      const models = [
        entry('stand-in:latest'),
        entry('leaky:latest'),
        entry('leaky-at-once:latest'),
        entry('empty-warm:latest'),
        entry('incomplete-warm:latest'),
        entry('replaced:latest'),
      ]
      return setTimeout(() => json({ models }), ollama.tagsDelayMs)
    }
    if (request.url === '/api/show') {
      return json({
        capabilities: ['completion'],
        ...(ollama.behaviour === 'remoteAlias' ? { remote_model: 'someone-elses:cloud' } : {}),
      })
    }
    if (request.url !== '/api/chat') return response.writeHead(404).end('{}')

    ollama.chats += 1
    const last = JSON.parse(body).messages.at(-1)
    const transcript = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(last.content)?.[1]
    const done = {
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      eval_count: 12,
      eval_duration: 4e8,
    }
    // A warm-up carries the instructions and no transcript.
    if (last.role !== 'user' || transcript === undefined) {
      ollama.warms += 1
      if (ollama.behaviour === 'emptyWarmUp') return response.end()
      if (ollama.behaviour === 'incompleteWarmUp') {
        return lines({ message: { role: 'assistant', content: '' }, done: false })
      }
      return ollama.behaviour === 'remoteWarmUp'
        ? lines({ ...done, remote_host: 'https://ollama.com' })
        : lines(done)
    }
    ollama.transcripts.push(transcript)

    const say = (text) => ({ message: { role: 'assistant', content: text } })
    if (ollama.behaviour === 'slow') return // Never answers; the app's deadline ends it.
    if (ollama.behaviour === 'garbage') {
      return lines(say('I am sorry, but I cannot help with that request today.'), done)
    }
    if (ollama.behaviour === 'remoteReply') {
      return lines(say(transcript), { ...done, remote_host: 'https://ollama.com' })
    }
    return lines(say(transcript.slice(0, 12)), say(transcript.slice(12)), done)
  })
})
await new Promise((resolve) => ollamaServer.listen(0, '127.0.0.1', resolve))
ollama.url = `http://127.0.0.1:${ollamaServer.address().port}`

/**
 * A second stand-in, at an address of its own: it lists a model like any Ollama, and
 * answers every chat request with a redirect to a third server. Whatever reaches that
 * third server is something the app sent where nobody had checked.
 */
const elsewhere = { arrived: 0, url: '' }
const elsewhereServer = createServer((request, response) => {
  request.resume()
  request.on('end', () => {
    elsewhere.arrived += 1
    response.end('{}')
  })
})
await new Promise((resolve) => elsewhereServer.listen(0, '127.0.0.1', resolve))
elsewhere.url = `http://127.0.0.1:${elsewhereServer.address().port}`
const redirector = { chats: 0, transcripts: 0, url: '' }
const redirectingServer = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    if (request.url === '/api/tags') {
      const model = { name: 'stand-in:latest', digest: 'redirecting', capabilities: ['completion'] }
      return response.end(JSON.stringify({ models: [model] }))
    }
    if (request.url === '/api/show') {
      return response.end(JSON.stringify({ capabilities: ['completion'] }))
    }
    // Asked by a page that shows Ollama's state: it is there, like any Ollama.
    if (request.url === '/api/version') return response.end(JSON.stringify({ version: 'stand-in' }))
    // Only a chat is sent on: anything else that is asked for is not there.
    if (request.url !== '/api/chat') return response.writeHead(404).end('{}')
    redirector.chats += 1
    // As the other stand-in tells a transcript from a warm-up: by the last message.
    const last = JSON.parse(body).messages?.at(-1)
    if (last?.role === 'user' && /<transcript>\n[\s\S]*\n<\/transcript>/.test(last.content)) {
      redirector.transcripts += 1
    }
    response.writeHead(307, { location: `${elsewhere.url}${request.url}` })
    return response.end()
  })
})
await new Promise((resolve) => redirectingServer.listen(0, '127.0.0.1', resolve))
redirector.url = `http://127.0.0.1:${redirectingServer.address().port}`

/** Runs a scenario in Cleaned mode against the stand-in, then goes back to Verbatim. */
async function inCleanedMode(behaviour, run, { url = ollama.url, model = 'stand-in' } = {}) {
  ollama.behaviour = behaviour
  send(`ollama-url ${url}`)
  send(`cleanup-model ${model}`)
  send('mode cleaned')
  try {
    await waitUntil('Cleaned mode', (now) => now.mode === 'cleaned', 2_000)
    return await run()
  } finally {
    send('mode verbatim')
  }
}
const sameWords = (a, b) =>
  a
    .toLowerCase()
    .match(/[a-z0-9']+/g)
    .join(' ') ===
  b
    .toLowerCase()
    .match(/[a-z0-9']+/g)
    .join(' ')

// --- Scenarios -----------------------------------------------------------------------

const scenarios = []
/** `once`: too long to repeat; it runs in the first round only. */
const scenario = (name, run, { once = false } = {}) => scenarios.push({ name, run, once })

scenario(
  'before Cleaned mode is used, the app has contacted nothing at all',
  async () => {
    // Read from the app itself: it is what the Privacy page shows.
    const { contacted } = (await status()).privacy
    expect(contacted.length === 0, `the app has contacted ${contacted.join(', ')}`)
  },
  { once: true },
)

scenario('a dictation arrives intact', async () => {
  const { session, state } = await dictate(SHORT)
  expectPastedIntact(state, session)
  await expectMicrophoneReleased()
  // Held while the session ran, in case of a cancel and an Undo; not after it.
  await waitUntil('the recording to be let go', (now) => now.holdsRecording === false, 2_000)
})

scenario('a second dictation straight after the first has its own text', async () => {
  const first = await dictate(SHORT)
  const second = await dictate(MEDIUM)
  expectPastedIntact(first.state, first.session, 'first')
  // Scored against the second recording's words: the first one's text would fail.
  expectPastedIntact(second.state, second.session, 'second')
  expect(second.session === first.session + 1, 'sessions are not consecutive')
})

scenario('the pill shows starting, listening, processing, then rests', async () => {
  send('text-delay 800')
  try {
    play(SHORT)
    await press()
    const early = await status()
    expect(
      ['starting', 'listening'].includes(early.pill),
      `pill shows ${early.pill} after the press`,
    )
    await waitUntil('listening', (now) => now.pill === 'listening', 2_000)
    await sleep(SHORT.ms)
    send('release')
    await waitUntil('processing', (now) => now.pill === 'processing', 2_000)
    await waitIdle()
    const after = await waitUntil('resting', (now) => now.pill === 'resting', 2_000)
    expect(after.overlayTakesClicks === false, 'the pill window is catching clicks at rest')
  } finally {
    send('text-delay 0')
  }
})

scenario('the pill buttons work: Cancel during processing, then Dismiss', async () => {
  const before = await status()
  send('text-delay 1500')
  try {
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms + 400)
    send('release')
    await waitUntil('processing', (now) => now.pill === 'processing', 2_000)
    // The window lets clicks through until the pointer is on a button.
    expect(
      (await status()).overlayTakesClicks === false,
      'clicks are caught before the pointer arrives',
    )
    const from = log.length
    send('click-pill Cancel')
    await waitForLog('pointer on the pill; window takes clicks: true', 2_000, from)
    const state = await waitIdle()
    expect(entryOf(state, session)?.outcome === 'cancelled', 'the Cancel button did not cancel')

    await waitUntil('the Cancelled message', (now) => now.pill === 'recovery', 2_000)
    send('click-pill Dismiss')
    // Once the message is gone and the pointer has left, clicks pass through again.
    await waitUntil(
      'the pill at rest, letting clicks through',
      (now) => now.pill === 'resting' && now.overlayTakesClicks === false,
      2_000,
    )
    await sleep(1_600)
    expect((await status()).pastes.length === before.pastes.length, 'something was pasted')
  } finally {
    send('text-delay 0')
  }
})

scenario(
  'a button that vanishes under the pointer does not leave the window catching clicks',
  async () => {
    play(SHORT)
    await press()
    await sleep(700)
    send('escape')
    await waitUntil('the Cancelled message', (now) => now.pill === 'recovery', 2_000)
    // The pointer stays where the button was. The pill shrinks away from under it, and no
    // "pointer left" is ever reported for a button that no longer exists.
    send('click-pill Dismiss stay')
    await waitUntil(
      'clicks to pass through again',
      (now) => now.pill === 'resting' && now.overlayTakesClicks === false,
      2_000,
    )
    // Back to a known place for the scenarios that follow.
    send('click-pill Pill')
    await waitUntil('hands-free', (now) => now.state === 'locked', 2_000)
    send('escape')
    await waitIdle()
  },
)

scenario('Cancel is offered on a text only once it has taken a second', async () => {
  send('text-delay 2500')
  try {
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms + 400)
    send('release')
    const early = await waitUntil('processing', (now) => now.pill === 'processing', 2_000)
    // A text that arrives in a moment gets no button: it would only flash by.
    expect(early.pillCancel === false, 'Cancel was offered at once')
    await waitUntil('the Cancel button', (now) => now.pillCancel === true, 2_500)
    const state = await waitIdle()
    expectPastedIntact(state, session)
    await waitUntil('the pill at rest', (now) => now.pill === 'resting', 2_000)
  } finally {
    send('text-delay 0')
  }
})

scenario('the hint appears only once the pointer has rested on the pill', async () => {
  send('hover-pill')
  await sleep(200)
  // Passing over the pill on the way to the Dock shows nothing.
  expect((await status()).pillShape === 'rest', 'the hint appeared at once')
  await waitUntil('the hint', (now) => now.pillShape === 'hint', 1_500)
  send('unhover-pill')
  await waitUntil(
    'the pill at rest, letting clicks through',
    (now) => now.pillShape === 'rest' && now.overlayTakesClicks === false,
    2_000,
  )
})

scenario(
  'text that was not pasted leaves a mark on the resting pill until it is fetched',
  async () => {
    /** A dictation that is interrupted: never pasted, its text kept, and the pill says so. */
    const keptText = async () => {
      play(SHORT)
      const session = await press()
      await sleep(SHORT.ms + 300)
      send('abort')
      await waitUntil(
        'the text to be kept',
        (now) => now.pill === 'recovery' && entryOf(now, session)?.hasText === true,
        10_000,
      )
    }
    /** The same, with the message dismissed: the mark is what is left of it. */
    const interrupted = async () => {
      await keptText()
      send('click-pill Dismiss')
      await waitUntil('the mark', (now) => now.pill === 'resting' && now.pillWaiting, 2_000)
      // The click's pointer leaves a moment after the click: let it go before the next move.
      await sleep(250)
    }

    await interrupted()
    // Its hint says how to fetch the text, in place of the usual one.
    send('hover-pill')
    await waitUntil('the hint for waiting text', (now) => now.pillShape === 'waitingHint', 1_500)
    send('unhover-pill')
    await waitUntil('the pill at rest', (now) => now.pillShape === 'rest', 2_000)

    // Pasting it fetches it.
    const before = (await status()).pastes.length
    send('paste-last')
    const pasted = await waitUntil('the mark to go', (now) => now.pillWaiting === false, 3_000)
    expect(pasted.pastes.length === before + 1, 'paste-last did not paste')

    // So does the next dictation: the mark is about the last one.
    await interrupted()
    const { session, state } = await dictate(SHORT)
    expectPastedIntact(state, session)
    const after = await waitUntil('the pill at rest', (now) => now.pill === 'resting', 2_000)
    expect(after.pillWaiting === false, 'the mark outlived the next dictation')

    // A press of the key that is no dictation at all (a lone tap) leaves the mark alone:
    // the text is still there to be fetched.
    await interrupted()
    send('press')
    await sleep(120)
    send('release')
    await waitIdle()
    const tapped = await waitUntil('the pill at rest', (now) => now.pill === 'resting', 2_000)
    expect(tapped.pillWaiting === true, 'a lone tap took the mark away')
    send('paste-last')
    await waitUntil('the mark to go', (now) => now.pillWaiting === false, 3_000)

    // Fetched while its message is still on the pill: the message goes with it, and
    // leaves no mark for text that is no longer waiting.
    await keptText()
    send('paste-last')
    const fetched = await waitUntil('the message to go', (now) => now.pill === 'resting', 3_000)
    expect(fetched.pillWaiting === false, 'a mark was left for text that had been pasted')
  },
)

scenario('the menu offers what the pill offers, for hands that are on the keyboard', async () => {
  play(SHORT)
  await press()
  await sleep(700)
  send('escape')
  await waitUntil(
    'Undo in the menu',
    (now) => now.pill === 'recovery' && now.trayOffer === 'Undo',
    2_000,
  )
  send('click-pill Dismiss')
  await waitUntil(
    'the offer to go with the message',
    (now) => now.pill === 'resting' && now.trayOffer === null,
    2_000,
  )

  send('hands-free')
  await waitUntil('Stop in the menu', (now) => now.pillHandsFree && now.trayHandsFree, 2_000)
  send('escape')
  await waitUntil(
    'Stop to leave the menu with the recording',
    (now) => now.state === 'idle' && now.trayHandsFree === false,
    3_000,
  )
  send('click-pill Dismiss')
  await waitUntil('the pill at rest', (now) => now.pill === 'resting', 2_000)
})

scenario(
  'the Stop Saving button of the main window can be clicked, and stops the saving',
  async () => {
    send('evaluation on')
    try {
      await waitUntil('the saving to start', (now) => now.evaluationRecording === true, 2_000)
      // The window asks for its status every second and a half: the bar is there after that.
      let outcome = 'missing'
      for (let tries = 0; tries < 12 && outcome === 'missing'; tries++) {
        await sleep(400)
        const from = log.length
        send('press-hub Stop_Saving')
        await waitForLog('hub button "Stop Saving": ', 3_000, from)
        outcome = /hub button "Stop Saving": (\w+)/.exec(log.slice(from))?.[1] ?? 'missing'
      }
      // "covered" is a button that is drawn and cannot be clicked: something lies over it.
      expect(outcome === 'pressed', `the button was ${outcome}`)
      await waitUntil('the saving to stop', (now) => now.evaluationRecording === false, 3_000)
    } finally {
      send('evaluation off')
    }
  },
)

scenario('the window counts a dictation and lists it, without its words', async () => {
  const before = (await status()).figures
  const { session, state } = await dictate(SHORT)
  expectPastedIntact(state, session)
  const after = state.figures
  const spoken = SHORT.text.split(/\s+/).length
  const counted = after.wordsToday - before.wordsToday
  expect(
    counted > 0 && Math.abs(counted - spoken) <= 2,
    `counted ${counted} words for a dictation of ${spoken}`,
  )
  expect(after.wordsThisWeek - before.wordsThisWeek === counted, 'the week did not follow the day')
  expect(after.recent[0] === 'pasted', `the newest dictation is listed as ${after.recent[0]}`)
})

scenario('the history lists a dictation, in memory: nothing is written to disk', async () => {
  const before = (await status()).history
  const { session, state } = await dictate(SHORT)
  expectPastedIntact(state, session)
  const after = state.history
  expect(
    after.count === before.count + 1,
    `the history went from ${before.count} to ${after.count}`,
  )
  expect(
    after.newest[0]?.outcome === 'pasted' && after.newest[0].hasText,
    `the newest dictation is listed as ${JSON.stringify(after.newest[0])}`,
  )
  expect(
    after.keep === 'session' && after.onDisk === false && after.bytes === 0,
    'the history is not held in memory only',
  )
  expect(historyFiles().length === 0, 'a file was written although nothing is kept on disk')
  // The menu's Recent offers it too.
  expect(state.trayRecent >= 1, 'the menu does not list the dictation')
})

scenario(
  'a storage process that stops: the history it held in memory is said lost, and listing goes on',
  async () => {
    // The History page is open throughout: it must follow what happens, not only a fresh look.
    await showPage('history', 'History')
    const { session, state } = await dictate(SHORT)
    expectPastedIntact(state, session)
    const held = state.history.count
    expect(held >= 1, `nothing was listed before the storage process stopped (${held})`)
    await waitUntil('the dictation on the page', (now) => now.hub.rows === held, 8_000)
    // The real utility process ends, as a crash would end it.
    send('kill-storage')
    const gone = await waitUntil(
      'the loss said, and the page emptied',
      (now) =>
        now.history.lost >= held && now.hub.rows === 0 && now.hub.notices.includes('history-lost'),
      8_000,
    )
    expect(gone.history.count === 0, `the list still shows ${gone.history.count} dictations`)
    // The next dictation is listed by a storage process started in its place, and the page shows it.
    const again = await dictate(SHORT)
    expectPastedIntact(again.state, again.session)
    const listed = await waitUntil(
      'listed again',
      (now) => now.history.count === 1 && now.hub.rows === 1,
      8_000,
    )
    expect(listed.history.lost === gone.history.lost, 'the loss is no longer said')
    // Deleting the history takes the notice with it, and leaves the next scenario a clean list.
    send('answer-dialogs yes')
    try {
      expect((await pressHub('Delete All…')) === 'pressed', 'Delete All could not be pressed')
      const cleared = await waitUntil(
        'the history deleted',
        (now) => now.history.count === 0 && now.history.lost === 0,
        8_000,
      )
      expect(!cleared.history.diskProblem, 'a problem is still said after Delete All')
    } finally {
      send('answer-dialogs none')
    }
  },
)

scenario(
  'the history says how a dictation ended, and when its text was fetched afterwards',
  async () => {
    /** A dictation that is interrupted: never pasted, and its text kept. */
    const keptText = async () => {
      play(SHORT)
      const session = await press()
      await sleep(SHORT.ms + 300)
      send('abort')
      await waitUntil(
        'the text to be kept',
        (now) => now.pill === 'recovery' && entryOf(now, session)?.hasText === true,
        10_000,
      )
      return waitUntil(
        'the history to list it',
        (now) => now.history.newest[0]?.outcome === 'interrupted' && now.history.newest[0].hasText,
        3_000,
      )
    }

    const kept = await keptText()
    expect(kept.history.newest[0].fetched === null, 'the text is listed as fetched already')
    // Copied: counted, because a test must not write over the clipboard of whoever is at the Mac.
    const copies = kept.reached.copy ?? 0
    send('copy-last')
    const copied = await waitUntil(
      'the copy to be noted',
      (now) => now.history.newest[0]?.fetched === 'copied',
      3_000,
    )
    expect((copied.reached.copy ?? 0) === copies + 1, 'the copy was not made through the door')
    await waitUntil('the pill at rest', (now) => now.pill === 'resting', 4_000)

    // And one that is pasted afterwards, with the shortcut.
    await keptText()
    send('paste-last')
    await waitUntil(
      'the paste to be noted',
      (now) => now.history.newest[0]?.fetched === 'pasted',
      3_000,
    )
    await waitUntil('the pill at rest', (now) => now.pill === 'resting', 8_000)
  },
)

scenario('a paused history lists nothing new, and the dictation still arrives', async () => {
  send('setting history-paused on')
  try {
    const before = await waitUntil('the pause', (now) => now.history.paused === true, 2_000)
    const { session, state } = await dictate(SHORT)
    expectPastedIntact(state, session)
    expect(
      state.history.count === before.history.count,
      'a dictation was listed while the history was paused',
    )
    // Paste-last still has it: the safety net is not the history.
    expect(entryOf(state, session)?.hasText === true, 'the text was not kept for paste-last')
  } finally {
    send('setting history-paused off')
    await waitUntil('the history to resume', (now) => now.history.paused === false, 2_000)
  }
})

scenario(
  'keeping the history on disk is asked in a system dialog, and nothing is written without a yes',
  async () => {
    const { session, state: dictated } = await dictate(SHORT)
    expectPastedIntact(dictated, session)
    await showPage('history', 'History')
    try {
      // Answered with no: nothing changes, and nothing is written.
      send('answer-dialogs no')
      const before = await status()
      send('choose-hub Keep week')
      await waitUntil(
        'the question to be put',
        (now) => askedOf(now, 'keepHistory:week') === askedOf(before, 'keepHistory:week') + 1,
        4_000,
      )
      await sleep(300)
      const refused = await status()
      expect(
        refused.history.keep === 'session' && historyFiles().length === 0,
        'the history went to disk although the dialog was answered with no',
      )

      // Answered with yes: what is listed is written, for this user only.
      send('answer-dialogs yes')
      send('choose-hub Keep week')
      const kept = await waitUntil(
        'the history on disk',
        (now) => now.history.keep === 'week',
        4_000,
      )
      expect(kept.history.onDisk && kept.history.bytes > 0, 'nothing was written to disk')
      // One SQLite database, regardless of the local/UTC date.
      const files = historyFiles()
      expect(
        files.length === 1 && files[0] === 'history.sqlite',
        `there are ${files.length} history files`,
      )
      const file = join(scratch, 'history', files.at(-1))
      expect((statSync(file).mode & 0o777) === 0o600, 'the file can be read by other users')
      // The words are the ones the test played: they are in the file, and nowhere in the log.
      const word = SHORT.text.split(/\s+/).find((item) => /^[a-z]{5,}$/i.test(item))
      expect(
        readFileSync(file, 'utf8').toLowerCase().includes(word.toLowerCase()),
        'the dictation is not in the file',
      )
      expect(!log.toLowerCase().includes(word.toLowerCase()), 'what was said is in the log')

      // A dictation made now is written as it ends.
      const next = await dictate(SHORT)
      expectPastedIntact(next.state, next.session)
      const grown = await waitUntil(
        'the new dictation on disk',
        (now) => now.history.count > kept.history.count && !now.history.diskProblem,
        3_000,
      )

      // Back to memory: the files go, and the list stays until the app quits.
      send('choose-hub Keep session')
      const back = await waitUntil(
        'the history back in memory',
        (now) => now.history.keep === 'session',
        4_000,
      )
      expect(askedOf(back, 'keepHistory:session') >= 1, 'going back to memory was not asked')
      expect(
        historyFiles().length === 0 && back.history.bytes === 0,
        'files were left on disk after keeping stopped',
      )
      expect(back.history.count === grown.history.count, 'the list did not stay as it was')
    } finally {
      send('answer-dialogs yes')
      send('choose-hub Keep session')
      await waitUntil('the history in memory', (now) => now.history.keep === 'session', 4_000)
      send('answer-dialogs none')
    }
  },
)

scenario(
  'the History list is worked from the keyboard: arrows, Return, ⌘C and Delete',
  async () => {
    const listed = (await showPage('history', 'History')).hub
    const copiedChips = (state) => state.hub.chips.filter((chip) => chip === 'Copied').length
    // Words of the test's own, dated a moment ahead so that they are the newest three.
    for (const [index, app] of ['Notes', 'Mail', 'Slack'].entries()) {
      addToHistory({
        written: `A dictation the test wrote itself, number ${index + 1}`,
        app,
        agoMs: -(index + 1) * 1_000,
        outcome: 'focusMoved',
      })
    }
    // The page hears of them when it next asks: the keys wait until they are drawn.
    await waitUntil('the new rows', (now) => now.hub.rows === listed.rows + 3, 5_000)
    send('focus-hub [role="listbox"]')
    // The first press of an arrow selects the newest row, the next one moves on.
    send('key-hub ArrowDown')
    const atFirst = await waitUntil(
      'a row to be selected',
      (now) => now.hub.selected !== null,
      2_000,
    )
    send('key-hub ArrowDown')
    const atSecond = await waitUntil(
      'the selection to move',
      (now) => now.hub.selected !== atFirst.hub.selected,
      2_000,
    )

    // ⌘C copies the selected row, and the row says so.
    const copies = atSecond.reached.copy ?? 0
    send('key-hub c meta')
    const copied = await waitUntil(
      'the copy',
      (now) =>
        (now.reached.copy ?? 0) === copies + 1 && copiedChips(now) === copiedChips(atSecond) + 1,
      3_000,
    )
    // It is the second of the test's own rows that was copied: Mail.
    expect(
      copied.history.newest[1]?.app === 'Mail' && copied.history.newest[1].fetched === 'copied',
      'the row that was copied is not the one that was selected',
    )

    // Delete removes it, and the keyboard stays in the list, on the row that followed.
    send('key-hub Delete')
    const removed = await waitUntil(
      'the row to go',
      (now) =>
        now.history.count === copied.history.count - 1 &&
        now.hub.selected !== null &&
        now.hub.selected !== atSecond.hub.selected,
      3_000,
    )
    expect(removed.hub.selected !== atFirst.hub.selected, 'the selection went back up the list')
    expect(
      removed.history.newest
        .slice(0, 2)
        .map((row) => row.app)
        .join() === 'Slack,Notes',
      'the row that was deleted is not the one that was selected',
    )

    // A key that is kept down deletes no more: one press, one dictation.
    send('key-hub Delete held')
    send('key-hub Backspace held')
    await sleep(500)
    const held = await status()
    expect(held.history.count === removed.history.count, 'a held key went on deleting')
    expect(held.hub.selected === removed.hub.selected, 'a held key moved the selection')

    // Return opens the row: the page is headed by the app the dictation was meant for.
    send('key-hub Enter')
    const opened = await waitUntil('the row to open', (now) => now.hub.heading === 'Notes', 3_000)
    expect(
      opened.hub.notices.includes('reason'),
      'the opened row does not say why it was not pasted',
    )
    // Back: the list is as it was left, the same row selected and the keyboard on it.
    expect((await pressHub('Back to History')) === 'pressed', 'Back could not be pressed')
    const back = await waitUntil('the list again', (now) => now.hub.heading === 'History', 3_000)
    expect(back.hub.selected === removed.hub.selected, 'the selection was lost on the way back')
    await waitUntil('the keyboard on the list', (now) => now.hub.focus === 'Dictations', 2_000)
    send('key-hub Enter')
    await waitUntil('the row to open again', (now) => now.hub.heading === 'Notes', 3_000)
    // Deleted from here, the page goes back to the list.
    expect((await pressHub('Delete')) === 'pressed', 'Delete could not be pressed')
    await waitUntil(
      'the list again, without the row',
      (now) => now.hub.heading === 'History' && now.history.count === removed.history.count - 1,
      3_000,
    )
  },
)

scenario('Delete All asks first, and deletes only on a yes', async () => {
  addToHistory({ written: 'A dictation the test wrote itself', app: 'Notes' })
  await showPage('history', 'History')
  const before = await waitUntil('a history to delete', (now) => now.history.count > 0, 2_000)
  try {
    send('answer-dialogs no')
    expect((await pressHub('Delete All…')) === 'pressed', 'Delete All could not be pressed')
    const asked = await waitUntil(
      'the question to be put',
      (now) => askedOf(now, 'deleteHistory') === askedOf(before, 'deleteHistory') + 1,
      4_000,
    )
    expect(asked.history.count === before.history.count, 'the history was deleted on a no')

    send('answer-dialogs yes')
    await pressHub('Delete All…')
    const emptied = await waitUntil(
      'the history to be empty',
      (now) => now.history.count === 0 && now.hub.rows === 0,
      4_000,
    )
    expect(emptied.trayRecent === 0, 'the menu still lists a dictation')
    // With nothing to act on, the button is switched off.
    expect(
      (await pressHub('Delete All…', 1)) === 'disabled',
      'Delete All is on with nothing to delete',
    )
  } finally {
    send('answer-dialogs none')
  }
})

scenario('pausing dictation turns the shortcuts off, and the menu says until when', async () => {
  const from = log.length
  send('pause')
  try {
    const paused = await waitUntil('the pause', (now) => now.paused === true, 2_000)
    expect(
      /^Paused until \d\d:\d\d\. Shortcuts are off$/.test(paused.trayStatus),
      `the menu says "${paused.trayStatus}"`,
    )
    play(SHORT)
    const pastesBefore = paused.pastes.length
    // The key, the hands-free shortcut and a click on the pill: none starts anything.
    for (const attempt of ['press', 'hands-free', 'click-pill Pill', 'paste-last']) {
      send(attempt)
      await sleep(attempt.startsWith('click') ? 700 : 300)
      const state = await status()
      expect(
        state.state === 'idle' && state.session === null,
        `"${attempt}" started something while dictation was paused`,
      )
      expect(state.pill === 'resting', `"${attempt}" made the pill say something while paused`)
      // A paste-last that got through leaves the app idle and the pill at rest as well.
      expect(
        state.pastes.length === pastesBefore,
        `"${attempt}" pasted something while dictation was paused`,
      )
    }
    send('release')
  } finally {
    send('pause off')
  }
  await waitUntil('dictation to resume', (now) => now.paused === false, 2_000)
  expect(
    !log.includes('could not set the shortcut table', from),
    'the helper refused the shortcut table',
  )
  const { session, state } = await dictate(SHORT)
  expectPastedIntact(state, session)
})

scenario('the menu-bar icon says what the app is doing: live, paused, saving', async () => {
  // The instance has no key tap: told that it has one, it can show more than "needs attention".
  send('pretend-ready on')
  try {
    await waitUntil('the icon at rest', (now) => now.trayIcon === 'ready', 2_000)
    expect(
      (await status()).trayStatus === 'Ready. Hold Fn to dictate',
      'the menu does not say that dictation is ready',
    )
    play(SHORT)
    await press()
    await waitUntil(
      'the icon while the microphone is live',
      (now) => now.pill === 'listening' && now.trayIcon === 'live',
      4_000,
    )
    send('escape')
    await waitIdle()
    send('click-pill Dismiss')
    await waitUntil('the icon at rest again', (now) => now.trayIcon === 'ready', 3_000)

    send('evaluation on')
    await waitUntil(
      'the icon while dictations are saved',
      (now) => now.trayIcon === 'saving',
      2_000,
    )
    // A pause comes before the saving: one shape at a time.
    send('pause')
    await waitUntil('the icon while paused', (now) => now.trayIcon === 'paused', 2_000)
    send('pause off')
    send('evaluation off')
    await waitUntil('the icon at rest', (now) => now.trayIcon === 'ready', 2_000)
    send('pretend-ready off')
    await waitUntil(
      'the icon for a Mac that is not set up',
      (now) => now.trayIcon === 'attention',
      2_000,
    )
  } finally {
    send('pause off')
    send('evaluation off')
    send('pretend-ready off')
  }
})

scenario(
  'the pill can be hidden at rest: it is there for a dictation, and gone again',
  async () => {
    send('setting pill-at-rest off')
    try {
      await waitUntil('the pill to go', (now) => now.pillShape === 'hidden', 2_000)
      play(SHORT)
      const session = await press()
      await waitUntil('the pill for the dictation', (now) => now.pillShape === 'mic', 3_000)
      await sleep(SHORT.ms + 400)
      send('release')
      const state = await waitIdle(20_000)
      expectPastedIntact(state, session)
      const after = await waitUntil(
        'the pill to go again',
        (now) => now.pillShape === 'hidden',
        3_000,
      )
      expect(
        after.overlayTakesClicks === false,
        'a hidden pill takes clicks meant for the app below',
      )
    } finally {
      send('setting pill-at-rest on')
      await waitUntil('the pill at rest', (now) => now.pillShape === 'rest', 2_000)
    }
  },
)

scenario('the dictation key can be changed, and the menu names the new one', async () => {
  const from = log.length
  send('pretend-ready on')
  try {
    send('setting key ctrlOption')
    await waitUntil(
      'the key to change',
      (now) => now.prefs.key === 'ctrlOption' && now.trayStatus === 'Ready. Hold ⌃⌥ to dictate',
      2_000,
    )
    const { session, state } = await dictate(SHORT)
    expectPastedIntact(state, session)
    // The helper took the new table: Control and Option together, in place of Fn.
    await sleep(300)
    expect(
      !log.includes('could not set the shortcut table', from),
      'the helper refused the shortcut table',
    )
  } finally {
    send('setting key fn')
    send('pretend-ready off')
    await waitUntil('the key to be Fn again', (now) => now.prefs.key === 'fn', 2_000)
  }
})

scenario(
  'the Settings page changes a setting, and refuses an Ollama address that is not on this Mac',
  async () => {
    await showPage('settings', 'Settings')
    const before = await status()
    try {
      expect((await pressHub('Play sounds')) === 'pressed', 'the switch could not be pressed')
      await waitUntil('sounds to be off', (now) => now.prefs.sounds === false, 2_000)
      await pressHub('Play sounds')
      await waitUntil('sounds to be on again', (now) => now.prefs.sounds === true, 2_000)

      send('choose-hub Dictation_key ctrlOption')
      await waitUntil('the key to change', (now) => now.prefs.key === 'ctrlOption', 2_000)
      send('choose-hub Dictation_key fn')
      await waitUntil('the key to change back', (now) => now.prefs.key === 'fn', 2_000)

      // An address elsewhere would send what is said to another machine: a page cannot set one.
      send('focus-hub input[aria-label="Ollama address"]')
      send(`type-hub Ollama_address ${base64('http://192.168.1.20:11434')}`)
      await sleep(200)
      send('key-hub Enter')
      const refused = await waitUntil(
        'the refusal',
        (now) => now.hub.notices.includes('setting-problem'),
        3_000,
      )
      expect(
        refused.prefs.ollamaUrl === before.prefs.ollamaUrl,
        'an address on another machine was taken from the page',
      )
      // One on this Mac is taken.
      send(`type-hub Ollama_address ${base64('http://localhost:11434')}`)
      await sleep(200)
      send('key-hub Enter')
      await waitUntil(
        'the address to change',
        (now) => now.prefs.ollamaUrl === 'http://localhost:11434',
        3_000,
      )
    } finally {
      send(`ollama-url ${before.prefs.ollamaUrl}`)
      send('setting key fn')
    }
  },
)

scenario('the Privacy page says what is stored, and deletes it only after a yes', async () => {
  // A saved dictation, so that there is something on disk.
  send('evaluation on')
  await waitUntil('the saving to start', (now) => now.evaluationRecording === true, 2_000)
  const { session, state: dictated } = await dictate(SHORT)
  expectPastedIntact(dictated, session)
  send('evaluation off')
  await showPage('privacy', 'Privacy')
  try {
    const saved = await waitUntil(
      'the saved dictation to be counted',
      (now) => now.privacy.recordings >= 1,
      5_000,
    )
    send('answer-dialogs no')
    expect(
      (await pressHub('Delete Evaluation recordings…')) === 'pressed',
      'the Delete button could not be pressed',
    )
    const asked = await waitUntil(
      'the question to be put',
      (now) =>
        askedOf(now, 'deleteStored:recordings') === askedOf(saved, 'deleteStored:recordings') + 1,
      4_000,
    )
    expect(
      asked.privacy.recordings === saved.privacy.recordings && savedDictations().length > 0,
      'the recordings were deleted on a no',
    )

    send('answer-dialogs yes')
    await pressHub('Delete Evaluation recordings…')
    await waitUntil('the recordings to go', (now) => now.privacy.recordings === 0, 4_000)
    expect(savedDictations().length === 0, 'files of the saved dictations were left behind')

    // Show in Finder is counted here, not done: a test brings nothing to the front.
    const shown = (await status()).reached.showInFinder ?? 0
    expect((await pressHub('Show Log in Finder')) === 'pressed', 'Show in Finder is switched off')
    await waitUntil(
      'the log to be shown',
      (now) => (now.reached.showInFinder ?? 0) === shown + 1,
      2_000,
    )

    // Everything: the history, the counts and the log go together.
    addToHistory({ written: 'A dictation the test wrote itself', app: 'Notes' })
    await waitUntil('something to delete', (now) => now.history.count > 0, 2_000)
    await pressHub('Delete Everything…')
    const emptied = await waitUntil(
      'everything to go',
      (now) =>
        askedOf(now, 'deleteStored:everything') >= 1 &&
        now.history.count === 0 &&
        now.privacy.countsBytes === 0,
      4_000,
    )
    expect(emptied.figures.wordsToday === 0, 'the words of today are still counted')
    expect(emptied.privacy.problem === null, 'something could not be deleted')
  } finally {
    send('evaluation off')
    send('answer-dialogs none')
  }
})

scenario(
  'Try it on the Cleanup page gives a sentence to the model on this Mac, and is not a dictation',
  async () => {
    await inCleanedMode('echo', async () => {
      const before = await showPage('cleanup', 'Cleanup')
      const given = ollama.transcripts.length
      const sentence = 'um so the report is uh ready for the the team to read today'
      send(`type-hub A_sentence_to_try ${base64(sentence)}`)
      const deadline = Date.now() + 8_000
      while (ollama.transcripts.length === given && Date.now() < deadline) await sleep(50)
      expect(ollama.transcripts.length === given + 1, 'the sentence was not given to the model')
      // What the model is given has been through the rules: the hesitations are gone.
      const transcript = ollama.transcripts.at(-1)
      expect(
        !/\b(um|uh)\b/i.test(transcript) && /report/.test(transcript),
        'the model was not given the rules-only text',
      )
      await sleep(400)
      const after = await status()
      expect(
        after.history.count === before.history.count &&
          after.pastes.length === before.pastes.length,
        'a sentence that was tried was treated as a dictation',
      )
      // Answered, the page settles: nothing more is given to the model while nothing changes.
      const answered = ollama.transcripts.length
      await sleep(3_500)
      expect(
        ollama.transcripts.length === answered,
        `the sentence was given to the model ${ollama.transcripts.length - answered} more times`,
      )
    })
  },
)

scenario(
  'the first run leads to a dictation: its exercises are ticked off as each is done',
  async () => {
    send('first-run again')
    try {
      const welcome = await waitUntil(
        'the first run',
        (now) => now.hub.steps.length >= 6 && now.hub.steps[0] === 'welcome:current',
        6_000,
      )
      expect(
        !welcome.hub.steps.some((step) => step.startsWith('keys:')),
        'the Keys step is shown although no other app is on the key',
      )
      expect((await pressHub('Get started')) === 'pressed', 'Get started could not be pressed')
      await waitUntil(
        'the microphone step',
        (now) =>
          now.hub.steps.includes('welcome:done') && now.hub.steps.includes('microphone:current'),
        3_000,
      )

      // The exercises, reached whatever the permissions of this Mac are.
      send('first-run-step try')
      const practice = await waitUntil(
        'the practice',
        (now) => now.hub.steps.includes('try:current'),
        3_000,
      )
      expect(practice.hub.ticks === 0, 'an exercise is ticked before anything was dictated')
      expect((await pressHub('Continue', 1)) === 'disabled', 'Continue is on before the exercises')
      // The text lands where the keyboard is: with the model ready, that is the box.
      await waitUntil(
        'the keyboard in the practice box',
        (now) => now.hub.focus === 'Practice box',
        2_000,
      )
      // A window of a test never has the keyboard: said, the exercises are the practice they are.
      send('own-window on')
      const listedBefore = (await status()).history.count

      // One: hold the key and say a sentence.
      const held = await dictate(SHORT)
      expectPastedIntact(held.state, held.session)
      await waitUntil('the first tick', (now) => now.hub.ticks === 1, 5_000)

      // Two: hands-free, then the key again to stop.
      play(SHORT)
      send('hands-free')
      await waitUntil('hands-free', (now) => now.pillHandsFree, 3_000)
      await sleep(SHORT.ms + 300)
      send('stop')
      await waitIdle(20_000)
      await waitUntil('the second tick', (now) => now.hub.ticks === 2, 5_000)

      // Three: Esc, then Undo on the pill.
      play(SHORT)
      await press()
      await sleep(SHORT.ms + 300)
      send('escape')
      await waitUntil('Undo', (now) => now.pill === 'recovery' && now.trayOffer === 'Undo', 3_000)
      send('click-pill Undo')
      await waitIdle(20_000)
      const practised = await waitUntil('the third tick', (now) => now.hub.ticks === 3, 5_000)
      // "Nothing here is kept": not the two that were pasted, and not the one that was
      // cancelled before its destination was ever read.
      expect(
        practised.history.count === listedBefore,
        `${practised.history.count - listedBefore} of the exercises were listed in the history`,
      )
      send('own-window off')

      // With all three done the way on is open: Cleaned mode is skipped, and the run ends.
      expect((await pressHub('Continue')) === 'pressed', 'Continue is off after the exercises')
      await waitUntil('the Cleaned step', (now) => now.hub.steps.includes('cleaned:current'), 3_000)
      expect(
        (await pressHub('Skip and keep Verbatim')) === 'pressed',
        'the step could not be skipped',
      )
      await waitUntil('the last step', (now) => now.hub.steps.includes('ready:current'), 3_000)
      expect((await pressHub('Start dictating')) === 'pressed', 'the first run could not be ended')
      const done = await waitUntil(
        'the first run to be over',
        // The app closes the window as the run ends: a look taken just then finds no page.
        (now) => now.prefs.firstRun === 'done' && now.hub !== null && now.hub.steps.length === 0,
        6_000,
      )
      expect(done.mode === 'verbatim', 'skipping Cleaned mode did not keep Verbatim')
      // The switch on the last step was left on, as it is for a new installation.
      expect(done.prefs.openAtLogin === true, 'Open at login was not set although it was on')
    } finally {
      send('own-window off')
      send('first-run done')
    }
  },
)

scenario(
  'the first run keeps to the choices made in it: rules only, and no opening at login',
  async () => {
    ollama.behaviour = 'echo'
    send(`ollama-url ${ollama.url}`)
    // Open at login is on, as a first run that was finished leaves it.
    await showPage('settings', 'Settings')
    if ((await status()).prefs.openAtLogin !== true) {
      expect((await pressHub('Open at login')) === 'pressed', 'Open at login could not be set')
    }
    await waitUntil('Open at login to be on', (now) => now.prefs.openAtLogin === true, 2_000)
    send('first-run again')
    try {
      await waitUntil('the first run', (now) => now.hub.steps.length >= 6, 6_000)
      send('first-run-step cleaned')
      // Ollama lists models; until something is picked, the model the settings name is shown.
      await waitUntil(
        'a model to be picked',
        (now) =>
          now.hub.steps.includes('cleaned:current') &&
          now.hub.checked.length === 1 &&
          now.hub.checked[0] !== 'Rules only (no model)',
        8_000,
      )
      expect(
        (await pressHub('Rules only (no model)')) === 'pressed',
        '"Rules only" could not be pressed',
      )
      await waitUntil(
        'rules only to be chosen',
        (now) => now.hub.checked.join() === 'Rules only (no model)',
        2_000,
      )
      // The models are asked for again every few seconds: the pick stands all the same.
      await sleep(3_200)
      const still = await status()
      expect(
        still.hub.checked.join() === 'Rules only (no model)',
        `the pick was taken back: "${still.hub.checked.join()}" is chosen`,
      )
      expect((await pressHub('Use Cleaned')) === 'pressed', 'Use Cleaned could not be pressed')
      await waitUntil(
        'Cleaned mode with the rules only',
        (now) =>
          now.mode === 'cleaned' &&
          now.prefs.cleanupModel === null &&
          now.hub.steps.includes('ready:current'),
        4_000,
      )

      // Switched off on the last step, the login item that was on is taken away.
      expect((await pressHub('Open at login')) === 'pressed', 'the switch could not be pressed')
      expect((await pressHub('Start dictating')) === 'pressed', 'the first run could not be ended')
      const done = await waitUntil(
        'the first run to be over',
        // The app closes the window as the run ends: a look taken just then finds no page.
        (now) => now.prefs.firstRun === 'done' && now.hub !== null && now.hub.steps.length === 0,
        6_000,
      )
      expect(
        done.prefs.openAtLogin === false,
        'Open at login stayed on although it was switched off',
      )
    } finally {
      send('first-run done')
      send('mode verbatim')
      send('cleanup-model stand-in')
    }
  },
)

scenario(
  "a practice in one of the app's own windows is listed nowhere, however it ends",
  async () => {
    const before = await status()
    send('own-window on')
    try {
      // Ended by Esc while the key is held: before the destination is ever read.
      play(SHORT)
      await press()
      await sleep(600)
      send('escape')
      await waitUntil('the Cancelled message', (now) => now.pill === 'recovery', 3_000)
      send('click-pill Dismiss')
      await waitUntil('the pill at rest', (now) => now.pill === 'resting', 2_000)
      await sleep(250)

      // Ended from outside, with its text kept.
      play(SHORT)
      const session = await press()
      await sleep(SHORT.ms + 300)
      send('abort')
      await waitUntil(
        'the text to be kept',
        (now) => now.pill === 'recovery' && entryOf(now, session)?.hasText === true,
        10_000,
      )
      send('click-pill Dismiss')
      await waitUntil('the pill at rest', (now) => now.pill === 'resting', 2_000)
      await sleep(250)

      // And pasted.
      const pasted = await dictate(SHORT)
      expectPastedIntact(pasted.state, pasted.session)
      const after = await status()
      expect(
        after.history.count === before.history.count,
        `${after.history.count - before.history.count} practice dictations were listed`,
      )
    } finally {
      send('own-window off')
    }
    // The same anywhere else is listed: the keyboard's place is what made the difference.
    const { session, state } = await dictate(SHORT)
    expectPastedIntact(state, session)
    await waitUntil(
      'the dictation to be listed',
      (now) => now.history.count === before.history.count + 1,
      2_000,
    )
  },
)

scenario(
  'the mark for unpasted text goes when that text is copied from the window, and stays when another is',
  async () => {
    /** A dictation that is interrupted: never pasted, its text kept, and the pill says so. */
    const keptText = async () => {
      play(SHORT)
      const session = await press()
      await sleep(SHORT.ms + 300)
      send('abort')
      await waitUntil(
        'the text to be kept',
        (now) => now.pill === 'recovery' && entryOf(now, session)?.hasText === true,
        10_000,
      )
    }
    // An older dictation, pasted, to copy later; then one whose text is left waiting.
    const older = await dictate(SHORT)
    expectPastedIntact(older.state, older.session)
    await keptText()
    send('click-pill Dismiss')
    await waitUntil('the mark', (now) => now.pill === 'resting' && now.pillWaiting, 2_000)
    await sleep(250)

    // Copied from the History page: it is the text the mark stands for, so the mark goes.
    const listed = await historyFromTheTop()
    expect(
      listed.history.newest[0]?.outcome === 'interrupted',
      'the newest row is not the kept text',
    )
    send('focus-hub [role="listbox"]')
    send('key-hub ArrowDown')
    await waitUntil('the newest row to be selected', (now) => now.hub.selected !== null, 2_000)
    send('key-hub c meta')
    await waitUntil(
      'the mark to go with the copy',
      (now) => now.pill === 'resting' && now.pillWaiting === false,
      5_000,
    )

    // While a message is offering unpasted text, the older dictation is copied. "Copied"
    // takes the message's place, and the mark is left for the text that nobody fetched.
    await keptText()
    const copies = (await status()).reached.copy ?? 0
    send('key-hub ArrowDown')
    await sleep(200)
    send('key-hub c meta')
    await waitUntil('the copy', (now) => (now.reached.copy ?? 0) === copies + 1, 3_000)
    const left = await waitUntil('the pill at rest again', (now) => now.pill === 'resting', 5_000)
    expect(left.pillWaiting === true, 'the mark for the text nobody fetched was lost')

    // Fetched with the shortcut, it goes.
    send('copy-last')
    await waitUntil(
      'the mark to go',
      (now) => now.pill === 'resting' && now.pillWaiting === false,
      5_000,
    )
  },
)

scenario("a copy of an opened dictation's text carries the text and nothing else", async () => {
  addToHistory({
    app: 'Notes',
    agoMs: -30_000,
    mode: 'cleaned',
    note: 'cleaned',
    heard: 'um the report is uh ready for thursday',
    written: 'The report is ready for Thursday.',
  })
  await historyFromTheTop()
  send('focus-hub [role="listbox"]')
  send('key-hub ArrowDown')
  await waitUntil('a row to be selected', (now) => now.hub.selected !== null, 2_000)
  send('key-hub Enter')
  await waitUntil('the row to open', (now) => now.hub.heading === 'Notes', 3_000)
  try {
    // Each mark carries words for a screen reader. Selecting a text must not select them.
    const from = log.length
    send('check-selection')
    await waitForLog('[debug] selection: ', 3_000, from)
    const said = log.slice(from).split('[debug] selection: ')[1]?.split('\n')[0] ?? ''
    expect(/^2 texts, 0 spoken-only$/.test(said), `a selection of the texts: ${said}`)
  } finally {
    await pressHub('Delete')
    await waitUntil('the list again', (now) => now.hub.heading === 'History', 3_000)
  }
})

scenario('in a small window, what is at the top of a page can still be clicked', async () => {
  addToHistory({ app: 'Notes', agoMs: -30_000, written: 'A dictation the test wrote itself' })
  send('size-hub 720x480')
  try {
    await historyFromTheTop()
    // The strip that moves the window lies over the top of the page, and over this switch.
    expect(
      (await pressHub('Pause history')) === 'pressed',
      'the switch at the top of the page cannot be clicked',
    )
    await waitUntil('the pause', (now) => now.history.paused === true, 2_000)
    expect((await pressHub('Pause history')) === 'pressed', 'the switch cannot be clicked back')
    await waitUntil('the pause to end', (now) => now.history.paused === false, 2_000)

    send('focus-hub [role="listbox"]')
    send('key-hub ArrowDown')
    await waitUntil('a row to be selected', (now) => now.hub.selected !== null, 2_000)
    send('key-hub Enter')
    await waitUntil('the row to open', (now) => now.hub.heading === 'Notes', 3_000)
    expect(
      (await pressHub('Back to History')) === 'pressed',
      'the way back from an opened dictation cannot be clicked',
    )
    await waitUntil('the list again', (now) => now.hub.heading === 'History', 3_000)
    send('key-hub Delete')
  } finally {
    send('size-hub 900x720')
  }
})

scenario(
  'the arrow keys move the choice of mode and the keyboard together, there and back',
  async () => {
    await showPage('cleanup', 'Cleanup')
    try {
      send('focus-hub [role="radio"][aria-checked="true"]')
      await waitUntil('the keyboard on Verbatim', (now) => now.hub.focus === 'Verbatim', 2_000)
      send('key-hub ArrowRight')
      await waitUntil(
        'Cleaned to be chosen, with the keyboard on it',
        (now) => now.mode === 'cleaned' && now.hub.focus === 'Cleaned',
        3_000,
      )
      // The second arrow starts from where the keyboard now is, and so can go back.
      send('key-hub ArrowLeft')
      await waitUntil(
        'Verbatim to be chosen again, with the keyboard on it',
        (now) => now.mode === 'verbatim' && now.hub.focus === 'Verbatim',
        3_000,
      )
    } finally {
      send('mode verbatim')
      // The Cleanup page goes on asking Ollama how it is: not while the scenarios that
      // follow count what reaches their own stand-ins.
      send('hub-page home')
      await waitUntil(
        'the window to leave the Cleanup page',
        (now) => now.hub !== null && now.hub.heading !== 'Cleanup',
        4_000,
      ).catch(() => {})
    }
  },
)

scenario('an address that a page of the app asks for is refused, and written down', async () => {
  const asked = ollama.requests
  const from = log.length
  // Made in the session the pages use, where a page that had lost its policy would make it.
  send(`page-request ${ollama.url}/api/version`)
  await waitForLog('[debug] page request: ', 5_000, from)
  expect(
    log.includes('[debug] page request: refused', from),
    "a request made in the pages' session went out",
  )
  await sleep(200)
  expect(ollama.requests === asked, 'the address was reached')
  const { contacted } = (await status()).privacy
  expect(
    contacted.some((contact) => contact === 'refused:127.0.0.1:tried'),
    `the refusal is not on the Privacy page: ${contacted.join(', ')}`,
  )
})

scenario('Undo after a cancel: the dictation is pasted after all', async () => {
  const before = await status()
  play(SHORT)
  const session = await press()
  await sleep(SHORT.ms + 300)
  send('escape')
  const cancelled = await waitUntil(
    'the Cancelled message',
    (now) => now.pill === 'recovery',
    2_000,
  )
  expect(cancelled.pastes.length === before.pastes.length, 'something was pasted')
  expect(cancelled.holdsRecording === true, 'the recording was not kept for Undo')
  expect(cancelled.openMicrophones === 0, 'the microphone stayed open')

  send('click-pill Undo')
  const state = await waitUntil(
    'the paste',
    (now) => now.state === 'idle' && now.pastes.length === before.pastes.length + 1,
    10_000,
  )
  expectPastedIntact(state, session)
  await waitUntil('the recording to be let go', (now) => now.holdsRecording === false, 2_000)
})

scenario('Undo after a cancel that came once the words had been heard', async () => {
  const before = await status()
  // Holds the session in "processing" after the recognizer has answered, which is where
  // Cleaned mode spends its time while the model works.
  send('text-delay 2500')
  try {
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms + 400)
    const from = log.length
    send('release')
    await waitForLog(`[speech] heard (session ${session})`, 5_000, from)
    send('escape')
    const cancelled = await waitUntil(
      'the Cancelled message',
      (now) => now.state === 'idle' && now.pill === 'recovery',
      2_000,
    )
    expect(cancelled.pastes.length === before.pastes.length, 'something was pasted')
    expect(cancelled.holdsRecording === true, 'the recording was let go while Undo was on offer')
    // What had been heard is kept, cancelled or not.
    await waitUntil('the text to be kept', (now) => entryOf(now, session)?.hasText === true, 2_000)

    send('click-pill Undo')
    const state = await waitUntil(
      'the paste',
      (now) => now.state === 'idle' && now.pastes.length === before.pastes.length + 1,
      10_000,
    )
    expectPastedIntact(state, session)
    expect(
      count(`[dictation] failed (session ${session})`) === 0,
      'Undo ended in an error although it was offered',
    )
    await waitUntil('the recording to be let go', (now) => now.holdsRecording === false, 2_000)
    await expectMicrophoneReleased()
  } finally {
    send('text-delay 0')
  }
})

scenario(
  'Undo after a cancel that came before any sound was captured: no speech, not an error',
  async () => {
    const before = await status()
    play(SHORT)
    const session = await press()
    // Cancelled at once: the microphone has not delivered a frame yet, or barely one.
    send('escape')
    await waitUntil('the Cancelled message', (now) => now.pill === 'recovery', 2_000)

    send('click-pill Undo')
    const state = await waitIdle(10_000)
    const failures = count(`[dictation] failed (session ${session})`)
    expect(failures === 0, 'Undo ended in an error although it was offered')
    expect(state.pastes.length <= before.pastes.length + 1, 'more than one paste')
    expect(state.openMicrophones === 0, 'the microphone stayed open')
  },
)

scenario('an Undo that is not taken lapses, and the recording is let go', async () => {
  const before = await status()
  play(SHORT)
  await press()
  await sleep(1_200)
  send('escape')
  const cancelled = await waitUntil(
    'the Cancelled message',
    (now) => now.pill === 'recovery',
    2_000,
  )
  expect(cancelled.holdsRecording === true, 'the recording was not kept for Undo')

  // The message, and the offer with it, go away after six seconds.
  const after = await waitUntil(
    'the offer to lapse',
    (now) => now.pill === 'resting' && now.holdsRecording === false,
    9_000,
  )
  expect(after.pastes.length === before.pastes.length, 'something was pasted')
})

scenario('Retry after a failed decode: the dictation is pasted after all', async () => {
  const before = await status()
  send('fail-next-transcript')
  play(SHORT)
  const session = await press()
  await sleep(SHORT.ms + 400)
  send('release')
  const failed = await waitUntil(
    'the failure',
    (now) => now.state === 'idle' && entryOf(now, session)?.outcome === 'failed',
    10_000,
  )
  expect(failed.pastes.length === before.pastes.length, 'something was pasted')
  expect(failed.pill === 'recovery', 'the pill does not say what happened')

  send('click-pill Retry')
  const state = await waitUntil(
    'the paste',
    (now) => now.state === 'idle' && now.pastes.length === before.pastes.length + 1,
    10_000,
  )
  expectPastedIntact(state, session)
  // The message that offered Retry is gone, rather than lingering over a success.
  await waitUntil('the pill at rest', (now) => now.pill === 'resting', 2_000)
})

scenario('a silently cancelled recording is not held', async () => {
  play(SHORT)
  send('press')
  await sleep(100)
  send('release')
  await waitUntil('the tap to be dropped', (now) => now.state === 'idle', 2_000)
  const after = await waitUntil('nothing held', (now) => now.holdsRecording === false, 2_000)
  expect(after.pill === 'resting', 'a silent cancel showed a message')
})

scenario('a quick tap pastes nothing and leaves no trace', async () => {
  const before = await status()
  play(SHORT)
  // Sent without waiting in between: the hold must stay under the tap threshold.
  send('press')
  await sleep(100)
  send('release')
  // The recording runs on for half a second in case a second tap follows, then is dropped.
  await sleep(700)
  const after = await expectMicrophoneReleased()
  expect(after.state === 'idle', 'the app is not idle')
  expect(after.pastes.length === before.pastes.length, 'something was pasted')
  expect(
    after.recovery[0]?.session === before.recovery[0]?.session,
    'the tap left a recovery entry',
  )
})

/** Two quick taps of the key: the second one locks the recording on. */
async function doubleTap() {
  send('press')
  await sleep(90)
  send('release')
  await sleep(120)
  send('press')
  await sleep(90)
  send('release')
  return waitUntil('hands-free', (now) => now.state === 'locked', 2_000)
}

scenario(
  'hands-free by double tap: it records with no key held, and a tap stops and pastes',
  async () => {
    play(SHORT)
    const { session } = await doubleTap()
    const listening = await waitUntil('the hands-free pill', (now) => now.pillHandsFree, 2_000)
    expect(listening.pill === 'listening', `pill shows ${listening.pill}`)
    await sleep(SHORT.ms + 400)
    expect((await status()).state === 'locked', 'the recording stopped by itself')

    send('press')
    await sleep(90)
    send('release')
    const state = await waitIdle(20_000)
    expectPastedIntact(state, session)
    expect(metricsOf(session).audioMs >= SHORT.ms, 'the start of the recording was lost')
    await expectMicrophoneReleased()
  },
)

scenario(
  'hands-free by shortcut (Fn+Space), stopped with the Stop button on the pill',
  async () => {
    play(SHORT)
    const session = await press()
    await sleep(250)
    send('hands-free')
    // Letting go of the key that locked it must not stop it.
    send('release')
    await waitUntil(
      'the hands-free pill',
      (now) => now.state === 'locked' && now.pillHandsFree,
      2_000,
    )
    await sleep(SHORT.ms + 400)

    send('click-pill Stop')
    const state = await waitIdle(20_000)
    expectPastedIntact(state, session)
  },
)

scenario('hands-free by clicking the resting pill', async () => {
  play(SHORT)
  expect((await status()).pill === 'resting', 'the pill is not at rest')
  send('click-pill Pill')
  const locked = await waitUntil('hands-free', (now) => now.state === 'locked', 2_000)
  await sleep(SHORT.ms + 600)
  send('stop')
  const state = await waitIdle(20_000)
  expectPastedIntact(state, locked.session)
  const after = await waitUntil('resting', (now) => now.pill === 'resting', 2_000)
  expect(after.overlayTakesClicks === false, 'the pill window still catches clicks')
})

scenario(
  'a third tap right after a double tap cancels: nothing pasted, microphone released',
  async () => {
    const before = await status()
    play(SHORT)
    const { session } = await doubleTap()
    await sleep(120)
    send('press')
    await sleep(90)
    send('release')
    const state = await waitIdle()
    await sleep(600)
    const after = await expectMicrophoneReleased()
    expect(after.pastes.length === before.pastes.length, 'something was pasted')
    expect(entryOf(state, session)?.outcome === 'cancelled', 'the cancel was not recorded')
    expect(
      log.includes(`cancelled (session ${session}): tripleTap`),
      'it was not a triple-tap cancel',
    )
  },
)

scenario(
  'cancel while the microphone is starting: nothing pasted, microphone released',
  async () => {
    const before = await status()
    play(SHORT)
    send('press')
    send('escape')
    const state = await waitIdle()
    // The microphone may only finish opening after the cancel; it must be closed again.
    await sleep(500)
    const after = await expectMicrophoneReleased()
    expect(after.pastes.length === before.pastes.length, 'something was pasted')
    expect(state.recovery[0]?.outcome === 'cancelled', 'the cancel was not recorded')
    expect(state.recovery[0]?.hasText === false, 'a cancelled session kept text')
  },
)

scenario('cancel while listening: nothing pasted, microphone released', async () => {
  const before = await status()
  play(SHORT)
  const session = await press()
  await sleep(900)
  send('escape')
  const state = await waitIdle()
  const after = await expectMicrophoneReleased()
  await sleep(600)
  expect((await status()).pastes.length === before.pastes.length, 'something was pasted')
  expect(entryOf(state, session)?.outcome === 'cancelled', 'the cancel was not recorded')
  expect(metricsOf(session)?.micLiveMs !== undefined, 'the session was never listening')
  expect(after.openMicrophones === 0, 'the microphone stayed open')
})

scenario('cancel while processing: nothing pasted', async () => {
  const before = await status()
  send('text-delay 1200')
  try {
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms + 400)
    send('release')
    await waitUntil('processing', (now) => now.state === 'processing', 2_000)
    await sleep(450)
    send('escape')
    const state = await waitIdle()
    // Long enough for the held-back text to arrive, had the cancel not stopped it.
    await sleep(1_500)
    expect((await status()).pastes.length === before.pastes.length, 'something was pasted')
    expect(entryOf(state, session)?.outcome === 'cancelled', 'the cancel was not recorded')
    await expectMicrophoneReleased()
  } finally {
    send('text-delay 0')
  }
})

scenario(
  'the shortcut pressed during processing is ignored; the first session completes',
  async () => {
    const cues = count('[dictation] stillProcessing')
    send('text-delay 1200')
    try {
      play(SHORT)
      const session = await press()
      await sleep(SHORT.ms + 400)
      send('release')
      await waitUntil('processing', (now) => now.state === 'processing', 2_000)
      send('press')
      await sleep(400)
      send('release')
      const state = await waitIdle()
      expectPastedIntact(state, session)
      expect(count('[dictation] stillProcessing') === cues + 1, 'no "still processing" cue')
      expect(!entryOf(state, session + 1), 'the second press started a session')
      expect(state.pastes.at(-1).session === session, 'the last paste is not the first session')
    } finally {
      send('text-delay 0')
    }
  },
)

scenario('a result from a cancelled session never reaches the next one', async () => {
  send('text-delay 1200')
  try {
    play(SHORT)
    const stale = await press()
    await sleep(SHORT.ms + 400)
    send('release')
    await waitUntil('processing', (now) => now.state === 'processing', 2_000)
    send('escape')
    await waitIdle()
    // The cancelled session's text is still held back when the next one starts.
    const { session, state } = await dictate(MEDIUM)
    expect(pastesOf(state, stale).length === 0, 'the cancelled session was pasted')
    expectPastedIntact(state, session, 'the next session')
  } finally {
    send('text-delay 0')
  }
})

scenario('speech worker killed mid-recording: the dictation still arrives intact', async () => {
  const before = await waitUntil('the worker', (now) => now.speech === 'ready', 15_000)
  play(MEDIUM)
  const session = await press()
  await sleep(1_500)
  send('kill-worker')
  await sleep(MEDIUM.ms + 400 - 1_500)
  send('release')
  const state = await waitIdle(25_000)
  expectPastedIntact(state, session)
  expect(state.workerPid !== before.workerPid, 'the worker was not replaced')
  expect(metricsOf(session)?.audioMs >= MEDIUM.ms, 'part of the recording was lost')
})

for (const afterMs of [20, 240]) {
  scenario(
    `speech worker killed ${afterMs} ms after release: the dictation still arrives intact`,
    async () => {
      await waitUntil('the worker', (now) => now.speech === 'ready', 15_000)
      play(SHORT)
      const session = await press()
      await sleep(SHORT.ms + 400)
      send('release')
      await sleep(afterMs)
      send('kill-worker')
      const state = await waitIdle(25_000)
      expectPastedIntact(state, session)
      await waitUntil('the worker to return', (now) => now.speech === 'ready', 15_000)
    },
  )
}

scenario('microphone lost mid-recording: what was captured is used, with a notice', async () => {
  play(MEDIUM)
  const session = await press()
  await sleep(4_000)
  send('lose-microphone')
  const state = await waitIdle(15_000)
  send('release') // The key is still down; letting go now must change nothing.
  await sleep(300)
  const after = await expectMicrophoneReleased()
  const pastes = pastesOf(after, session)
  expect(pastes.length === 1, `expected one paste, saw ${pastes.length}`)
  expect(pastes[0].chars > 20, 'almost nothing was captured')
  expect(
    log.includes(`recording ended by itself (session ${session}): microphoneLost`),
    'no notice that the microphone went away',
  )
  expect(entryOf(state, session)?.outcome === 'pasted', 'not recorded as pasted')
})

scenario('recording limit reached: treated as a stop, with a notice', async () => {
  send('max-recording 2000')
  try {
    play(MEDIUM)
    const session = await press()
    const state = await waitIdle(15_000)
    send('release')
    await sleep(300)
    const pastes = pastesOf(await status(), session)
    expect(pastes.length === 1, `expected one paste, saw ${pastes.length}`)
    expect(
      log.includes(`recording ended by itself (session ${session}): limit`),
      'no notice that the limit was reached',
    )
    const timings = metricsOf(session)
    expect(timings?.audioMs >= 1_800 && timings?.audioMs <= 3_000, `audio ${timings?.audioMs} ms`)
    expect(entryOf(state, session)?.outcome === 'pasted', 'not recorded as pasted')
    await expectMicrophoneReleased()
  } finally {
    send('max-recording 0')
  }
})

scenario(
  'interrupted mid-recording (sleep, lock, helper lost): never pasted, text kept',
  async () => {
    const before = await status()
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms + 400)
    send('abort')
    const state = await waitUntil(
      'the interrupted text',
      (now) => entryOf(now, session)?.hasText === true,
      10_000,
    )
    expect(state.state === 'idle', 'the app is not idle')
    expect(state.pastes.length === before.pastes.length, 'an interrupted session was pasted')
    const entry = entryOf(state, session)
    expect(entry.outcome === 'cancelled', `recorded as ${entry.outcome}`)
    expect(entry.wer <= MAX_WER, `kept text has word error rate ${entry.wer}`)
    await expectMicrophoneReleased()

    // What was kept can be reached with the paste-last shortcut.
    send('paste-last')
    const after = await waitUntil(
      'paste-last',
      (now) => now.pastes.length === before.pastes.length + 1,
      3_000,
    )
    expect(after.pastes.at(-1).session === null, 'paste-last ran inside a session')
    expect(after.pastes.at(-1).wer <= MAX_WER, 'paste-last pasted something else')
  },
)

scenario('interrupted while processing: never pasted, text kept', async () => {
  const before = await status()
  send('text-delay 1000')
  try {
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms + 400)
    send('release')
    await waitUntil('processing', (now) => now.state === 'processing', 2_000)
    send('abort')
    const state = await waitUntil(
      'the interrupted text',
      (now) => entryOf(now, session)?.hasText === true,
      10_000,
    )
    expect(state.pastes.length === before.pastes.length, 'an interrupted session was pasted')
    expect(entryOf(state, session).wer <= MAX_WER, 'the kept text is wrong')
  } finally {
    send('text-delay 0')
  }
})

scenario(
  'a dictation of about a minute is decoded in pieces while it is being recorded',
  async () => {
    const { session, state } = await dictate(VERY_LONG)
    expectPastedIntact(state, session)
    const timings = metricsOf(session)
    // Speech is cut at pauses into pieces of up to 30 s, each decoded as soon as it closes.
    expect(timings.chunks > 1, `decoded in ${timings.chunks} piece(s)`)
    // Only the last piece is left at release, so the wait does not grow with the length.
    expect(timings.releaseToTextMs < 1_200, `release to text took ${timings.releaseToTextMs} ms`)
    return `${timings.chunks} pieces, ${timings.releaseToTextMs} ms from release to text`
  },
  { once: true },
)

scenario('a chosen microphone that is not connected: the default is used instead', async () => {
  send('microphone no-such-device')
  try {
    const { session, state } = await dictate(SHORT)
    expectPastedIntact(state, session)
    // Once a microphone has been opened, the tray can list the real ones by name.
    expect(state.namedMicrophones >= 1, 'no microphone was listed for the tray')
  } finally {
    send('microphone default')
  }
})

scenario('Cleaned mode: the model is given the transcript and its text is pasted', async () => {
  await inCleanedMode('echo', async () => {
    const sent = ollama.transcripts.length
    const { session, state } = await dictate(SHORT)
    expectPastedIntact(state, session)
    expect(entryOf(state, session).note === 'cleaned', `note: ${entryOf(state, session).note}`)
    expect(ollama.transcripts.length === sent + 1, 'the model was not asked exactly once')
    expect(sameWords(ollama.transcripts.at(-1), SHORT.text), 'the model was given other words')
    expect(metricsOf(session).cleanup === 'cleaned', 'the timings do not say cleanup was used')
  })
})

for (const [behaviour, model, what] of [
  ['emptyWarmUp', 'empty-warm', 'empty'],
  ['incompleteWarmUp', 'incomplete-warm', 'unfinished'],
]) {
  scenario(`Cleaned mode, an ${what} warm-up: the transcript is never sent`, async () => {
    await inCleanedMode(
      behaviour,
      async () => {
        const sent = ollama.transcripts.length
        const warms = ollama.warms
        const { session, state } = await dictate(SHORT)
        expectPastedIntact(state, session)
        expect(entryOf(state, session).note === 'failed', `note: ${entryOf(state, session).note}`)
        expect(ollama.warms > warms, 'the warm-up response was never exercised')
        expect(ollama.transcripts.length === sent, 'an incomplete warm-up authorized a transcript')
      },
      { model },
    )
  })
}

scenario(
  'Cleaned mode, a replacement model: the old warm-up cannot authorize its transcript',
  async () => {
    await inCleanedMode(
      'echo',
      async () => {
        const first = await dictate(SHORT)
        expectPastedIntact(first.state, first.session)
        expect(
          entryOf(first.state, first.session).note === 'cleaned',
          'the first model was not used',
        )
        const sent = ollama.transcripts.length
        const warms = ollama.warms
        // The name and server stay the same; tags now reports a replacement digest.
        ollama.behaviour = 'remoteWarmUp'
        const second = await dictate(SHORT)
        expectPastedIntact(second.state, second.session)
        const note = entryOf(second.state, second.session).note
        expect(note === 'notLocal:blocked', `note: ${note}`)
        expect(ollama.warms > warms, 'the replacement was not asked for its own warm-up')
        expect(ollama.transcripts.length === sent, 'the replacement inherited the old approval')
      },
      { model: 'replaced' },
    )
  },
  // The deliberately blocked model stays blocked for this app process.
  { once: true },
)

scenario('Cleaned mode, Ollama not running: the rules-only text is pasted at once', async () => {
  await inCleanedMode(
    'echo',
    async () => {
      const { session, state } = await dictate(SHORT)
      expectPastedIntact(state, session)
      const note = entryOf(state, session).note
      expect(note === 'notLocal:unreachable', `note: ${note}`)
      expect(metricsOf(session).releaseToPasteMs < 1_500, 'the paste waited for Ollama')
    },
    // Nothing listens on this port.
    { url: 'http://127.0.0.1:9' },
  )
})

scenario(
  'Cleaned mode, Ollama too slow: the rules-only text is pasted at the deadline',
  async () => {
    await inCleanedMode('slow', async () => {
      const { session, state } = await dictate(SHORT)
      expectPastedIntact(state, session)
      expect(entryOf(state, session).note === 'timeout', `note: ${entryOf(state, session).note}`)
      const waited = metricsOf(session).releaseToPasteMs
      // Never more than the last decode plus the four-second ceiling.
      expect(waited > 1_000 && waited < 4_600, `release to paste took ${waited} ms`)
    })
  },
)

scenario(
  'Cleaned mode, the model answers something else: the rules-only text is pasted',
  async () => {
    await inCleanedMode('garbage', async () => {
      const { session, state } = await dictate(SHORT)
      // Scored against what was said: the model's own sentence would fail this.
      expectPastedIntact(state, session)
      const note = entryOf(state, session).note
      expect(note.startsWith('guard:'), `note: ${note}`)
    })
  },
)

for (const [behaviour, what] of [
  ['remoteModel', 'a cloud model'],
  ['remoteAlias', 'a local name for a cloud model'],
]) {
  scenario(`Cleaned mode, ${what}: refused before anything is sent to it`, async () => {
    const chats = ollama.chats
    await inCleanedMode(behaviour, async () => {
      const { session, state } = await dictate(SHORT)
      expectPastedIntact(state, session)
      const note = entryOf(state, session).note
      expect(note === 'notLocal:remote', `note: ${note}`)
      // Not the transcript, and not even the warm-up: the model was never contacted.
      expect(ollama.chats === chats, 'a request was sent to a model that is not local')
      expect(state.cleanup.includes('does not run on this Mac'), `tray says: ${state.cleanup}`)
    })
  })
}

scenario(
  'Cleaned mode, a reply from another machine: discarded, and the model is not used again',
  async () => {
    await inCleanedMode(
      'remoteReply',
      async () => {
        const first = await dictate(SHORT)
        expectPastedIntact(first.state, first.session)
        const note = entryOf(first.state, first.session).note
        expect(note === 'notLocal:blocked', `note: ${note}`)

        const chats = ollama.chats
        const second = await dictate(SHORT)
        expectPastedIntact(second.state, second.session)
        expect(
          entryOf(second.state, second.session).note === 'notLocal:blocked',
          'the model was used again',
        )
        expect(ollama.chats === chats, 'the blocked model was contacted again')
      },
      { model: 'leaky' },
    )
  },
)

scenario(
  'Cleaned mode, a warm-up reply from another machine: the transcript is never sent',
  async () => {
    await inCleanedMode(
      'remoteWarmUp',
      async () => {
        const sent = ollama.transcripts.length
        const { session, state } = await dictate(SHORT)
        expectPastedIntact(state, session)
        const note = entryOf(state, session).note
        expect(note === 'notLocal:blocked', `note: ${note}`)
        // The warm-up, sent while the words were still being spoken, was the last
        // thing this model was given.
        expect(ollama.transcripts.length === sent, 'the transcript was sent to the model')
        await waitUntil(
          'the tray to say why',
          (now) => now.cleanup.includes('answered from another machine'),
          3_000,
        )
      },
      { model: 'leaky-at-once' },
    )
  },
)

scenario(
  'Cleaned mode, Ollama answers with a redirect: it is not followed, and the rules-only text is pasted',
  async () => {
    await inCleanedMode(
      'echo',
      async () => {
        const { session, state } = await dictate(SHORT)
        expectPastedIntact(state, session)
        const note = entryOf(state, session).note
        expect(note === 'notLocal:redirected', `note: ${note}`)
        expect(redirector.chats > 0, 'the stand-in was never asked, so nothing was tested')
        // The warm-up, sent while the words were being spoken, was answered with the
        // redirect. That was enough: the transcript was never sent to this server.
        expect(redirector.transcripts === 0, 'the transcript was sent to a server that redirects')
        // Long enough for a followed redirect to have arrived.
        await sleep(300)
        expect(elsewhere.arrived === 0, 'a request was taken to the address a redirect named')
        await waitUntil(
          'the tray to say why',
          (now) => now.cleanup.includes('sends requests elsewhere'),
          3_000,
        )
      },
      { url: redirector.url },
    )
  },
)

scenario(
  'the menu does not show an old answer about Cleaned mode beside a newer setting',
  async () => {
    // Ollama is slow to say which models it has: the answer to "what will Cleaned mode
    // do?" is still on its way when the mode is changed back.
    ollama.tagsDelayMs = 1_200
    try {
      send(`ollama-url ${ollama.url}`)
      send('cleanup-model stand-in')
      send('mode cleaned')
      await waitUntil('Cleaned mode', (now) => now.mode === 'cleaned', 2_000)
      send('mode verbatim')
      await waitUntil('Verbatim mode', (now) => now.mode === 'verbatim', 2_000)
      // Long enough for the answer about Cleaned mode to have come back.
      await sleep(3_200)
      const state = await status()
      expect(state.mode === 'verbatim', 'the mode changed back')
      expect(state.cleanup === '', `in Verbatim mode the menu says "${state.cleanup}"`)
    } finally {
      ollama.tagsDelayMs = 0
      send('mode verbatim')
    }
  },
)

scenario(
  'Ollama started after the menu was drawn: the menu says so when it is next opened',
  async () => {
    // An address nothing listens on yet.
    const probe = createServer()
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const { port } = probe.address()
    await new Promise((resolve) => probe.close(resolve))
    const late = createServer(ollamaServer.listeners('request')[0])
    try {
      await inCleanedMode(
        'echo',
        async () => {
          await waitUntil(
            'the menu to say Ollama is not running',
            (now) => now.cleanup.includes('Ollama is not running'),
            3_000,
          )
          // Ollama is started. Nothing tells the app; the menu is simply opened again.
          await new Promise((resolve) => late.listen(port, '127.0.0.1', resolve))
          // The pointer reaching the icon asks again, at most every two seconds.
          await sleep(2_100)
          send('approach-tray')
          await waitUntil(
            'the menu to say Cleaned mode is working',
            (now) => now.cleanup === 'Cleaned with stand-in',
            3_000,
          )
        },
        { url: `http://127.0.0.1:${port}` },
      )
    } finally {
      late.closeAllConnections()
      late.close()
    }
  },
)

const savedDictations = () => (existsSync(evaluationDir) ? readdirSync(evaluationDir) : [])

scenario(
  'evaluation mode: nothing is saved unless it is on; when on, the recording and its text are',
  async () => {
    const before = savedDictations().length
    await dictate(SHORT)
    expect(savedDictations().length === before, 'a dictation was saved with evaluation mode off')

    send('evaluation on')
    let session
    try {
      const result = await dictate(SHORT)
      session = result.session
      expectPastedIntact(result.state, session)
      expect(result.state.evaluationRecording === true, 'the tray does not show the mode as on')
    } finally {
      send('evaluation off')
    }
    const deadline = Date.now() + 3_000
    while (savedDictations().length < before + 3 && Date.now() < deadline) await sleep(50)
    const added = savedDictations().slice(before).sort()
    const kinds = added.map((name) => name.replace(/^[^.]*\./, '')).sort()
    expect(kinds.join(' ') === 'heard.txt txt wav', `saved: ${kinds.join(' ') || 'nothing'}`)

    // The recording is the whole dictation, and the text is what was heard. The text is
    // compared here and never printed.
    const wav = added.find((name) => name.endsWith('.wav'))
    const savedMs = wavFileDurationMs(join(evaluationDir, wav))
    const heardMs = metricsOf(session).audioMs
    expect(
      Math.abs(savedMs - heardMs) < 5,
      `recording is ${savedMs} ms, the app heard ${heardMs} ms`,
    )
    const text = readFileSync(join(evaluationDir, wav.replace(/wav$/, 'txt')), 'utf8')
    const expected = SHORT.text
      .toLowerCase()
      .match(/[a-z0-9']+/g)
      .join(' ')
    expect(
      text
        .toLowerCase()
        .match(/[a-z0-9']+/g)
        .join(' ') === expected,
      'the saved text differs',
    )

    await dictate(SHORT)
    expect(
      savedDictations().length === before + 3,
      'a dictation was saved after the mode was switched off',
    )
  },
)

scenario(
  'the scoring script reads the saved dictations and scores them',
  async () => {
    expect(
      savedDictations().some((name) => name.endsWith('.wav')),
      'no saved dictation to score',
    )
    const run = spawnSync(
      join(root, 'node_modules', '.bin', 'tsx'),
      [
        '--tsconfig',
        'tsconfig.node.json',
        'scripts/eval-stt.ts',
        '--dir',
        evaluationDir,
        '--quiet',
      ],
      { cwd: root, encoding: 'utf8', timeout: 120_000 },
    )
    expect(run.status === 0, `the script failed: ${run.stderr.trim().slice(-200)}`)
    const all = /\| All \| (\d+) \| (\d+) \| ([\d.]+)% \| ([\d.]+)% \|/.exec(run.stdout)
    expect(all, 'the script printed no summary row')
    expect(Number(all[1]) >= 1 && Number(all[3]) === 0, `summary: ${all[0]}`)
    return `${all[1]} dictation(s), ${all[2]} words, word errors ${all[3]}%, corrections needed ${all[4]}%`
  },
  { once: true },
)

scenario('a setting that cannot be saved is not changed, and the app says so', async () => {
  const before = await status()
  expect(
    before.mode === 'verbatim' && before.evaluationRecording === false,
    'the scenario did not start from Verbatim mode with evaluation off',
  )
  const saved = savedDictations().length
  // A folder where the settings file is first written: every save fails until it is removed.
  const blocker = join(scratch, 'settings.json.tmp')
  mkdirSync(blocker)
  try {
    const from = log.length
    send('mode cleaned')
    send('evaluation on')
    send('microphone a-microphone-that-was-never-saved')
    await waitForLog('[settings] could not save a change to microphoneId', 3_000, from)
    const state = await waitUntil('the pill to say so', (now) => now.pill === 'recovery', 2_000)
    expect(state.mode === 'verbatim', 'the menu shows a mode that was not saved')
    expect(state.evaluationRecording === false, 'the menu shows evaluation mode as on')
    expect(
      state.chosenMicrophone === before.chosenMicrophone,
      'the menu shows a microphone that was not saved',
    )
    // And the app does what its menu says: the text is not cleaned, and nothing is kept.
    const { session, state: after } = await dictate(SHORT)
    expectPastedIntact(after, session)
    expect(entryOf(after, session).note === null, 'the dictation went through Cleaned mode')
    await sleep(300)
    expect(savedDictations().length === saved, 'a dictation was saved although the setting was not')
  } finally {
    rmSync(blocker, { recursive: true, force: true })
  }
  // The same change, asked for again once the cause has passed, is made.
  send('evaluation on')
  await waitUntil('the setting to be saved', (now) => now.evaluationRecording === true, 2_000)
  send('evaluation off')
  await waitUntil('the setting to be put back', (now) => now.evaluationRecording === false, 2_000)
})

scenario('model unloaded when idle: the next dictation loads it and arrives intact', async () => {
  await waitUntil('the worker', (now) => now.speech === 'ready', 15_000)
  send('unload-model')
  const unloaded = await waitUntil('the unload', (now) => now.speech === 'stopped', 3_000)
  expect(unloaded.workerPid === null, 'the worker is still running')
  const { session, state } = await dictate(SHORT)
  expectPastedIntact(state, session)
  expect(state.speech === 'ready', 'the model was not loaded again')
})

scenario(
  'the idle unload comes due during a recording: the model stays and the text arrives',
  async () => {
    const before = await waitUntil('the worker', (now) => now.speech === 'ready', 15_000)
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms / 2)
    // What the idle timer does when it runs out. A recording may last longer than it.
    send('unload-model')
    await sleep(SHORT.ms / 2 + 400)
    const during = await status()
    expect(during.speech === 'ready', `the model was unloaded mid-recording (${during.speech})`)
    expect(during.workerPid === before.workerPid, 'the worker was replaced mid-recording')
    send('release')
    const state = await waitIdle(20_000)
    expectPastedIntact(state, session)
  },
)

scenario(
  'the log file tells what happened to a dictation, and holds nothing that was said',
  async () => {
    const { session, state } = await dictate(SHORT)
    expectPastedIntact(state, session)
    const path = join(scratch, 'logs', 'main.log')
    expect(existsSync(path), 'there is no log file')
    const text = readFileSync(path, 'utf8')
    for (const line of [
      `[state] holding (session ${session})`,
      '[state] processing',
      `[metrics] session=${session} outcome=pasted`,
    ]) {
      expect(text.includes(line), `the log file lacks "${line}"`)
    }
    expect(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3} /m.test(text), 'lines carry no time')
    for (const word of SPOKEN_WORDS) {
      expect(!text.toLowerCase().includes(word.toLowerCase()), `the log file contains "${word}"`)
    }
    return `${text.split('\n').length - 1} lines`
  },
)

scenario('everything the app contacted was on this Mac', async () => {
  // Read from the app itself, as the Privacy page reads it: every address it tried
  // while all of the above ran. The stand-ins for Ollama are on this Mac too.
  const { contacted } = (await status()).privacy
  if (!only) expect(contacted.length > 0, 'nothing is listed although Cleaned mode was used')
  for (const contact of contacted) {
    // What a page asked for was refused before it left, and is listed as such.
    expect(
      /^(ollama|refused):(127\.0\.0\.1|localhost|::1):/.test(contact),
      `the app contacted ${contact}`,
    )
  }
})

scenario('nothing that was said appears in the log', async () => {
  for (const word of SPOKEN_WORDS) {
    expect(!log.toLowerCase().includes(word.toLowerCase()), `the log contains "${word}"`)
  }
})

// --- Measurements --------------------------------------------------------------------

const percentile = (values, share) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)]
}
const summary = (values) =>
  values.length === 0
    ? 'no samples'
    : `n=${values.length} median=${percentile(values, 0.5)} p95=${percentile(values, 0.95)} ` +
      `min=${Math.min(...values)} max=${Math.max(...values)}`

/** Release → paste for an utterance of about nine seconds, the latency gate's case. */
async function measureLatency(runs) {
  // Queries and retention work run in the storage process while speech/paste are timed.
  await showPage('history', 'History')
  let searchTurn = 0
  const historyLoad = setInterval(() => {
    send(
      searchTurn++ % 2
        ? 'type-hub Search_history'
        : 'type-hub Search_history ' + base64('synthetic'),
    )
    send('sweep-history')
  }, 1250)
  const rows = []
  for (let run = 0; run < runs; run++) {
    const { session, state } = await dictate(MEDIUM)
    expectPastedIntact(state, session)
    rows.push(metricsOf(session))
    await sleep(300)
  }
  clearInterval(historyLoad)
  console.log(`\nLatency, ${(MEDIUM.ms / 1000).toFixed(1)} s utterance, fake microphone (ms):`)
  for (const field of ['releaseToTextMs', 'releaseToPasteMs', 'decodeMs', 'micLiveMs']) {
    console.log(`  ${field.padEnd(18)} ${summary(rows.map((row) => row[field]))}`)
  }
}

/**
 * Time from the shortcut to audio flowing, on the real microphone. Each run is
 * cancelled as soon as audio flows, so nothing that is heard is ever transcribed.
 */
async function measureRealMicrophone(runs) {
  const rows = []
  for (let run = 0; run < runs; run++) {
    const session = await press()
    const deadline = Date.now() + 5_000
    // The cancel below makes the app log the session's timings, including micLiveMs.
    await sleep(700)
    send('escape')
    await waitIdle()
    while (!metricsOf(session) && Date.now() < deadline) await sleep(20)
    const timings = metricsOf(session)
    if (timings?.micLiveMs !== undefined) rows.push(timings)
    await expectMicrophoneReleased()
    // People pause between dictations; back-to-back opens would flatter the number.
    await sleep(1_500)
  }
  send('devices')
  await waitForLog('DEBUG_DEVICES ', 3_000).catch(() => {})
  const devices = /DEBUG_DEVICES (.*)/.exec(log)?.[1] ?? 'unknown'
  console.log(`\nAudio inputs: ${devices}`)
  console.log('Shortcut to audio flowing, real microphone (ms):')
  console.log(`  micLiveMs          ${summary(rows.map((row) => row.micLiveMs))}`)
  console.log(`  micOpenMs          ${summary(rows.map((row) => row.micOpenMs))}`)
  console.log(`  first run          ${rows[0]?.micLiveMs} (includes creating the audio graph)`)
  if (rows.length < runs) console.log(`  ${runs - rows.length} runs never went live`)
}

/**
 * Where the app under test fetches its model from in the launch below: the real files,
 * served from this machine, so nothing is fetched from the internet. `holdAfter` makes
 * it send that many bytes of a file and then go quiet with the connection left open,
 * which is what a stalled download looks like.
 */
const modelSource = { requests: [], holdAfter: null, url: '' }
const modelSourceServer = createServer((request, response) => {
  const name = decodeURIComponent((request.url ?? '').slice(1))
  const path = join(modelDir, MODEL_ID, name)
  const range = request.headers.range ?? null
  modelSource.requests.push({ name, range })
  if (name.includes('/') || name.startsWith('.') || !existsSync(path)) {
    return response.writeHead(404).end()
  }
  const size = statSync(path).size
  const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
  response.writeHead(start > 0 ? 206 : 200, { 'content-length': size - start })
  if (modelSource.holdAfter === null) return createReadStream(path, { start }).pipe(response)
  const end = Math.min(size, start + modelSource.holdAfter)
  if (end <= start) return undefined
  // The part is written, and the reply is never ended.
  return createReadStream(path, { start, end: end - 1 }).on('data', (chunk) =>
    response.write(chunk),
  )
})

/**
 * A separate launch with an empty models folder. Dictation must refuse, and say why;
 * and from there the model is downloaded, damaged, found out and repaired, with the
 * files coming from the stand-in above.
 */
/**
 * What the app does at its start with dictations on disk, by what the settings say
 * about keeping them. Each case is a start of its own, from a data folder made for it.
 */
async function historyAtStart() {
  const day = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10)
  const kept = {
    id: 'kept-by-an-earlier-choice',
    endedAt: Date.parse(`${day}T12:00:00Z`),
    app: 'Notes',
    outcome: 'pasted',
    fetched: null,
    mode: 'verbatim',
    note: null,
    heard: 'kept on disk by an earlier choice',
    written: 'Kept on disk by an earlier choice.',
    failure: null,
    audioMs: 2_000,
    timings: { releaseToTextMs: 400, tidyMs: null, pasteMs: 40 },
  }
  const startWith = async (name, settingsText) => {
    const data = join(scratch, name)
    mkdirSync(join(data, 'history'), { recursive: true })
    writeFileSync(join(data, 'settings.json'), settingsText)
    writeFileSync(
      join(data, 'history', `${day}.json`),
      JSON.stringify({ version: 1, entries: [kept] }),
    )
    launch({ WHISPER_FLOW_USER_DATA_DIR: data })
    await waitForLog('[debug] control line open', 15_000)
    const { history } = await status()
    const files = readdirSync(join(data, 'history'))
    await quit()
    return { history, files }
  }

  // A comma too many after an edit by hand: the whole file falls back to its defaults, and
  // "only until I quit" is the default. Nothing is deleted on the strength of that.
  const damaged = await startWith('settings-damaged', '{ "version": 1, "historyKeep": "forever", }')
  expect(
    damaged.files.length === 1,
    'the saved history was deleted because the settings could not be read',
  )
  expect(
    damaged.history.count === 0 && damaged.history.left === 1 && damaged.history.keep === 'session',
    `it is not said to be left on disk: ${JSON.stringify({ ...damaged.history, newest: undefined })}`,
  )

  // Stated in a file that can be read: kept, and listed.
  const stated = await startWith(
    'settings-keep',
    JSON.stringify({ version: 1, historyKeep: 'forever' }),
  )
  expect(
    stated.files.length === 1 && stated.history.count === 1 && stated.history.left === 0,
    'a history that the settings keep is not listed',
  )

  // "Only until I quit", stated: nothing of it is on disk after a quit.
  const untilQuit = await startWith(
    'settings-session',
    JSON.stringify({ version: 1, historyKeep: 'session' }),
  )
  expect(
    untilQuit.files.length === 0 && untilQuit.history.left === 0,
    'files were left on disk although "only until I quit" was chosen',
  )
}

async function withoutModel() {
  const emptyModels = join(scratch, 'no-models')
  mkdirSync(emptyModels, { recursive: true })
  await new Promise((resolve) => modelSourceServer.listen(0, '127.0.0.1', resolve))
  modelSource.url = `http://127.0.0.1:${modelSourceServer.address().port}`
  launch({ WHISPER_FLOW_MODELS_DIR: emptyModels, WHISPER_FLOW_MODEL_SOURCE: modelSource.url })
  const models = join(emptyModels, MODEL_ID)
  const fileOf = (name) => join(models, name)
  const fetched = () => modelSource.requests.map((request) => request.name).join(' ')
  /** Frees the model, so that the next dictation has to load it from disk again. */
  const unload = async () => {
    const from = log.length
    send('unload-model')
    await waitForLog('[speech] model unloaded', 5_000, from)
  }
  /** A dictation that cannot be turned into text, because the model is not usable. */
  const dictateInVain = async (logged, timeoutMs) => {
    const before = await status()
    const from = log.length
    play(SHORT)
    const session = await press()
    await waitForLog(logged, timeoutMs, from)
    await sleep(300)
    send('release')
    const state = await waitIdle(20_000)
    expect(state.pastes.length === before.pastes.length, 'something was pasted')
    expect(
      entryOf(state, session)?.outcome === 'failed',
      'the dictation was not recorded as failed',
    )
    await expectMicrophoneReleased()
    return state
  }
  try {
    await waitForLog('[speech] modelMissing', 20_000)
    send('quiet-paste')
    send('own-window off')
    send('press')
    await waitForLog('The speech model is not downloaded yet', 5_000)
    await sleep(300)
    send('release')
    const state = await waitIdle()
    expect(state.pastes.length === 0, 'something was pasted')
    expect(state.recovery[0]?.outcome === 'failed', 'the refusal was not recorded')
    expect(state.pill === 'recovery', 'the pill does not say why')
    await expectMicrophoneReleased()

    // The Download button, with every file already on disk as an unfinished download of
    // the right size: the app only has to check them and take them in.
    mkdirSync(models, { recursive: true })
    for (const name of readdirSync(join(modelDir, MODEL_ID))) {
      if (name.startsWith('.')) continue
      copyFileSync(
        join(modelDir, MODEL_ID, name),
        fileOf(`${name}.partial`),
        constants.COPYFILE_FICLONE,
      )
    }
    send('download-model')
    await waitForLog('[speech] ready', 60_000)
    expect(existsSync(fileOf('.verified.json')), 'the model was not marked as verified')
    expect(fetched() === '', `fetched although every file was on disk: ${fetched()}`)
    const { session, state: loaded } = await dictate(SHORT)
    expectPastedIntact(loaded, session, 'the first dictation after the download')

    console.log('  ...a model file changed after it was checked')
    await unload()
    const tokens = fileOf('tokens.txt')
    // Other bytes of the same length, as a failing disk or a stray write might leave.
    writeFileSync(tokens, Buffer.alloc(statSync(tokens).size))
    expect(
      (await status()).modelDownloaded === false,
      'a model file that was changed still counts as downloaded',
    )
    await dictateInVain('did not match their checksums and were removed: tokens.txt', 15_000)
    expect(!existsSync(tokens), 'the damaged file was left in place')
    // The download is the repair, and it fetches the one file.
    modelSource.requests.length = 0
    let from = log.length
    send('download-model')
    await waitForLog('[speech] ready', 60_000, from)
    expect(fetched() === 'tokens.txt', `fetched: ${fetched() || 'nothing'}`)
    const repaired = await dictate(SHORT)
    expectPastedIntact(repaired.state, repaired.session, 'the dictation after the repair')

    console.log('  ...a model file changed in a way only reading it shows')
    await unload()
    const joiner = fileOf('joiner.int8.onnx')
    const descriptor = openSync(joiner, 'r+')
    writeSync(descriptor, Buffer.alloc(4_096), 0, 4_096, 0)
    closeSync(descriptor)
    // The record of the file is made to fit it again, which is how a change that
    // leaves the size and the date alone looks to the app.
    const marker = JSON.parse(readFileSync(fileOf('.verified.json'), 'utf8'))
    marker['#files']['joiner.int8.onnx'].mtimeMs = statSync(joiner).mtimeMs
    writeFileSync(fileOf('.verified.json'), JSON.stringify(marker))
    expect(
      (await status()).modelDownloaded === true,
      'the change was meant to be one the quick check cannot see',
    )
    // The model will not load, and that is when its files are read.
    const afterFailure = await dictateInVain(
      'did not match their checksums and were removed: joiner.int8.onnx',
      60_000,
    )
    expect(!existsSync(joiner), 'the damaged file was left in place')
    expect(afterFailure.modelDownloaded === false, 'the model still counts as downloaded')
    // The model now counts as not downloaded, and Download is what the setup window
    // offers: it fetches the file that was removed and loads the model.
    modelSource.requests.length = 0
    from = log.length
    send('download-model')
    await waitForLog('[speech] ready', 90_000, from)
    expect(fetched() === 'joiner.int8.onnx', `fetched: ${fetched() || 'nothing'}`)
    const checked = await dictate(SHORT)
    expectPastedIntact(checked.state, checked.session, 'the dictation after checking the files')

    console.log('  ...a download that is cancelled part-way, and resumed')
    await unload()
    const decoder = fileOf('decoder.int8.onnx')
    rmSync(decoder)
    modelSource.holdAfter = 2_000_000
    modelSource.requests.length = 0
    send('download-model')
    const partial = `${decoder}.partial`
    await waitUntil(
      'the download to be under way',
      (now) => now.downloadProgress !== null && existsSync(partial),
      10_000,
    )
    // The stand-in has gone quiet. What it sent is on disk by now.
    const deadline = Date.now() + 5_000
    while (statSync(partial).size < 2_000_000 && Date.now() < deadline) await sleep(50)
    from = log.length
    send('cancel-download')
    await waitForLog('[speech] model download cancelled', 5_000, from)
    const cancelled = await status()
    expect(cancelled.downloadProgress === null, 'the download still shows as running')
    expect(cancelled.downloadError === null, 'a cancelled download was reported as an error')
    expect(
      statSync(partial).size === 2_000_000,
      `what had arrived was not kept: ${statSync(partial).size} bytes`,
    )
    modelSource.holdAfter = null
    modelSource.requests.length = 0
    from = log.length
    send('download-model')
    await waitForLog('[speech] ready', 60_000, from)
    const resumed = modelSource.requests.find((request) => request.name === 'decoder.int8.onnx')
    expect(resumed?.range === 'bytes=2000000-', `the download did not resume: ${resumed?.range}`)
    const afterResume = await dictate(SHORT)
    expectPastedIntact(afterResume.state, afterResume.session, 'the dictation after the resume')

    console.log('  ...a model that is on disk and would not start, checked from the setup window')
    /** The speech worker dies three times running; the app then stops starting it. */
    const crashUntilTheAppGivesUp = async () => {
      for (let crash = 0; crash < 3; crash++) {
        await waitUntil(
          'the worker to be running',
          (now) => now.speech === 'ready' && now.workerPid !== null,
          20_000,
        )
        send('kill-worker')
        await waitUntil('the worker to stop', (now) => now.speech !== 'ready', 5_000)
      }
      return waitUntil('the app to give up', (now) => now.speech === 'failed', 10_000)
    }
    const gaveUp = await crashUntilTheAppGivesUp()
    // This is the state in which the setup window offers "Check the model files".
    expect(gaveUp.modelDownloaded === true, 'the model no longer counts as downloaded')
    // With nothing wrong with the files, checking them ends in the model being loaded.
    modelSource.requests.length = 0
    from = log.length
    send('repair-model')
    await waitForLog('[speech] ready', 90_000, from)
    expect(fetched() === '', `fetched although nothing was wrong: ${fetched()}`)
    const reloaded = await dictate(SHORT)
    expectPastedIntact(
      reloaded.state,
      reloaded.session,
      'the dictation after the files checked out',
    )

    // Given up again, and this time a file has changed in a way only reading it shows.
    // Nothing has looked at the files since: the check itself has to find it.
    await crashUntilTheAppGivesUp()
    const decoderFile = fileOf('decoder.int8.onnx')
    const handle = openSync(decoderFile, 'r+')
    writeSync(handle, Buffer.alloc(4_096), 0, 4_096, 0)
    closeSync(handle)
    const record = JSON.parse(readFileSync(fileOf('.verified.json'), 'utf8'))
    record['#files']['decoder.int8.onnx'].mtimeMs = statSync(decoderFile).mtimeMs
    writeFileSync(fileOf('.verified.json'), JSON.stringify(record))
    expect(
      (await status()).modelDownloaded === true,
      'the change was meant to be one the quick check cannot see',
    )
    modelSource.requests.length = 0
    from = log.length
    send('repair-model')
    await waitForLog(
      'did not match their checksums and were removed: decoder.int8.onnx',
      60_000,
      from,
    )
    await waitForLog('[speech] ready', 90_000, from)
    expect(fetched() === 'decoder.int8.onnx', `fetched: ${fetched() || 'nothing'}`)
    const mended = await dictate(SHORT)
    expectPastedIntact(
      mended.state,
      mended.session,
      'the dictation after the check found the damage',
    )

    // And when the model is in use, the same request is turned away: a click that comes
    // late must not load the model a second time under a dictation.
    from = log.length
    send('repair-model')
    await sleep(1_500)
    expect((await status()).speech === 'ready', 'the model was taken away while it was in use')
    expect(!log.includes('[speech] loading', from), 'the model was loaded again while in use')
  } finally {
    await quit()
    modelSourceServer.closeAllConnections()
    modelSourceServer.close()
  }
}

/**
 * Cleaned mode with the real Ollama and its real model. What the model writes varies,
 * so this checks what must hold whatever it writes: the pasted text is what was said,
 * and it arrives inside the ceiling.
 */
async function measureLiveOllama(runs) {
  send('ollama-url http://127.0.0.1:11434')
  send('cleanup-model qwen3.5:4b')
  send('mode cleaned')
  const ready = await waitUntil(
    'Cleaned mode',
    (now) => now.mode === 'cleaned' && now.cleanup,
    5_000,
  )
  console.log(`\nTray: ${ready.cleanup}`)
  const rows = []
  for (let run = 0; run < runs; run++) {
    const recording = run % 2 === 0 ? SHORT : MEDIUM
    const { session, state } = await dictate(recording)
    expectPastedIntact(state, session, `dictation ${run + 1}`)
    const timings = metricsOf(session)
    expect(timings.releaseToPasteMs < 4_800, `release to paste took ${timings.releaseToPasteMs} ms`)
    rows.push({ ...timings, note: entryOf(state, session).note })
    await sleep(300)
  }
  send('mode verbatim')
  console.log('Cleaned mode with the real model (ms):')
  for (const field of ['releaseToPasteMs', 'cleanupMs']) {
    console.log(`  ${field.padEnd(18)} ${summary(rows.map((row) => row[field]))}`)
  }
  const notes = new Map()
  for (const row of rows) notes.set(row.note, (notes.get(row.note) ?? 0) + 1)
  console.log(
    `  what cleanup did   ${[...notes].map(([note, count]) => `${note} ×${count}`).join(', ')}`,
  )
}

// --- Run -----------------------------------------------------------------------------

// A run takes minutes, and the Mac may be left alone meanwhile. If its display goes off
// (which locks the screen) or it goes to sleep, the app ends the dictation in progress,
// as it should, and the scenario that was running fails for no fault of the app's. That
// happened twice on 2026-10-04. The Mac is kept awake for as long as this run lasts.
const awake = spawn('/usr/bin/caffeinate', ['-d', '-i', '-w', String(process.pid)], {
  stdio: 'ignore',
})
awake.on('error', () => {})
/** How many times the Mac's power state has cut a dictation short in this run. */
const powerEvents = () =>
  count('interrupted by sleep') +
  count('interrupted by screen lock') +
  count('interrupted by user switch')

scenario('QA regression: Delete Everything must erase recoverable transcript text', async () => {
  const { session, state } = await dictate(SHORT)
  expectPastedIntact(state, session)
  await showPage('privacy', 'Privacy')
  send('answer-dialogs yes')
  try {
    expect((await pressHub('Delete Everything…')) === 'pressed', 'Delete Everything unavailable')
    const after = await waitUntil(
      'deletion to finish',
      (now) =>
        askedOf(now, 'deleteStored:everything') > 0 &&
        now.history.count === 0 &&
        now.privacy.countsBytes === 0,
      5000,
    )
    const pastesBefore = after.pastes.length
    send('paste-last')
    await sleep(800)
    const recovered = await status()
    const detail = {
      historyRows: recovered.history.count,
      recoveryEntriesWithText: recovered.recovery.filter((x) => x.hasText).length,
      additionalPastes: recovered.pastes.length - pastesBefore,
      privacyProblem: recovered.privacy.problem,
    }
    console.log(`QA5_DELETE_EVIDENCE ${JSON.stringify(detail)}`)
    expect(
      detail.recoveryEntriesWithText === 0 && detail.additionalPastes === 0,
      'Deleted transcript remains recoverable and pasteable: ' + JSON.stringify(detail),
    )
  } finally {
    send('answer-dialogs none')
  }
})
scenario(
  'QA regression: Stop saving during recording must prevent later evaluation writes',
  async () => {
    send('evaluation on')
    await waitUntil('evaluation enabled', (now) => now.evaluationRecording, 3000)
    const before = savedDictations().length
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms + 400)
    send('evaluation off')
    await waitUntil('evaluation disabled before release', (now) => !now.evaluationRecording, 3000)
    send('release')
    const state = await waitIdle(20000)
    expectPastedIntact(state, session)
    await sleep(300)
    const created = savedDictations().length - before
    console.log(
      `QA5_STOP_SAVING_EVIDENCE ${JSON.stringify({ recordingsCreatedAfterOptOut: created, evaluationRecording: state.evaluationRecording })}`,
    )
    expect(created === 0, `${created} evaluation recordings written after Stop saving`)
  },
)

// Uses only the existing quiet-app harness, fake audio, isolated userData/evaluation
// directories, intercepted clipboard/paste/dialog/browser/login doors.

scenario(
  'QA regression: setup practice must not persist audio or text after promising nothing is kept',
  async () => {
    send('mode verbatim')
    send('evaluation on')
    try {
      await waitUntil(
        'evaluation enabled for setup re-entry',
        (now) => now.evaluationRecording === true,
        3_000,
      )
      send('first-run again')
      await waitUntil(
        'setup guide open again',
        (now) => now.hub?.steps?.includes('welcome:current'),
        6_000,
      )
      send('first-run-step try')
      const before = await waitUntil(
        'practice step',
        (now) => now.hub?.steps?.includes('try:current'),
        3_000,
      )
      const filesBefore = savedDictations().length
      expect(before.hub?.buttons?.includes('Stop Saving'), 'Stop Saving is missing from onboarding')
      send('own-window on')
      const result = await dictate(SHORT)
      expectPastedIntact(result.state, result.session, 'setup practice')
      await sleep(700)
      const after = await status()
      const added = savedDictations().length - filesBefore
      const stopSavingVisible = after.hub?.buttons?.includes('Stop Saving') === true
      expect(after.history.count === before.history.count, 'practice unexpectedly added to history')
      expect(
        added === 0,
        `setup practice saved ${added} evaluation files; Stop Saving visible=${stopSavingVisible}; history added=0`,
      )
    } finally {
      send('own-window off')
      send('evaluation off')
      send('first-run done')
    }
  },
)

scenario('QA regression: changing the Cleanup model reruns the same Try it sentence', async () => {
  await inCleanedMode('echo', async () => {
    await showPage('home', '')
    await showPage('cleanup', 'Cleanup')
    const before = ollama.transcripts.length
    send(
      `type-hub A_sentence_to_try ${base64('um please send the finished report to the whole team later today')}`,
    )
    const deadline = Date.now() + 8_000
    while (ollama.transcripts.length === before && Date.now() < deadline) await sleep(60)
    expect(
      ollama.transcripts.length === before + 1,
      'initial Try it request did not reach the local test model',
    )
    await sleep(700)
    const asked = ollama.transcripts.length
    send('choose-hub Model empty-warm:latest')
    await waitUntil(
      'new cleanup model selected',
      (now) => now.prefs.cleanupModel === 'empty-warm:latest',
      6_000,
    )
    await sleep(4_000)
    const retried = ollama.transcripts.length - asked
    expect(
      retried >= 1,
      `model setting changed, but Try it made ${retried} new requests; previous-model result remains until text is edited`,
    )
  })
})

// The debug status exposes trayHandsFree, not the actual native menu. This probe
// therefore combines a real processing state with the actual AppTray template,
// loaded under counting Electron stubs; it does not open the system menu.
scenario(
  'QA regression: processing Cancel on the pill must also be offered by the tray menu',
  async () => {
    send('mode verbatim')
    send('text-delay 10000')
    try {
      play(SHORT)
      await press()
      await sleep(SHORT.ms + 300)
      send('release')
      // The menu as the app built it for this state: the labels a person opening it would see.
      const processing = await waitUntil(
        'processing pill Cancel',
        (now) => now.pill === 'processing' && now.pillCancel === true,
        6_000,
      )
      expect(
        processing.trayItems.includes('Cancel Dictation'),
        `pill Cancel=true; menu items: ${processing.trayItems.join(' | ')}`,
      )
    } finally {
      send('escape')
      send('text-delay 0')
      await waitIdle(20_000)
    }
    const after = await status()
    expect(
      !after.trayItems.includes('Cancel Dictation'),
      `once it is over the menu offers no Cancel; items: ${after.trayItems.join(' | ')}`,
    )
  },
)

scenario(
  'QA regression: latest Cleanup model choice wins while earlier validation is slow',
  async () => {
    await inCleanedMode('echo', async () => {
      await showPage('home', '')
      await showPage('cleanup', 'Cleanup')
      // Allow its initial choices to be listed before delaying subsequent validation.
      await sleep(3_000)
      ollama.tagsDelayMs = 900
      try {
        let fromQa5 = log.length
        send('choose-hub Model empty-warm:latest')
        await waitForLog('hub field "Model": set', 3_000, fromQa5)
        await sleep(150)
        fromQa5 = log.length
        // type-hub decodes an omitted value as empty, which is the Rules only option.
        send('type-hub Model')
        await waitForLog('hub field "Model": set', 3_000, fromQa5)
        await waitUntil(
          'last choice Rules only applied',
          (now) => now.prefs.cleanupModel === null,
          2_000,
        )
        await sleep(3_500)
        const afterQa5 = await status()
        expect(
          afterQa5.prefs.cleanupModel === null,
          'the earlier model selection overwrote the later Rules only choice after validation completed',
        )
      } finally {
        ollama.tagsDelayMs = 0
      }
    })
  },
)

scenario(
  'QA regression: Delete Everything discards opening, listening, processing, Undo and Retry',
  async () => {
    send('mode verbatim')
    await showPage('privacy', 'Privacy')
    send('answer-dialogs yes')
    try {
      for (const phase of ['opening', 'listening', 'processing', 'Undo', 'Retry']) {
        send('text-delay 10000')
        play(SHORT)
        if (phase === 'Retry') send('fail-next-transcript')
        await press()
        if (phase !== 'opening') await sleep(phase === 'listening' ? 200 : SHORT.ms + 300)
        if (phase === 'Undo') send('escape')
        if (phase === 'processing' || phase === 'Retry') send('release')
        if (phase === 'processing')
          await waitUntil('pending transcription', (now) => now.state === 'processing', 3000)
        if (phase === 'Undo' || phase === 'Retry')
          await waitUntil('recovery offer', (now) => now.trayOffer === phase, 5000)
        const before = await status()
        expect(
          (await pressHub('Delete Everything…')) === 'pressed',
          'Delete Everything unavailable during ' + phase,
        )
        await waitUntil(
          'privacy discard',
          (now) =>
            now.asked.filter((x) => x === 'deleteStored:everything').length >
              before.asked.filter((x) => x === 'deleteStored:everything').length &&
            now.history.count === 0 &&
            now.recovery.length === 0 &&
            now.openMicrophones === 0,
          6000,
        )
        send('paste-last')
        send('copy-last')
        send('click-pill ' + (phase === 'Retry' ? 'Retry' : 'Undo'))
        send('text-delay 0')
        await sleep(400)
        const after = await status()
        expect(
          after.recovery.length === 0 && !after.holdsRecording && after.trayOffer === null,
          'recovery remains after deletion during ' + phase,
        )
      }
    } finally {
      send('escape')
      send('text-delay 0')
      send('answer-dialogs none')
    }
  },
)
scenario(
  'QA regression: Delete Everything aborts model cleanup and rejects its late response',
  async () => {
    await inCleanedMode('slow', async () => {
      await showPage('privacy', 'Privacy')
      send('answer-dialogs yes')
      play(SHORT)
      await press()
      await sleep(SHORT.ms + 300)
      send('release')
      await waitUntil(
        'model cleanup',
        (now) => now.pill === 'processing' && now.state === 'processing',
        5000,
      )
      expect(
        (await pressHub('Delete Everything…')) === 'pressed',
        'Delete Everything unavailable during cleanup',
      )
      await waitUntil(
        'cleanup discarded',
        (now) => now.state === 'idle' && now.recovery.length === 0 && now.openMicrophones === 0,
        6000,
      )
      const pasted = (await status()).pastes.length
      await sleep(4500)
      expect((await status()).pastes.length === pasted, 'late cleanup pasted after deletion')
      send('answer-dialogs none')
    })
  },
)

const results = []
/** The app's log during each scenario that failed, printed after the results. */
const failedLogs = []
// `--only` takes part of a name, or a pattern when it starts with `/`: `/Try it|first run`.
const selected = (name) =>
  !only || (only.startsWith('/') ? new RegExp(only.slice(1)).test(name) : name.includes(only))
/** Scenarios that need a start of their own, each from a data folder made for it. */
const ownStarts = [
  [
    'without the speech model: dictation refuses and says why; after the download it works',
    withoutModel,
  ],
  [
    'at its start the app deletes a saved history only when "only until I quit" was chosen',
    historyAtStart,
  ],
]

/**
 * Puts back everything a scenario may switch on, as the run started. A scenario that
 * fails half-way does not get to switch it off itself, and every one after it would
 * fail of what it left.
 */
function putBack() {
  for (const line of [
    'escape',
    'unhover-pill',
    'text-delay 0',
    'max-recording 0',
    'mode verbatim',
    'evaluation off',
    'answer-dialogs none',
    'pretend-ready off',
    'own-window off',
    'pause off',
    'first-run done',
    'microphone default',
    'setting history-paused off',
    'setting pill-at-rest on',
    'setting key fn',
  ]) {
    send(line)
  }
  ollama.behaviour = 'echo'
  ollama.tagsDelayMs = 0
}

try {
  const measuring = realMicRuns > 0 || liveOllamaRuns > 0 || latencyRuns > 0
  const names = [...scenarios.map((item) => item.name), ...ownStarts.map(([name]) => name)]
  if (!measuring && !names.some(selected)) {
    throw new Error(`no scenario's name matches --only "${only}"`)
  }
  launch()
  await waitForLog('[debug] control line open', 15_000)
  await waitForLog('[speech] ready', 30_000)
  send('quiet-paste')
  send('own-window off')
  const start = await status()
  if (start.shortcutsActive) throw new Error('the key tap is active; refusing to run')
  if (realMicRuns > 0 && start.microphone !== 'granted') {
    throw new Error(`microphone permission is "${start.microphone}"; cannot measure the real one`)
  }

  if (realMicRuns > 0) {
    await measureRealMicrophone(realMicRuns)
  } else if (liveOllamaRuns > 0) {
    await measureLiveOllama(liveOllamaRuns)
  } else if (latencyRuns > 0) {
    await measureLatency(latencyRuns)
  } else {
    const chosen = scenarios.filter((item) => selected(item.name))
    console.log(
      `${packaged ? 'Packaged app' : 'Built output'}, ${chosen.length} scenarios × ${repeat}.`,
    )
    const tally = new Map(chosen.map((item) => [item.name, { passed: 0, failures: [] }]))
    try {
      for (let round = 0; round < repeat; round++) {
        for (const item of chosen) {
          if (item.once && round > 0) continue
          const record = tally.get(item.name)
          const interruptionsBefore = powerEvents()
          // Every scenario starts from a pill at rest. What the one before it left there
          // ("Copied", for two seconds) is not this one's to explain, and a scenario that
          // asserts a resting pill would fail or pass by the time the last one took.
          await waitUntil('the pill at rest', (now) => now.pill === 'resting', 8_000).catch(
            () => {},
          )
          const logFrom = log.length
          try {
            console.log(`[running] ${item.name}`)
            record.detail = (await item.run()) ?? record.detail
            record.passed += 1
          } catch (error) {
            // What the app logged while the scenario ran: states, timings and counts, never
            // what was said. The end of the whole run's log says nothing about a scenario
            // that failed in the middle of it.
            record.log = log
              .slice(logFrom)
              .split('\n')
              .filter((line) => line && !line.startsWith('DEBUG_STATUS'))
              .slice(-70)
              .join('\n')
            // Said with the failure, so that nobody goes looking for a bug in the app.
            const cause =
              powerEvents() > interruptionsBefore
                ? ' (the Mac locked or went to sleep while this ran; run it again)'
                : ''
            record.failures.push(error.message + cause)
            // Leave the app idle, and as the run started, for the next scenario.
            putBack()
            await waitIdle(20_000).catch(() => {})
          }
          if (exited) throw new Error('the app exited')
        }
      }
    } finally {
      // Said even when the app has gone in the middle of the run: what each scenario that
      // ran came to, and the app's log during each that failed.
      let notRun = 0
      for (const [name, record] of tally) {
        const failed = record.failures.length
        const runs = record.passed + failed
        if (runs === 0) {
          notRun += 1
          continue
        }
        results.push({ name, failed })
        console.log(
          `${failed === 0 ? '  ok  ' : '  FAIL'} ${name} (${record.passed}/${runs})` +
            (record.detail ? ` — ${record.detail}` : ''),
        )
        for (const message of new Set(record.failures)) console.log(`         ${message}`)
        if (record.log) failedLogs.push(`--- app log during "${name}" ---\n${record.log}`)
      }
      if (notRun > 0) console.log(`  ${notRun} scenarios did not run`)
    }
    const end = await status()
    console.log(
      `\n${end.pastes.length} pastes counted; microphone streams left open: ${end.openMicrophones}.`,
    )

    for (const [name, run] of ownStarts) {
      if (!selected(name)) continue
      await quit()
      try {
        await run()
        results.push({ name, failed: 0 })
        console.log(`  ok   ${name}`)
      } catch (error) {
        results.push({ name, failed: 1 })
        console.log(`  FAIL ${name}\n         ${error.message}`)
      }
    }
  }
} catch (error) {
  results.push({ name: 'run', failed: 1 })
  console.error(`\nStopped: ${error.message}`)
} finally {
  await quit()
  awake.kill()
  for (const server of [ollamaServer, redirectingServer, elsewhereServer]) {
    server.closeAllConnections()
    server.close()
  }
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((result) => result.failed > 0).length
if (results.length > 0) console.log(`${results.length - failed} passed, ${failed} failed`)
if (failed > 0) {
  // The app's log holds states, timings and counts; it never holds what was said.
  for (const entry of failedLogs) console.log(entry)
  // None when the run stopped before the app was started.
  if (log) console.log(`--- app log (tail) ---\n${log.slice(-2_500)}`)
}
process.exit(failed > 0 ? 1 : 0)
