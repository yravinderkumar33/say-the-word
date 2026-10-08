// Builds the Swift helper and copies the binary to resources/bin/, where the app
// (in development) and electron-builder (when packaging) pick it up.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagePath = join(root, 'native', 'flow-helper')
const binary = 'flow-helper'

if (process.platform !== 'darwin') {
  console.log('flow-helper: skipped (the helper is macOS-only)')
  process.exit(0)
}

const swift = (args, options = {}) =>
  execFileSync('swift', ['build', '-c', 'release', '--package-path', packagePath, ...args], options)

swift([], { stdio: 'inherit' })
const binDir = swift(['--show-bin-path'], { encoding: 'utf8' }).trim()

const outDir = join(root, 'resources', 'bin')
mkdirSync(outDir, { recursive: true })
const target = join(outDir, binary)
// Put in place as a new file, never written over the old one. A helper that is running
// from the old file keeps it; written over, macOS would go on judging the file by the
// signature it remembers, and kill every helper started from it afterwards
// ("Code Signature Invalid"). That happened on 2026-10-04, with a test's app still running.
const fresh = `${target}.new`
copyFileSync(join(binDir, binary), fresh)
chmodSync(fresh, 0o755)
renameSync(fresh, target)
console.log(`flow-helper: built → ${target}`)
