// Packages the app without ever leaving a half-finished bundle where someone can open it.
//
// electron-builder writes the bundle first and signs it afterwards, file by file. A copy
// opened from `dist/` in between runs unsigned, is then re-signed underneath itself, and
// macOS stops recognising it: permissions are asked for again and stop working. That
// happened on 2026-10-03. So the bundle is built and signed in a staging folder, checked
// there, and only then moved into place in one step.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const staging = join(root, 'dist', '.staging')
const staged = join(staging, 'mac-arm64')
const final = join(root, 'dist', 'mac-arm64')

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

rmSync(staging, { recursive: true, force: true })
run(join(root, 'node_modules', '.bin', 'electron-builder'), [
  '--config',
  'electron-builder.dev.yml',
  '--mac',
  'dir',
  '--arm64',
  `-c.directories.output=${staging}`,
])
run(process.execPath, [join(root, 'scripts', 'check-pack.mjs'), staged])

// The checks took a while: make sure nobody has opened the old copy in the meantime.
run(process.execPath, [join(root, 'scripts', 'check-not-running.mjs')])

mkdirSync(final, { recursive: true })
for (const name of readdirSync(staged)) {
  rmSync(join(final, name), { recursive: true, force: true })
  renameSync(join(staged, name), join(final, name))
}
rmSync(staging, { recursive: true, force: true })
const app = readdirSync(final).find((name) => name.endsWith('.app'))
console.log(`In place: ${join(final, app ?? '')}`)
if (!app || !existsSync(join(final, app))) process.exit(1)
