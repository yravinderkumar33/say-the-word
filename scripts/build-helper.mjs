// Builds the Swift helper and copies the binary to resources/bin/, where the app
// (in development) and electron-builder (when packaging) pick it up.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs'
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
copyFileSync(join(binDir, binary), target)
chmodSync(target, 0o755)
console.log(`flow-helper: built → ${target}`)
