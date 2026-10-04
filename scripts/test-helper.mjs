// Integration test for the Swift helper against the real operating system:
// the key event tap (driven by synthetic key events) and a real paste into TextEdit,
// a Chromium page and Terminal.
//
// It needs the Accessibility permission for whatever runs it (your terminal), and for
// about forty seconds it takes keyboard focus: it opens TextEdit, a small Electron
// window, a password dialog and Terminal in turn, presses keys and pastes test lines
// into them, then returns to the app you were in. Do not use the Mac while it runs.
//
// What keeps it out of the way of someone who is using the Mac:
//   - it does not start while a call, a video or a recording is on;
//   - it presses keys and pastes only while an app it opened itself is in front, and
//     stops for good the moment another app is.
//
//   npm run test:helper:integration
//   npm run test:helper:integration -- --when-idle 120  start once nobody has touched the Mac for 120 s
//   npm run test:helper:integration -- --even-if-in-use run although a call or a video is on
//   npm run test:helper:integration -- --hold-password 65
//                                         also leave a browser-style password field focused
//                                         for that many seconds, and check that a paste into
//                                         it is still refused. Takes focus for that long.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mayTakeTheKeyboard } from './lib/mac-in-use.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const helperPath = join(root, 'resources', 'bin', 'flow-helper')
const toolEnv = { ...process.env, FLOW_HELPER_TEST_TOOLS: '1' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idleOption = process.argv.indexOf('--when-idle')
const whenIdle = idleOption === -1 ? 0 : Number(process.argv[idleOption + 1] ?? 0)
const holdOption = process.argv.indexOf('--hold-password')
const holdPasswordSeconds = holdOption === -1 ? 0 : Number(process.argv[holdOption + 1] ?? 0)
const evenIfInUse = process.argv.includes('--even-if-in-use')

// The apps this test puts in front itself. Keys and pastes go to these and nowhere else.
const TEXTEDIT = 'com.apple.TextEdit'
const FINDER = 'com.apple.finder'
const CHROMIUM = 'com.github.Electron'
const TERMINAL = 'com.apple.Terminal'
/** `osascript` shows the password dialog, and has no bundle id. */
const DIALOG_HOST = 'osascript'
let launchedTextEdit = false
let launchedTerminal = false

const FN = 63
/** A key code no keyboard has, so the "another key" press does nothing in any app. */
const INERT_KEY = 255
const ESCAPE = 53
const COMMAND = 55
const CONTROL = 59
const LETTER_V = 9

const BINDINGS = [
  { id: 'ptt', chords: [[FN]] },
  { id: 'pasteLast', chords: [[COMMAND, CONTROL, LETTER_V]] },
]

const results = []
function record(name, status, detail = '') {
  results.push({ name, status })
  const mark = { ok: '  ok  ', FAIL: '  FAIL', skip: '  skip' }[status]
  console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`)
}
/** Thrown by a check that cannot run here; it is reported as skipped, not failed. */
class Skip extends Error {}
/**
 * Thrown when an app this test did not open is in front: someone is using the Mac.
 * Nothing more is pressed or pasted after it, and what is left of the test is skipped.
 */
class FocusLost extends Error {}
let focusLost = false
async function check(name, run) {
  if (focusLost) return record(name, 'skip', 'another app had come to the front')
  try {
    record(name, 'ok', (await run()) ?? '')
  } catch (error) {
    if (error instanceof Skip) return record(name, 'skip', error.message)
    if (error instanceof FocusLost) {
      focusLost = true
      return record(name, 'skip', error.message)
    }
    // A check that fails while an app of someone else's is in front says nothing about
    // the helper: a paste is refused, and a document read finds another app's text.
    const front = focusedValue()
    if (isOurs(front)) return record(name, 'FAIL', error.message)
    focusLost = true
    record(name, 'skip', `${lostTo(front).message} (the check had found: ${error.message})`)
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message)
}

class Helper {
  constructor() {
    this.child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'inherit'] })
    this.events = []
    this.pending = new Map()
    this.nextId = 1
    this.exited = new Promise((resolve) => this.child.once('exit', resolve))
    let buffer = ''
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line) this.onMessage(JSON.parse(line))
      }
    })
  }

  onMessage(message) {
    if ('id' in message && 'ok' in message) {
      const waiter = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (!waiter) return
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(new Error(message.error))
    } else {
      this.events.push(message)
    }
  }

  request(type, fields = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no reply to ${type}`)), 4_000)
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      })
      this.child.stdin.write(`${JSON.stringify({ ...fields, id, type })}\n`)
    })
  }

  mark() {
    return this.events.length
  }

  /** Waits until the events since `cursor` satisfy `predicate`, then returns them. */
  async eventsWhen(cursor, predicate, what, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const since = this.events.slice(cursor)
      if (predicate(since)) return since
      if (Date.now() > deadline) {
        const seen = since.map((event) => `${event.type}${event.id ? `:${event.id}` : ''}`)
        throw new Error(`${what}: saw [${seen.join(', ')}]`)
      }
      await sleep(25)
    }
  }

  async close() {
    this.child.stdin.end()
    return Promise.race([this.exited, sleep(3_000).then(() => 'timeout')])
  }
}

