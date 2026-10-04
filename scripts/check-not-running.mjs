// Refuses to go on while the packaged app is running from `dist/`.
//
// `npm run pack` replaces and re-signs that bundle. Doing so underneath a running copy
// changes the code the copy is executing: it can crash, and it will not pick up the new
// build either. Tests started by the scripts themselves are children of this process
// tree and are not what this looks for; a copy opened from Finder or with `open` is.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = join(root, 'dist', 'mac-arm64')

// The app's own executable only; its helper processes live under Contents/Frameworks.
const executable = new RegExp(
  `^\\d+ ${bundle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^/]+\\.app/Contents/MacOS/`,
)
const processes = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout
const running = processes
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => executable.test(line))

if (running.length > 0) {
  console.error(
    'The packaged app is running from dist/, which this command is about to replace:\n' +
      running.map((line) => `  ${line.slice(0, 140)}`).join('\n') +
      '\nQuit it first (menu-bar icon → Quit), then run this again.',
  )
  process.exit(1)
}
