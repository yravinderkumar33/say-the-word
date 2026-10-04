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

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures', 'audio')
const electronPath = createRequire(import.meta.url)('electron')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? '')
}
const packaged = args.includes('--packaged')
const packagedBinary = join(
  option('--package-dir') ?? join(root, 'dist', 'mac-arm64'),
  'Whisper Flow Dev.app',
  'Contents',
  'MacOS',
  'Whisper Flow Dev',
)
const repeat = Number(option('--repeat') ?? 1)
const only = option('--only')
const latencyRuns = Number(option('--latency') ?? 0)
const realMicRuns = Number(option('--real-mic') ?? 0)
const liveOllamaRuns = Number(option('--live-ollama') ?? 0)
const verbose = args.includes('--verbose')

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
    // 16-bit mono at 16 kHz, after a 44-byte header.
    ms: Math.round(((statSync(path).size - 44) / 32_000) * 1_000),
  }
}
// The recording with an amount of money in it is left out on purpose: the recognizer
// writes amounts differently from one run of the process to the next (see
// docs/benchmarks.md), which says nothing about the plumbing these scenarios test.
const SHORT = fixture('short')
const MEDIUM = fixture('medium')
const VERY_LONG = fixture('very-long')
copyFileSync(SHORT.path, microphoneFile)

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
  app = child
}

async function quit() {
  const child = app
  if (!child || child.exitCode !== null) return
  const gone = new Promise((resolve) => child.once('exit', resolve))
  child.kill()
  await Promise.race([gone, sleep(3_000)])
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
  /** Every chat request, warm-ups included. */
  chats: 0,
  /** Warm-up requests only; no transcript content. */
  warms: 0,
  /** The transcripts that chat requests carried. They are compared, never printed. */
  transcripts: [],
  url: '',
}
const ollamaServer = createServer((request, response) => {
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
    const savedMs = ((statSync(join(evaluationDir, wav)).size - 44) / 32_000) * 1_000
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
  const rows = []
  for (let run = 0; run < runs; run++) {
    const { session, state } = await dictate(MEDIUM)
    expectPastedIntact(state, session)
    rows.push(metricsOf(session))
    await sleep(300)
  }
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

const results = []
launch()
try {
  await waitForLog('[debug] control line open', 15_000)
  await waitForLog('[speech] ready', 30_000)
  send('quiet-paste')
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
    const chosen = scenarios.filter((item) => !only || item.name.includes(only))
    console.log(
      `${packaged ? 'Packaged app' : 'Built output'}, ${chosen.length} scenarios × ${repeat}.`,
    )
    const tally = new Map(chosen.map((item) => [item.name, { passed: 0, failures: [] }]))
    for (let round = 0; round < repeat; round++) {
      for (const item of chosen) {
        if (item.once && round > 0) continue
        const record = tally.get(item.name)
        const interruptionsBefore = powerEvents()
        try {
          record.detail = (await item.run()) ?? record.detail
          record.passed += 1
        } catch (error) {
          // Said with the failure, so that nobody goes looking for a bug in the app.
          const cause =
            powerEvents() > interruptionsBefore
              ? ' (the Mac locked or went to sleep while this ran; run it again)'
              : ''
          record.failures.push(error.message + cause)
          // Leave the app idle for the next scenario, whatever state this one left.
          send('escape')
          send('text-delay 0')
          send('max-recording 0')
          await waitIdle(20_000).catch(() => {})
        }
        if (exited) throw new Error('the app exited')
      }
    }
    for (const [name, record] of tally) {
      const failed = record.failures.length
      const runs = record.passed + failed
      results.push({ name, failed })
      console.log(
        `${failed === 0 ? '  ok  ' : '  FAIL'} ${name} (${record.passed}/${runs})` +
          (record.detail ? ` — ${record.detail}` : ''),
      )
      for (const message of new Set(record.failures)) console.log(`         ${message}`)
    }
    const end = await status()
    console.log(
      `\n${end.pastes.length} pastes counted; microphone streams left open: ${end.openMicrophones}.`,
    )

    const name =
      'without the speech model: dictation refuses and says why; after the download it works'
    if (!only || name.includes(only)) {
      await quit()
      try {
        await withoutModel()
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
  console.log(`--- app log (tail) ---\n${log.slice(-2_500)}`)
}
process.exit(failed > 0 ? 1 : 0)
