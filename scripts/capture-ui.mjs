// Takes pictures of the interface as it is built, without disturbing the person using
// the Mac.
//
// The app is started the way `scripts/test-app.mjs` starts it: no key tap, never in
// front, a recording for a microphone, its own data folder, pastes counted instead of
// typed. The pill is then walked through its states with the debug control line, and
// each is photographed from the page itself; the main window is created but never
// shown. Nothing else on the screen is in any picture, and no clipboard is touched.
//
// Ollama is stood in for by a small server on this Mac, so that the pictures do not
// depend on whether the real one is installed or running.
//
//   npm run pictures                 into dist/.pictures/
//   npm run pictures -- <folder>     into that folder
//
// What to look for is in docs/05-design-brief.md: the design is the specification.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { take } from './lib/build-output.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// The app is run from the build in out/: nobody builds over it meanwhile.
const inUse = take('pictures')
if (inUse) {
  console.error(inUse)
  process.exit(1)
}
const out = resolve(process.argv[2] ?? join(root, 'dist', '.pictures'))
const electronPath = createRequire(import.meta.url)('electron')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const recording = join(root, 'tests', 'fixtures', 'audio', 'medium.samantha.wav')
if (!existsSync(recording)) {
  console.error('The test recordings are missing. Run `npm run fixtures` first.')
  process.exit(1)
}
mkdirSync(out, { recursive: true })
const scratch = mkdtempSync(join(tmpdir(), 'flow-pictures-'))
const microphone = join(scratch, 'microphone.wav')
copyFileSync(recording, microphone)

// --- A stand-in for Ollama -------------------------------------------------------------

/** Answers the way Ollama does, with two models; a third is one Ollama would run elsewhere. */
const ollama = createServer((request, response) => {
  let body = ''
  request.on('data', (chunk) => (body += chunk))
  request.on('end', () => {
    const json = (value) => response.end(JSON.stringify(value))
    if (request.url === '/api/version') return json({ version: 'stand-in' })
    if (request.url === '/api/tags') {
      const model = (name, size, extra = {}) => ({
        name,
        size,
        digest: `digest-of-${name}`,
        capabilities: ['completion'],
        ...extra,
      })
      return json({
        models: [
          model('qwen2.5:3b', 1_900_000_000),
          model('llama3.2:3b', 2_000_000_000),
          model('big:cloud', 0, { remote_host: 'https://ollama.com' }),
        ],
      })
    }
    if (request.url === '/api/show') return json({ capabilities: ['completion'] })
    if (request.url !== '/api/chat') return response.writeHead(404).end('{}')
    const last = JSON.parse(body).messages.at(-1)
    const transcript = /<transcript>\n([\s\S]*)\n<\/transcript>/.exec(last.content)?.[1]
    const done = { done: true, done_reason: 'stop', eval_count: 14, eval_duration: 5e8 }
    const say = (content) =>
      response.end(
        `${JSON.stringify({ message: { role: 'assistant', content }, done: false })}\n` +
          `${JSON.stringify({ message: { role: 'assistant', content: '' }, ...done })}\n`,
      )
    // A warm-up carries the instructions and no transcript.
    if (last.role !== 'user' || transcript === undefined) return say('')
    // The one sentence the pictures try has one tidy answer.
    return setTimeout(() => say('So let’s meet Friday at 3 PM and bring the Q3 report.'), 700)
  })
})
await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve))
const ollamaUrl = `http://127.0.0.1:${ollama.address().port}`

// --- The app ---------------------------------------------------------------------------

let log = ''
const app = spawn(electronPath, [root, '--hidden'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    WHISPER_FLOW_DEBUG_CONTROL: '1',
    WHISPER_FLOW_QUIET: '1',
    WHISPER_FLOW_MUTE: '1',
    WHISPER_FLOW_USER_DATA_DIR: scratch,
    WHISPER_FLOW_EVAL_DIR: join(scratch, 'evaluation'),
    WHISPER_FLOW_FAKE_MIC: `${microphone}%noloop`,
    // Pastes are counted once `quiet-paste` is sent. Were it ever not to take effect, a
    // paste would go to the helper, and this refuses it: no app has this bundle id.
    WHISPER_FLOW_PASTE_ONLY_INTO: 'test.say-the-word.nowhere',
  },
})
app.stdout.on('data', (chunk) => (log += chunk))
app.stderr.on('data', (chunk) => (log += chunk))
// Whatever ends this script, the app it started ends with it, and its data folder goes.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, (error) => {
    console.error(`The pictures script itself failed: ${error?.stack ?? error}`)
    app.kill('SIGKILL')
    try {
      rmSync(scratch, { recursive: true, force: true })
    } catch {
      // A process of the app's that has not gone yet may still be writing there.
    }
    process.exit(1)
  })
}