/**
 * Whether the app in front is one this test put there. `app` is a captured target, or
 * what the focused-value tool reports, which has no name: with no bundle id and no
 * name it is the password dialog's host, or nothing at all.
 */
const isOurs = (app) =>
  [TEXTEDIT, FINDER, CHROMIUM].includes(app.bundleId) ||
  (app.bundleId === TERMINAL && launchedTerminal) ||
  (!app.bundleId && (app.appName === undefined || app.appName === DIALOG_HOST))
const lostTo = (app) =>
  new FocusLost(
    `${app.bundleId || app.appName || 'another app'} is in front, which this test did not put there; no more keys are pressed`,
  )

function focusedValue() {
  const result = spawnSync(helperPath, ['--focused-value'], { env: toolEnv, encoding: 'utf8' })
  return JSON.parse(result.stdout || '{"found":false}')
}
/** The text of the focused field of `bundleId`, which must be the app in front. */
function valueIn(bundleId) {
  const focused = focusedValue()
  if (focused.bundleId !== bundleId) throw lostTo(focused)
  return focused.value
}
/** Before the test brings another of its windows forward: one of its own must be in front. */
function requireOursInFront() {
  const front = focusedValue()
  if (!isOurs(front)) throw lostTo(front)
}
/** Posts key events, but only while TextEdit is in front. */
function postKeys(script) {
  valueIn(TEXTEDIT)
  const result = spawnSync(helperPath, ['--post-keys', script], { env: toolEnv, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`post-keys failed: ${result.stderr.trim()}`)
}
/** The destination in front, which must be in `bundleId`: nothing is pasted anywhere else. */
async function captureIn(helper, bundleId) {
  const target = await helper.request('captureTarget')
  if (target.bundleId !== bundleId) throw lostTo(target)
  return target
}
const clipboardText = () => spawnSync('pbpaste', { encoding: 'utf8' }).stdout
/** The kinds of data on the clipboard, as AppleScript names them. */
function clipboardKinds() {
  const info = spawnSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' }).stdout
  return info
    .split(/,\s*/)
    .map((part) => part.trim())
    .filter((part) => part && !/^\d+$/.test(part))
}
const PLAIN_TEXT = ['«class utf8»', '«class ut16»', 'string', 'Unicode text']
const holdsOnlyPlainText = () => clipboardKinds().every((kind) => PLAIN_TEXT.includes(kind))
/**
 * Puts back the text the clipboard held before a check replaced it. Not when it now
 * holds something this test did not put there: someone has copied since, and keeps it.
 * `ours` is what the check may have left; a clipboard whose owner has gone reads as
 * empty text.
 */
function putClipboardBack(before, ours) {
  const now = clipboardText()
  if (now === before) return
  if (ours.includes(now) || (now === '' && holdsOnlyPlainText())) {
    spawnSync('pbcopy', { input: before })
  }
}
const isRunning = (name) => spawnSync('pgrep', ['-x', name]).status === 0
const kinds = (events) => events.map((event) => `${event.type}${event.id ? `:${event.id}` : ''}`)

/** For checks that replace the clipboard and put it back as plain text. */
function requirePlainTextClipboard() {
  if (!holdsOnlyPlainText()) {
    throw new Skip('the clipboard holds more than plain text; left untouched')
  }
}

async function waitForFrontApp(helper, bundleId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const target = await helper.request('captureTarget')
    if (target.bundleId === bundleId) return target
    if (Date.now() > deadline) {
      if (!isOurs(target)) throw lostTo(target)
      throw new Error(`${bundleId} never became frontmost`)
    }
    await sleep(150)
  }
}

