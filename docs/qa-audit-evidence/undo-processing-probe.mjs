// Reuse the app harness, with exactly one extra scenario in a temporary copy.
// No production/test source is changed. Quiet mode uses a fake microphone,
// disables the key tap, and counts pastes without touching the clipboard/focus.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const original = join(root, 'scripts', 'test-app.mjs')
const source = readFileSync(original, 'utf8')
const rootDeclaration = "const root = join(dirname(fileURLToPath(import.meta.url)), '..')"
const electronLookup = "createRequire(import.meta.url)('electron')"
const scenarioStart = "scenario('cancel while processing: nothing pasted', async () => {"
const followingScenario = "scenario(\n  'the shortcut pressed during processing"
const start = source.indexOf(scenarioStart)
const end = source.indexOf(followingScenario, start)
assert(start >= 0 && end > start, 'The original harness changed; review this probe before use')
assert(source.includes(rootDeclaration), 'The harness root declaration changed')
assert(source.includes(electronLookup), 'The harness Electron lookup changed')
assert(
  process.argv.slice(2).every((arg) => arg === '--packaged'),
  'Only --packaged is supported; the probe always runs one quiet scenario',
)

const scenarioName = 'audit: Undo after post-STT cancellation'
const scenario = `scenario('${scenarioName}', async () => {
  const before = await status()
  send('text-delay 2500')
  try {
    play(SHORT)
    const session = await press()
    await sleep(SHORT.ms + 400)
    send('release')
    await waitUntil(
      'STT to finish while processing is held',
      (now) => now.state === 'processing' && now.openMicrophones === 0 && now.holdsRecording === false,
      2_000,
    )
    send('escape')
    await waitIdle()
    await sleep(400)
    const cancelled = await status()
    console.log('AUDIT before Undo', JSON.stringify({
      holdsRecording: cancelled.holdsRecording,
      pill: cancelled.pill,
      hasText: entryOf(cancelled, session)?.hasText,
    }))
    send('click-pill Undo')
    await sleep(700)
    const undone = await status()
    console.log('AUDIT after Undo', JSON.stringify({
      state: undone.state,
      outcome: entryOf(undone, session)?.outcome,
      hasText: entryOf(undone, session)?.hasText,
      pastesAdded: undone.pastes.length - before.pastes.length,
    }))
    expect(
      undone.pastes.length === before.pastes.length + 1,
      'Undo offered during post-STT processing cannot recover the already-released audio',
    )
    await expectMicrophoneReleased()
  } finally {
    send('text-delay 0')
  }
})

`

const amended = (source.slice(0, start) + scenario + source.slice(end))
  .replace(rootDeclaration, `const root = ${JSON.stringify(root)}`)
  .replace(electronLookup, "createRequire(join(root, 'package.json'))('electron')")
const scratch = mkdtempSync(join(tmpdir(), 'flow-qa-undo-probe-'))
try {
  const script = join(scratch, 'test-app.mjs')
  writeFileSync(script, amended)
  const result = spawnSync(
    process.execPath,
    [script, '--only', scenarioName, ...process.argv.slice(2)],
    { cwd: root, stdio: 'inherit', env: process.env },
  )
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