/** Ends the app, and resolves once it has gone: its data folder is removed after it. */
async function quit() {
  if (app.exitCode !== null || app.signalCode !== null) return
  const gone = new Promise((resolve) => app.once('exit', resolve))
  app.kill()
  await Promise.race([gone, sleep(3_000)])
  // An app that has not gone by now is not left running with its folder taken away.
  if (app.exitCode === null && app.signalCode === null) {
    app.kill('SIGKILL')
    await Promise.race([gone, sleep(2_000)])
  }
}
const send = (line) => app.stdin.write(`${line}\n`)
const base64 = (text) => Buffer.from(text).toString('base64')

async function waitForLog(text, timeoutMs, from = 0) {
  const deadline = Date.now() + timeoutMs
  while (!log.includes(text, from)) {
    if (Date.now() > deadline) throw new Error(`the app never logged "${text}"`)
    await sleep(25)
  }
}

/** The app's own account of itself: states and counts, never text. */
async function status() {
  const from = log.length
  send('status')
  await waitForLog('DEBUG_STATUS', 5_000, from)
  await sleep(30)
  const line = log
    .slice(from)
    .split('\n')
    .find((item) => item.startsWith('DEBUG_STATUS '))
  return JSON.parse(line.slice('DEBUG_STATUS '.length))
}

