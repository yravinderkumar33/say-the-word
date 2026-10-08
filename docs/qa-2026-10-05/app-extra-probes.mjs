/* global process, console */
// Runs extra synthetic QA scenarios in the repository's existing isolated harness.
// Never edits app code, listens to keys, takes focus, or uses the real clipboard.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const generated = join(here, '.generated-app-probes.mjs')
let harness = readFileSync(join(root, 'scripts/test-app.mjs'), 'utf8')
harness = harness.replace(
  "const root = join(dirname(fileURLToPath(import.meta.url)), '..')",
  `const root = ${JSON.stringify(root)}`,
)
harness = harness.replace(
  "'./lib/build-output.mjs'",
  JSON.stringify(pathToFileURL(join(root, 'scripts/lib/build-output.mjs')).href),
)
harness = harness.replace(
  'const results = []',
  readFileSync(join(here, 'app-extra-scenarios.txt'), 'utf8') + '\nconst results = []',
)
writeFileSync(generated, harness)
const child = spawn(process.execPath, [generated, '--only', 'QA5:', ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code) => {
  rmSync(generated, { force: true })
  process.exitCode = code ?? 1
})
child.on('error', (error) => {
  rmSync(generated, { force: true })
  console.error(error.message)
  process.exitCode = 1
})
