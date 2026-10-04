// Integration test for the Swift helper against the real operating system:
// the key event tap (driven by synthetic key events) and a real paste into TextEdit.
//
// It needs the Accessibility permission for whatever runs it (your terminal), and for
// about ten seconds it takes keyboard focus: it opens TextEdit, pastes a test line,
// switches to Finder, then returns to the app you were in. Do not type while it runs.
//
//   npm run test:helper:integration
//   npm run test:helper:integration -- --when-idle 30   start once nobody has touched the Mac for 30 s
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForIdle } from './lib/wait-idle.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const helperPath = join(root, 'resources', 'bin', 'flow-helper')
const toolEnv = { ...process.env, FLOW_HELPER_TEST_TOOLS: '1' }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const idleOption = process.argv.indexOf('--when-idle')
const whenIdle = idleOption === -1 ? 0 : Number(process.argv[idleOption + 1] ?? 0)

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
async function check(name, run) {
  try {
    record(name, 'ok', (await run()) ?? '')
  } catch (error) {
    record(name, error instanceof Skip ? 'skip' : 'FAIL', error.message)
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

function postKeys(script) {
  const result = spawnSync(helperPath, ['--post-keys', script], { env: toolEnv, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`post-keys failed: ${result.stderr.trim()}`)
}
function focusedValue() {
  const result = spawnSync(helperPath, ['--focused-value'], { env: toolEnv, encoding: 'utf8' })
  return JSON.parse(result.stdout || '{"found":false}')
}
const clipboardText = () => spawnSync('pbpaste', { encoding: 'utf8' }).stdout
const isRunning = (name) => spawnSync('pgrep', ['-x', name]).status === 0
const kinds = (events) => events.map((event) => `${event.type}${event.id ? `:${event.id}` : ''}`)

async function waitForFrontApp(helper, bundleId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const target = await helper.request('captureTarget')
    if (target.bundleId === bundleId) return target
    if (Date.now() > deadline) throw new Error(`${bundleId} never became frontmost`)
    await sleep(150)
  }
}

if (whenIdle > 0 && !(await waitForIdle(whenIdle, 15 * 60_000))) {
  console.log('  skip everything: the Mac was in use the whole time.')
  process.exit(77)
}

const helper = new Helper()
const scratch = mkdtempSync(join(tmpdir(), 'flow-helper-test-'))
let launchedTextEdit = false
let launchedTerminal = false
let originalApp = null
const children = []

/** Polls `captureTarget` until `accept(target)` is true, then returns that target. */
async function waitForTarget(helper, accept, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const target = await helper.request('captureTarget')
    if (accept(target)) return target
    if (Date.now() > deadline) throw new Error(`${what}: last saw ${JSON.stringify(target)}`)
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
  if (isRunning('TextEdit')) {
    record('paste into TextEdit', 'skip', 'TextEdit is already open; close it to run this part')
  } else {
    const clipboardBefore = clipboardText()
    const file = join(scratch, 'paste-target.txt')
    writeFileSync(file, '')
    spawnSync('open', ['-a', 'TextEdit', file])
    launchedTextEdit = true
    const text = `whisper-flow paste test ${Date.now().toString(36)}`
    let textEditTarget = null

    await check('pastes into the focused TextEdit document', async () => {
      textEditTarget = await waitForFrontApp(helper, 'com.apple.TextEdit')
      // Give the document window a moment to take keyboard focus.
      await sleep(600)
      textEditTarget = await helper.request('captureTarget')
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
      const focused = focusedValue()
      expect(focused.value?.includes(text), `document holds: ${JSON.stringify(focused.value)}`)
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
      const info = spawnSync('osascript', ['-e', 'clipboard info'], { encoding: 'utf8' }).stdout
      const kinds = info.split(/,\s*/).filter((part) => !/^\d+$/.test(part.trim()) && part.trim())
      const plain = ['«class utf8»', '«class ut16»', 'string', 'Unicode text']
      if (!kinds.every((kind) => plain.includes(kind.trim()))) {
        throw new Skip('the clipboard holds more than plain text; left untouched')
      }

      const target = await helper.request('captureTarget')
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
        spawnSync('pbcopy', { input: clipboardBefore })
      }
    })

    await check('refuses to paste after focus moves to another app', async () => {
      const saved = await helper.request('captureTarget')
      spawnSync('open', ['-a', 'Finder'])
      await waitForFrontApp(helper, 'com.apple.finder')
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
      const target = await waitForTarget(
        helper,
        (t) => t.secure === true,
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
    const lab = spawn(electronPath, [labFile], { stdio: ['pipe', 'pipe', 'ignore'] })
    children.push(lab)
    let labOutput = ''
    lab.stdout.on('data', (chunk) => (labOutput += chunk))
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
        await labHolds('LAB_READY', 15_000)
        await waitForFrontApp(helper, 'com.github.Electron')
        await sleep(500)
        let hasElement = null
        for (const round of [1, 2, 3]) {
          const target = await helper.request('captureTarget')
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
        lab.stdin.write('password\n')
        const target = await waitForTarget(
          helper,
          (t) => t.secure === true,
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
    lab.kill()
  }

  console.log('Terminal:')
  if (isRunning('Terminal')) {
    record('paste into Terminal', 'skip', 'Terminal is already open; close it to run this part')
  } else {
    await check('pastes into a Terminal window', async () => {
      spawnSync('open', ['-a', 'Terminal'])
      launchedTerminal = true
      await waitForFrontApp(helper, 'com.apple.Terminal')
      await sleep(1_200)
      const target = await helper.request('captureTarget')
      const text = `whisper-flow-terminal-test-${Date.now().toString(36)}`
      const { outcome } = await helper.request('paste', {
        pasteId: 40,
        text,
        targetId: target.targetId,
      })
      expect(outcome === 'pasted', `outcome ${outcome}`)
      await sleep(700)
      const focused = focusedValue()
      expect(focused.value?.includes(text), 'the terminal does not show the pasted text')
      return `hasElement=${target.hasElement}`
    })
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
  if (originalApp && !['com.apple.TextEdit', 'com.apple.finder'].includes(originalApp)) {
    spawnSync('open', ['-b', originalApp])
  }
  helper.child.kill()
}

const failed = results.filter((result) => result.status === 'FAIL').length
const skipped = results.filter((result) => result.status === 'skip').length
console.log(`\n${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`)
process.exit(failed > 0 ? 1 : 0)