// The test closes the TextEdit it opened, so it never uses one that was open already.
if (isRunning('TextEdit')) {
  console.log('  skip everything: TextEdit is already open; close it and run again.')
  process.exit(77)
}
if (!(await mayTakeTheKeyboard({ idleFor: whenIdle, evenIfInUse }))) process.exit(77)

const helper = new Helper()
const scratch = mkdtempSync(join(tmpdir(), 'flow-helper-test-'))
let originalApp = null
const children = []

/** Polls `captureTarget` until `accept(target)` is true, then returns that target. */
async function waitForTarget(helper, accept, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const target = await helper.request('captureTarget')
    if (accept(target)) return target
    if (Date.now() > deadline) {
      if (!isOurs(target)) throw lostTo(target)
      throw new Error(`${what}: last saw ${JSON.stringify(target)}`)
    }
    await sleep(150)
  }
}

// A tiny Electron app with a text area and a password input. It stands in for every
// Chromium-based app (Chrome, VS Code, Slack), whose accessibility tree is dormant
// until something asks for it. It prints the text area's content when it changes.
const CHROMIUM_LAB = `
const { app, BrowserWindow } = require('electron')
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 520, height: 260, title: 'Whisper Flow paste lab' })
  await win.loadURL('data:text/html,' + encodeURIComponent(
    '<body style="margin:12px;font:14px system-ui">Whisper Flow paste lab<br>' +
    '<textarea id="t" autofocus style="width:95%;height:120px"></textarea><br>' +
    '<input id="p" type="password" placeholder="password"></body>'))
  app.focus({ steal: true })
  win.focus()
  let last = null
  setInterval(async () => {
    const value = await win.webContents.executeJavaScript('document.getElementById("t").value')
    if (value !== last) { last = value; console.log('LAB_VALUE ' + JSON.stringify(value)) }
  }, 120)
  process.stdin.on('data', (chunk) => {
    const id = String(chunk).includes('password') ? 'p' : 't'
    win.webContents.executeJavaScript('document.getElementById("' + id + '").focus()')
  })
  console.log('LAB_READY')
})
`