async function until(what, test, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const now = await status()
    if (test(now)) return now
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${what} (pill: ${now.pill}; window: ${JSON.stringify(now.hub)})`,
      )
    }
    await sleep(60)
  }
}
const pillIs = (kind) => (now) => now.pill === kind

/** Saves one picture. `kind` is `pill`, `hub` or `tray`; a size applies to the main window. */
async function picture(kind, name, option = '') {
  const from = log.length
  const path = join(out, `${name}.png`)
  // The control line splits at spaces: one in the path is written as `%20`.
  send(`capture-${kind} ${encodeURI(path)} ${option}`.trim())
  await waitForLog(`[debug] captured ${path}`, 8_000, from)
}

/** The pill settles into a new shape over a moment: photograph it after that. */
async function pillPicture(name) {
  await sleep(350)
  await picture('pill', name)
}

/** Shows a page of the main window, and waits until it is the one drawn. */
async function page(name, heading) {
  send(`hub-page ${name}`)
  await until(`the ${name} page`, (now) => (now.hub?.heading ?? '').startsWith(heading), 6_000)
}

/** A picture of the main window in both appearances. */
async function both(name, size = '900x720') {
  for (const appearance of ['light', 'dark']) {
    send(`appearance ${appearance}`)
    await sleep(500)
    await picture('hub', `${name}-${appearance}`, size)
  }
}

/** A dictation with words of the script's own, for a list that looks lived in. */
function addHistory(entry) {
  send(`add-history ${base64(JSON.stringify(entry))}`)
}
const HOUR = 3_600_000
const SAMPLES = [
  {
    agoMs: 26 * HOUR,
    app: 'Messages',
    written: 'On my way, ten minutes.',
    outcome: 'focusMoved',
    fetched: 'copied',
  },
  { agoMs: 28 * HOUR, app: 'Slack', written: '', outcome: 'noSpeech' },
  {
    agoMs: 29 * HOUR,
    app: 'Notes',
    mode: 'cleaned',
    note: 'unreachable',
    heard:
      'um call the dentist about uh moving thursday and buy coffee filters oat milk and and batteries',
    written:
      'Call the dentist about moving Thursday, and buy coffee filters, oat milk and batteries.',
    audioMs: 6_000,
    timings: { releaseToTextMs: 390, tidyMs: 10, pasteMs: 40 },
  },
  {
    agoMs: 5 * 60_000 + 4 * HOUR,
    app: 'Slack',
    written: 'So I think we should, actually',
    outcome: 'cancelled',
  },
  {
    agoMs: 4 * HOUR,
    app: 'Terminal',
    written:
      'Refactor the download manager so that a stopped download resumes from the last complete chunk, and add a test for it',
  },
  {
    agoMs: 3 * HOUR,
    app: 'Visual Studio Code',
    written: 'Keep the partial file when a download fails, so that Try again resumes',
    outcome: 'focusMoved',
  },
  {
    agoMs: 2 * HOUR,
    app: 'Mail',
    mode: 'cleaned',
    note: 'cleaned',
    heard:
      'thanks for sending the draft i have read it twice and i think the second section can go the first already makes the case',
    written:
      'Thanks for sending the draft. I have read it twice, and I think the second section can go: the first already makes the case.',
  },
  {
    agoMs: HOUR,
    app: 'Slack',
    mode: 'cleaned',
    note: 'cleaned',
    heard: 'can we move the design review to thursday at 2 tuesday is full for me',
    written: 'Can we move the design review to Thursday at 2? Tuesday is full for me.',
  },
]

try {
  await waitForLog('[debug] control line open', 15_000)
  await until('the speech model', (now) => now.speech === 'ready', 60_000)
  send('quiet-paste')
  // The instance has no key tap; the pictures show a Mac on which everything is in place.
  send('pretend-ready on')
  // Nothing answers here: Ollama as it is before it has been started.
  send('ollama-url http://127.0.0.1:9')
  await sleep(300)

  // --- The menu-bar icon, in each of its five shapes ---
  for (const state of ['ready', 'live', 'attention', 'paused', 'saving']) {
    await picture('tray', `menu-bar-icon-${state}`, state)
  }

  // --- The pill ---
  await pillPicture('pill-01-resting')
  send('hover-pill')
  await sleep(600)
  await pillPicture('pill-02-hint')
  send('unhover-pill')
  await sleep(300)

  // Nothing to paste yet: a confirmation, with nothing to press.
  send('paste-last')
  await until('the confirmation', pillIs('recovery'))
  await pillPicture('pill-03-confirmation')
  await until('rest', pillIs('resting'))

  // --- Before the first dictation: the empty pages ---
  await page('history', 'History')
  await both('history-empty')
  await page('privacy', 'Privacy')
  await both('privacy-empty')

  // A held key, then a text that takes long enough for Cancel to be offered.
  send('text-delay 2600')
  send('press')
  await until('listening', pillIs('listening'))
  await sleep(600)
  await pillPicture('pill-04-listening')
  await sleep(1_500)
  send('release')
  await until('processing', pillIs('processing'))
  await pillPicture('pill-05-processing')
  await until('Cancel', (now) => now.pillCancel)
  await pillPicture('pill-06-processing-with-cancel')
  send('press')
  await pillPicture('pill-07-busy')
  await until('rest', pillIs('resting'), 15_000)
  send('text-delay 0')

  // Hands-free, then Esc: Cancelled, with Undo.
  send('hands-free')
  await until('hands-free', (now) => now.pillHandsFree)
  await sleep(1_000)
  await pillPicture('pill-08-hands-free')
  send('escape')
  await until('the Cancelled message', pillIs('recovery'))
  await pillPicture('pill-09-cancelled-with-undo')
  send('click-pill Dismiss')
  await until('rest', pillIs('resting'))

  // A decode that fails: a problem, with Retry.
  send('fail-next-transcript')
  send('press')
  await until('listening', pillIs('listening'))
  await sleep(1_200)
  send('release')
  await until('the failure', pillIs('recovery'), 15_000)
  await pillPicture('pill-10-problem-with-retry')
  send('click-pill Dismiss')
  await until('rest', pillIs('resting'))

  // Interrupted with its text kept, then the mark the message leaves behind.
  send('press')
  await until('listening', pillIs('listening'))
  await sleep(2_500)
  send('abort')
  await until('the interruption', pillIs('recovery'), 15_000)
  await pillPicture('pill-11-interrupted-text-kept')
  send('click-pill Dismiss')
  await until('the mark', (now) => now.pill === 'resting' && now.pillWaiting)
  await pillPicture('pill-12-text-waiting')
  send('hover-pill')
  await sleep(600)
  await pillPicture('pill-13-text-waiting-hint')
  // The pointer is rested on the pill only once it is at rest again: a pointer put where
  // the middle of the taller hint was would be above the pill it shrinks back to.
  const backAtRest = async () => {
    send('unhover-pill')
    await until('the pill at rest', (now) => now.pillShape === 'rest', 3_000)
  }
  await backAtRest()

  // Paused: every shortcut is off, so the hint for waiting text names none.
  send('pause')
  await until('the pause', (now) => now.paused === true, 3_000)
  send('hover-pill')
  await until('the hint for waiting text', (now) => now.pillShape === 'waitingHint', 3_000)
  await pillPicture('pill-15-paused-hint-text-waiting')
  await backAtRest()
  // With nothing waiting, the hint says until when, and where to resume.
  send('pause off')
  await until('dictation resumed', (now) => now.paused === false, 3_000)
  send('copy-last')
  await until(
    'the mark to go',
    (now) => now.pill === 'resting' && now.pillWaiting === false && now.pillShape === 'rest',
    6_000,
  )
  send('pause')
  await until('the pause', (now) => now.paused === true, 3_000)
  send('hover-pill')
  await until('the hint of a paused pill', (now) => now.pillShape === 'hint', 3_000)
  await pillPicture('pill-14-paused-hint')
  await backAtRest()
  send('pause off')
  await until('dictation resumed', (now) => now.paused === false, 3_000)

  // --- Home and History, with a history that looks lived in ---
  for (const sample of SAMPLES) addHistory(sample)
  send('mode cleaned')
  send(`ollama-url ${ollamaUrl}`)
  send('cleanup-model qwen2.5:3b')
  await page('home', 'Ready. Hold')
  await sleep(1_800)
  await both('home')
  send('appearance light')
  await sleep(400)
  await picture('hub', 'home-light-small', '720x480')

  send('pause')
  await sleep(1_800)
  await picture('hub', 'home-light-paused', '900x720')
  send('pause off')
  send('conflict Wispr_Flow')
  await sleep(1_800)
  await picture('hub', 'home-light-key-conflict', '900x720')
  send('conflict none')
  // What a Mac shows before Accessibility is granted: the one thing to do, with its button.
  send('pretend-ready no-accessibility')
  send('appearance dark')
  await sleep(1_800)
  await picture('hub', 'home-dark-needs-accessibility', '900x720')
  send('pretend-ready on')
  send('appearance light')
  await sleep(1_800)

  await page('history', 'History')
  await sleep(600)
  await both('history')
  // Opened: the row that was tidied with the rules only, because Ollama was not running.
  send('focus-hub [role="listbox"]')
  await sleep(300)
  // It is the oldest, so the last: the keyboard walks down to it.
  for (let step = 0; step < 30 && (await status()).hub.selected !== 'test-3'; step++) {
    send('key-hub ArrowDown')
    await sleep(80)
  }
  send('key-hub Enter')
  await until('the opened row', (now) => now.hub?.heading === 'Notes', 5_000)
  await both('history-opened')
  await page('history', 'History')

  // Kept on disk, and paused: the amber line, and the notice with its one action.
  send('answer-dialogs yes')
  send('choose-hub Keep week')
  await until('history on disk', (now) => now.history.keep === 'week', 5_000)
  send('setting history-paused on')
  await until('the pause', (now) => now.history.paused === true, 3_000)
  await sleep(1_800)
  await both('history-paused-on-disk')
  send('setting history-paused off')
  send('choose-hub Keep session')
  await until('history in memory', (now) => now.history.keep === 'session', 5_000)

  // --- Cleanup ---
  await page('cleanup', 'Cleanup')
  await until('Ollama, running', (now) => now.cleanup.startsWith('Cleaned with'), 8_000)
  send(
    `type-hub A_sentence_to_try ${base64('um so let’s meet thursday no wait friday at 3 pm and uh bring the the q3 report')}`,
  )
  await sleep(4_500)
  await both('cleanup')
  send('cleanup-model big:cloud')
  await sleep(3_200)
  await picture('hub', 'cleanup-dark-model-refused', '900x720')
  send('cleanup-model qwen2.5:3b')
  send('ollama-url http://127.0.0.1:9')
  send(`type-hub A_sentence_to_try ${base64('')}`)
  await sleep(3_600)
  send('appearance light')
  await sleep(400)
  await picture('hub', 'cleanup-light-ollama-not-running', '900x720')

  // --- Privacy ---
  await page('privacy', 'Privacy')
  await sleep(3_000)
  await both('privacy')
  send('evaluation on')
  await sleep(3_000)
  await picture('hub', 'privacy-dark-saving', '900x720')
  send('evaluation off')

  // --- Settings: one page that scrolls, shown at full length ---
  await page('settings', 'Settings')
  await sleep(1_800)
  await both('settings', '900x1380')
  send('appearance dark')
  await sleep(400)
  await picture('hub', 'settings-dark-first-screen', '900x720')

  // --- About ---
  await page('about', 'Say the Word')
  await both('about')

  // --- The first run, step by step ---
  send('first-run again')
  await until('the first run', (now) => now.hub?.steps?.length > 0, 6_000)
  send('appearance light')
  await sleep(600)
  for (const step of [
    'welcome',
    'microphone',
    'accessibility',
    'keys',
    'try',
    'cleaned',
    'ready',
  ]) {
    if (step === 'keys') send('conflict Wispr_Flow')
    send(`first-run-step ${step}`)
    // Long enough for the microphone check to hear the recording, and for Ollama to be asked.
    await sleep(step === 'microphone' || step === 'cleaned' ? 3_500 : 1_900)
    await picture('hub', `first-run-${step}-light`, '900x720')
    if (step === 'keys') send('conflict none')
  }
  send('appearance dark')
  send('first-run-step try')
  await sleep(900)
  await picture('hub', 'first-run-try-dark', '900x720')
  send(`ollama-url ${ollamaUrl}`)
  send('first-run-step cleaned')
  await sleep(3_500)
  await picture('hub', 'first-run-cleaned-dark-ollama-running', '900x720')
  send('first-run done')

  // --- With Increase Contrast, and with Reduce Transparency ---
  // The design's accessibility round: the same window and pill, drawn as those settings
  // of the Mac draw them. The resting pill is the one thing that must not change.
  const drawnAs = async (setting) => {
    const from = log.length
    send(`draw-as ${setting}`)
    await waitForLog(`[debug] drawn as ${setting}`, 6_000, from)
    await sleep(400)
  }
  await page('home', 'Ready. Hold')
  await drawnAs('more-contrast')
  await both('home-more-contrast')
  await page('history', 'History')
  await sleep(600)
  await both('history-more-contrast')
  await pillPicture('pill-16-more-contrast-resting')
  send('hover-pill')
  await until('the hint', (now) => now.pillShape === 'hint', 3_000)
  await pillPicture('pill-17-more-contrast-hint')
  await backAtRest()
  send('hands-free')
  await until('hands-free', (now) => now.pillHandsFree)
  await sleep(1_000)
  await pillPicture('pill-18-more-contrast-hands-free')
  send('escape')
  await until('the Cancelled message', pillIs('recovery'))
  await pillPicture('pill-19-more-contrast-cancelled-with-undo')
  await drawnAs('less-transparency')
  await pillPicture('pill-20-less-transparency-cancelled-with-undo')
  send('click-pill Dismiss')
  await until('rest', pillIs('resting'))
  await pillPicture('pill-21-less-transparency-resting')
  await drawnAs('usual')

  send('appearance system')
  console.log(`Pictures are in ${out}`)
} catch (error) {
  console.error(`Stopped: ${error.message}`)
  const lines = log.split('\n').filter((line) => !line.startsWith('DEBUG_STATUS'))
  console.error(lines.slice(-20).join('\n'))
  process.exitCode = 1
} finally {
  await quit()
  ollama.closeAllConnections()
  ollama.close()
  // The data folder made for this run: nothing in it is anyone's.
  rmSync(scratch, { recursive: true, force: true })
}
