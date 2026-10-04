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
//   npm run test:app -- --live-ollama 5   Cleaned mode with the real Ollama on this machine
//                                         and its real model, five dictations
import { spawn, spawnSync } from 'node:child_process'
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures', 'audio')
const electronPath = createRequire(import.meta.url)('electron')
const packagedBinary = join(
  root,
  'dist',
  'mac-arm64',
  'Whisper Flow Dev.app',
  'Contents',
  'MacOS',
  'Whisper Flow Dev',
)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const args = process.argv.slice(2)
const option = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? '')
}
const packaged = args.includes('--packaged')
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
  /** echo | slow | garbage | remoteModel | remoteAlias | remoteReply */
  behaviour: 'echo',
  /** Every chat request, warm-ups included. */
  chats: 0,
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
      return json({ models: [entry('stand-in:latest'), entry('leaky:latest')] })
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
      message: { content: '' },
      done: true,
      done_reason: 'stop',
      eval_count: 12,
      eval_duration: 4e8,
    }
    // A warm-up carries the instructions and no transcript.
    if (last.role !== 'user' || transcript === undefined) return lines(done)
    ollama.transcripts.push(transcript)

    const say = (text) => ({ message: { content: text } })
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

/** A separate launch with an empty models folder: dictation must refuse, and say why. */
async function withoutModel() {
  const emptyModels = join(scratch, 'no-models')
  mkdirSync(emptyModels, { recursive: true })
  launch({ WHISPER_FLOW_MODELS_DIR: emptyModels })
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

    // The Download button, without the network: every file is already on disk as an
    // unfinished download of the right size, so the app only has to check and adopt it.
    const partials = join(emptyModels, MODEL_ID)
    mkdirSync(partials, { recursive: true })
    for (const name of readdirSync(join(modelDir, MODEL_ID))) {
      if (name.startsWith('.')) continue
      copyFileSync(
        join(modelDir, MODEL_ID, name),
        join(partials, `${name}.partial`),
        constants.COPYFILE_FICLONE,
      )
    }
    send('download-model')
    await waitForLog('[speech] ready', 60_000)
    expect(existsSync(join(partials, '.verified.json')), 'the model was not marked as verified')
    const { session, state: loaded } = await dictate(SHORT)
    expectPastedIntact(loaded, session, 'the first dictation after the download')
  } finally {
    await quit()
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
        try {
          record.detail = (await item.run()) ?? record.detail
          record.passed += 1
        } catch (error) {
          record.failures.push(error.message)
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
  ollamaServer.closeAllConnections()
  ollamaServer.close()
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((result) => result.failed > 0).length
if (results.length > 0) console.log(`${results.length - failed} passed, ${failed} failed`)
if (failed > 0) {
  // The app's log holds states, timings and counts; it never holds what was said.
  console.log(`--- app log (tail) ---\n${log.slice(-2_500)}`)
}
process.exit(failed > 0 ? 1 : 0)