try {
  const [ready] = await helper.eventsWhen(0, (events) => events.length > 0, 'ready message')
  if (!ready.accessibilityTrusted) {
    console.log(
      '  skip everything: this terminal does not have the Accessibility permission.\n' +
        '  Grant it in System Settings → Privacy & Security → Accessibility, then run again.',
    )
    await helper.close()
    process.exit(77)
  }
  originalApp = (await helper.request('captureTarget')).bundleId ?? null

  // Every key this test presses goes to an app it opened itself, so TextEdit is opened
  // before anything is pressed.
  const clipboardBefore = clipboardText()
  const file = join(scratch, 'paste-target.txt')
  writeFileSync(file, '')
  spawnSync('open', ['-a', 'TextEdit', file])
  launchedTextEdit = true
  await check('TextEdit opens and takes the keyboard', async () => {
    await waitForFrontApp(helper, TEXTEDIT)
    // Give the document window a moment to take keyboard focus.
    await sleep(600)
  })

  console.log('Event tap:')
  await check('tap installs and the shortcut table is accepted', async () => {
    const tap = await helper.request('installTap')
    expect(tap.tapInstalled === true, 'tap was not installed')
    const configured = await helper.request('configure', { bindings: BINDINGS })
    expect(configured.bindings === BINDINGS.length, 'unexpected configure reply')
    return `protocol ${ready.protocol}`
  })

  await check('holding Fn reports push-to-talk down and up, with the hold duration', async () => {
    const cursor = helper.mark()
    postKeys(`${FN}:down,wait:400,${FN}:up`)
    const events = await helper.eventsWhen(cursor, (since) => since.length >= 2, 'Fn hold')
    expect(kinds(events).join(' ') === 'bindingDown:ptt bindingUp:ptt', kinds(events).join(' '))
    const held = events[1].t - events[0].t
    expect(held > 300 && held < 700, `hold measured as ${held.toFixed(0)} ms`)
    expect(events[1].reason === 'released', `reason ${events[1].reason}`)
    return `hold measured as ${held.toFixed(0)} ms`
  })

  await check('another key during the hold reports an interruption', async () => {
    const cursor = helper.mark()
    postKeys(`${FN}:down,wait:120,${INERT_KEY}:down,${INERT_KEY}:up,wait:120,${FN}:up`)
    const events = await helper.eventsWhen(cursor, (since) => since.length >= 3, 'interruption')
    expect(
      kinds(events).join(' ') === 'bindingDown:ptt interrupted:ptt bindingUp:ptt',
      kinds(events).join(' '),
    )
  })

  await check('an ordinary key with no shortcut held reports nothing', async () => {
    const cursor = helper.mark()
    postKeys(`${INERT_KEY}:down,${INERT_KEY}:up`)
    await sleep(300)
    expect(helper.events.length === cursor, kinds(helper.events.slice(cursor)).join(' '))
  })

  await check('Escape is reported as cancel only while armed', async () => {
    await helper.request('armEscape', { armed: true })
    const cursor = helper.mark()
    postKeys(`${ESCAPE}:down,wait:30,${ESCAPE}:up`)
    const events = await helper.eventsWhen(cursor, (since) => since.length >= 1, 'armed Escape')
    expect(kinds(events).join(' ') === 'cancel', kinds(events).join(' '))
  })

  await check('the paste-last chord is recognised', async () => {
    const cursor = helper.mark()
    postKeys(
      `${COMMAND}:down,${CONTROL}:down,${LETTER_V}:down,${LETTER_V}:up,${CONTROL}:up,${COMMAND}:up`,
    )
    const events = await helper.eventsWhen(cursor, (since) => since.length >= 2, 'paste-last chord')
    expect(
      kinds(events).join(' ') === 'bindingDown:pasteLast bindingUp:pasteLast',
      kinds(events).join(' '),
    )
  })

  console.log('Paste:')
  {
    const text = `whisper-flow paste test ${Date.now().toString(36)}`
    let textEditTarget = null

    await check('pastes into the focused TextEdit document', async () => {
      textEditTarget = await captureIn(helper, TEXTEDIT)
      expect(textEditTarget.secure === false, 'TextEdit was reported as a secure field')
      const cursor = helper.mark()
      const { outcome } = await helper.request('paste', {
        pasteId: 1,
        text,
        targetId: textEditTarget.targetId,
        restoreDelayMs: 500,
      })
      expect(outcome === 'pasted', `outcome ${outcome}`)
      await helper.eventsWhen(
        cursor,
        (since) => since.some((event) => event.type === 'pasteSettled'),
        'pasteSettled',
      )
      const value = valueIn(TEXTEDIT)
      expect(value?.includes(text), `document holds: ${JSON.stringify(value)}`)
      return `hasElement=${textEditTarget.hasElement}`
    })

    await check('restores the clipboard after the paste', async () => {
      const settled = helper.events.find((event) => event.type === 'pasteSettled')
      expect(settled?.restored === true, `pasteSettled: ${JSON.stringify(settled)}`)
      expect(clipboardText() === clipboardBefore, 'clipboard text differs from before the paste')
    })

    await check('a copy made during the paste window is kept, not overwritten', async () => {
      // This check replaces the clipboard and puts it back as plain text, so it only
      // runs when plain text is all the clipboard holds.
      requirePlainTextClipboard()

      const target = await captureIn(helper, TEXTEDIT)
      const cursor = helper.mark()
      const { outcome } = await helper.request('paste', {
        pasteId: 4,
        text: ' second paste',
        targetId: target.targetId,
        restoreDelayMs: 500,
      })
      expect(outcome === 'pasted', `outcome ${outcome}`)
      // The person copies something else before the helper would restore the clipboard.
      const newer = `copied during the paste window ${Date.now().toString(36)}`
      spawnSync('pbcopy', { input: newer })
      try {
        const events = await helper.eventsWhen(
          cursor,
          (since) => since.some((event) => event.type === 'pasteSettled'),
          'pasteSettled',
        )
        const settled = events.find((event) => event.type === 'pasteSettled')
        expect(settled.restored === false, 'the helper restored over a newer copy')
        expect(clipboardText() === newer, 'the newer copy did not survive')
      } finally {
        putClipboardBack(clipboardBefore, [newer, ' second paste'])
      }
    })

    await check('a paste the app has stopped waiting for is not carried out', async () => {
      // TextEdit is in front and the destination is right: only the time has passed.
      const saved = await captureIn(helper, TEXTEDIT)
      const before = valueIn(TEXTEDIT)
      const { outcome, detail } = await helper.request('paste', {
        pasteId: 6,
        text: 'this must never be pasted',
        targetId: saved.targetId,
        expiresAt: Date.now() - 1,
      })
      expect(outcome === 'expired', `outcome ${outcome}`)
      expect(detail === 'onArrival', `detail ${detail}`)
      await sleep(300)
      expect(valueIn(TEXTEDIT) === before, 'the document changed')
      expect(clipboardText() === clipboardBefore, 'a paste called off must not touch the clipboard')
    })

    await check('a paste asked for in time is carried out', async () => {
      const saved = await captureIn(helper, TEXTEDIT)
      const cursor = helper.mark()
      const inTime = `in time ${Date.now().toString(36)}`
      const { outcome } = await helper.request('paste', {
        pasteId: 7,
        text: inTime,
        targetId: saved.targetId,
        expiresAt: Date.now() + 4_000,
      })
      expect(outcome === 'pasted', `outcome ${outcome}`)
      await helper.eventsWhen(
        cursor,
        (since) => since.some((event) => event.type === 'pasteSettled' && event.pasteId === 7),
        'pasteSettled',
      )
      expect(valueIn(TEXTEDIT)?.includes(inTime), 'the text did not arrive')
      expect(clipboardText() === clipboardBefore, 'the clipboard was not put back')
    })

    /**
     * A clipboard whose owner takes this long to hand its content over, for as long as
     * `run` lasts. It replaces what is on the clipboard, which is put back afterwards
     * (unless someone has copied something else by then).
     */
    const withSlowClipboard = async (milliseconds, run) => {
      requirePlainTextClipboard()
      /** What this check may leave on the clipboard: `run` adds the text it pastes. */
      const texts = ['from a slow clipboard']
      const slow = spawn(helperPath, ['--slow-clipboard', String(milliseconds)], {
        env: toolEnv,
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      children.push(slow)
      try {
        await new Promise((resolve, reject) => {
          slow.stdout.once('data', resolve)
          slow.once('exit', () => reject(new Error('the slow clipboard did not start')))
        })
        return await run(texts)
      } finally {
        slow.stdin.end()
        // Its promise goes with it; until then a reader would be kept waiting.
        if (slow.exitCode === null) {
          await Promise.race([new Promise((resolve) => slow.once('exit', resolve)), sleep(1_000)])
        }
        putClipboardBack(clipboardBefore, texts)
      }
    }

    await check(
      'another app comes forward while the clipboard is slow to answer: nothing is pasted',
      async () => {
        await withSlowClipboard(1_500, async () => {
          const saved = await captureIn(helper, TEXTEDIT)
          const before = valueIn(TEXTEDIT)
          const pasting = helper.request('paste', {
            pasteId: 8,
            text: 'this must never be pasted',
            targetId: saved.targetId,
            expiresAt: Date.now() + 4_000,
          })
          // The helper is now waiting for the clipboard's owner, and cannot hear of
          // anything else. The person moves to another app meanwhile.
          await sleep(400)
          // Nothing throws while the paste is on its way: leaving now would take the
          // slow clipboard away, and the helper would get its answer early.
          const front = focusedValue()
          if (isOurs(front)) spawnSync('open', ['-a', 'Finder'])
          const { outcome, detail } = await pasting
          if (!isOurs(front)) throw lostTo(front)
          // Back to the document before anything is judged: whatever this check finds,
          // the ones after it need the document in front.
          requireOursInFront()
          spawnSync('open', ['-a', 'TextEdit'])
          await waitForFrontApp(helper, TEXTEDIT)
          await sleep(600)
          expect(outcome === 'targetChanged', `outcome ${outcome}`)
          expect(detail === 'app', `detail ${detail}`)
          expect(valueIn(TEXTEDIT) === before, 'the document changed')
        })
      },
    )

    await check(
      'a clipboard that takes longer to answer than the app waits: the paste is called off',
      async () => {
        await withSlowClipboard(2_200, async () => {
          const saved = await captureIn(helper, TEXTEDIT)
          const before = valueIn(TEXTEDIT)
          const asked = Date.now()
          const { outcome, detail } = await helper.request('paste', {
            pasteId: 9,
            text: 'this must never be pasted',
            targetId: saved.targetId,
            expiresAt: Date.now() + 1_000,
          })
          expect(outcome === 'expired', `outcome ${outcome}`)
          expect(detail === 'clipboardRead', `detail ${detail}`)
          await sleep(300)
          expect(valueIn(TEXTEDIT) === before, 'the document changed')
          return `answered after ${Date.now() - asked} ms, for a paste wanted within 1,000`
        })
      },
    )

    await check(
      'a clipboard that is slow but inside the time: the paste goes ahead, and the clipboard is put back',
      async () => {
        await withSlowClipboard(700, async (texts) => {
          const saved = await captureIn(helper, TEXTEDIT)
          const cursor = helper.mark()
          const text = `after a slow clipboard ${Date.now().toString(36)}`
          texts.push(text)
          const { outcome } = await helper.request('paste', {
            pasteId: 12,
            text,
            targetId: saved.targetId,
            expiresAt: Date.now() + 4_000,
          })
          expect(outcome === 'pasted', `outcome ${outcome}`)
          const events = await helper.eventsWhen(
            cursor,
            (since) => since.some((event) => event.type === 'pasteSettled' && event.pasteId === 12),
            'pasteSettled',
          )
          expect(valueIn(TEXTEDIT)?.includes(text), 'the text did not arrive')
          const settled = events.find((event) => event.type === 'pasteSettled')
          expect(settled.restored === true, `pasteSettled: ${JSON.stringify(settled)}`)
          expect(clipboardText() === 'from a slow clipboard', 'the slow clipboard was not put back')
        })
      },
    )

    await check('refuses to paste after focus moves to another app', async () => {
      const saved = await captureIn(helper, TEXTEDIT)
      spawnSync('open', ['-a', 'Finder'])
      await waitForFrontApp(helper, FINDER)
      const { outcome } = await helper.request('paste', {
        pasteId: 2,
        text: 'this must never be pasted',
        targetId: saved.targetId,
      })
      expect(outcome === 'targetChanged', `outcome ${outcome}`)
      expect(clipboardText() === clipboardBefore, 'a refused paste must not touch the clipboard')
    })

    await check('refuses a destination id it never issued', async () => {
      const { outcome } = await helper.request('paste', {
        pasteId: 3,
        text: 'this must never be pasted',
        targetId: 999_999,
      })
      expect(outcome === 'targetChanged', `outcome ${outcome}`)
    })
  }

  console.log('Password field:')
  await check('a native password field is recognised, and a paste into it is refused', async () => {
    const before = clipboardText()
    requireOursInFront()
    // A system dialog with a hidden-answer field; it dismisses itself after 20 s.
    const dialog = spawn(
      'osascript',
      [
        '-e',
        'activate',
        '-e',
        'display dialog "Whisper Flow test: password field" default answer "" with hidden answer giving up after 20',
      ],
      { stdio: 'ignore' },
    )
    children.push(dialog)
    try {
      // The dialog's own field, and no other: someone's real password field is not
      // something to try a paste on.
      const target = await waitForTarget(
        helper,
        (t) => t.secure === true && !t.bundleId && t.appName === DIALOG_HOST,
        'no secure field seen',
        8_000,
      )
      const { outcome } = await helper.request('paste', {
        pasteId: 10,
        text: 'this must never be pasted',
        targetId: target.targetId,
      })
      expect(outcome === 'secureField', `outcome ${outcome}`)
      expect(clipboardText() === before, 'a refused paste must not touch the clipboard')
      return `in ${target.appName ?? 'the dialog'}`
    } finally {
      dialog.kill()
    }
  })

  console.log('Chromium text area:')
  {
    const labFile = join(scratch, 'chromium-lab.cjs')
    writeFileSync(labFile, CHROMIUM_LAB)
    const electronPath = createRequire(import.meta.url)('electron')
    let lab = null
    let labOutput = ''
    const labHolds = async (text, timeoutMs = 3_000) => {
      const deadline = Date.now() + timeoutMs
      while (!labOutput.includes(text)) {
        if (Date.now() > deadline) throw new Error(`the text area never showed the pasted text`)
        await sleep(50)
      }
    }

    await check(
      'pastes into a Chromium text area three times without a false refusal',
      async () => {
        // The window takes the keyboard as it opens.
        requireOursInFront()
        lab = spawn(electronPath, [labFile], { stdio: ['pipe', 'pipe', 'ignore'] })
        children.push(lab)
        lab.stdout.on('data', (chunk) => (labOutput += chunk))
        await labHolds('LAB_READY', 15_000)
        await waitForFrontApp(helper, CHROMIUM)
        await sleep(500)
        let hasElement = null
        for (const round of [1, 2, 3]) {
          const target = await captureIn(helper, CHROMIUM)
          hasElement = target.hasElement
          // Stand in for processing time between release and paste.
          await sleep(400)
          const text = `chromium paste ${round} ${Date.now().toString(36)}`
          const { outcome } = await helper.request('paste', {
            pasteId: 20 + round,
            text,
            targetId: target.targetId,
          })
          expect(outcome === 'pasted', `round ${round}: outcome ${outcome}`)
          await labHolds(text)
          await sleep(700)
        }
        return `hasElement=${hasElement}`
      },
    )

    await check(
      'a password input in a Chromium page is recognised, and a paste is refused',
      async () => {
        if (!lab) throw new Skip('the Chromium window was not opened')
        lab.stdin.write('password\n')
        const target = await waitForTarget(
          helper,
          (t) => t.secure === true && t.bundleId === CHROMIUM,
          'no secure field seen',
          5_000,
        )
        const { outcome } = await helper.request('paste', {
          pasteId: 30,
          text: 'this must never be pasted',
          targetId: target.targetId,
        })
        expect(outcome === 'secureField', `outcome ${outcome}`)
      },
    )

    if (holdPasswordSeconds > 0) {
      // A password field in a Chromium app shows only through Secure Input, and Secure
      // Input once stopped counting after a minute. Someone can leave such a field
      // focused for longer than that.
      await check(
        `the password input is still refused after ${holdPasswordSeconds} s with the keyboard`,
        async () => {
          await sleep(holdPasswordSeconds * 1_000)
          const target = await captureIn(helper, CHROMIUM)
          expect(target.secure === true, `no longer seen as secure: ${JSON.stringify(target)}`)
          expect(target.secureReason === 'secureInput', `reason: ${target.secureReason}`)
          const { outcome, detail } = await helper.request('paste', {
            pasteId: 31,
            text: 'this must never be pasted',
            targetId: target.targetId,
          })
          expect(outcome === 'secureField', `outcome ${outcome}`)
          return `refused because of ${detail}`
        },
      )
    }

    console.log('Terminal:')
    if (isRunning('Terminal')) {
      record('paste into Terminal', 'skip', 'Terminal is already open; close it to run this part')
    } else {
      await check('pastes into a Terminal window', async () => {
        // The Chromium window is closed first, and Terminal is asked for only once
        // macOS has brought the next app forward. An app that asks for the front while
        // the one in front is going away can lose its turn: Terminal did, twice, on
        // 2026-10-04, by 35 ms.
        requireOursInFront()
        if (lab && lab.exitCode === null) {
          lab.kill()
          await Promise.race([new Promise((resolve) => lab.once('exit', resolve)), sleep(3_000)])
          await sleep(400)
        }
        // The app macOS brought forward is the one that was in front before the window:
        // Finder. If it is somebody's app instead, Terminal is not put over it.
        requireOursInFront()
        spawnSync('open', ['-a', 'Terminal'])
        launchedTerminal = true
        await waitForFrontApp(helper, TERMINAL)
        await sleep(1_200)
        const target = await captureIn(helper, TERMINAL)
        const text = `whisper-flow-terminal-test-${Date.now().toString(36)}`
        const { outcome } = await helper.request('paste', {
          pasteId: 40,
          text,
          targetId: target.targetId,
        })
        expect(outcome === 'pasted', `outcome ${outcome}`)
        await sleep(700)
        expect(valueIn(TERMINAL)?.includes(text), 'the terminal does not show the pasted text')
        return `hasElement=${target.hasElement}`
      })
    }
    lab?.kill()
  }

  console.log('Lifecycle:')
  await check('exits when stdin closes', async () => {
    const code = await helper.close()
    expect(code === 0, `exit result ${code}`)
  })
} finally {
  if (launchedTextEdit) spawnSync('pkill', ['-x', 'TextEdit'])
  if (launchedTerminal) spawnSync('pkill', ['-x', 'Terminal'])
  for (const child of children) child.kill()
  rmSync(scratch, { recursive: true, force: true })
  // Back to the app that was in front at the start. Not when another app has come to
  // the front since: whoever is using it keeps it.
  if (originalApp && !focusLost && ![TEXTEDIT, FINDER].includes(originalApp)) {
    spawnSync('open', ['-b', originalApp])
  }
  helper.child.kill()
}

const failed = results.filter((result) => result.status === 'FAIL').length
const skipped = results.filter((result) => result.status === 'skip').length
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`)
if (focusLost) {
  console.log(
    'Stopped early: an app this test did not open came to the front. Run it again when the Mac is free.',
  )
}
process.exit(failed > 0 ? 1 : focusLost ? 77 : 0)
