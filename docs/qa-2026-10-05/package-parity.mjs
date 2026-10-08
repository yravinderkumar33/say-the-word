/* global process, console */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const asar = createRequire(import.meta.url)('@electron/asar')
const archive = join(root, 'dist/mac-arm64/Whisper Flow Dev.app/Contents/Resources/app.asar')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const walk = (dir) =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const file = join(dir, name)
    return statSync(join(root, file)).isDirectory() ? walk(file) : [file]
  })
const files = walk('out').filter((file) => !file.includes('.in-use') && !file.endsWith('.map'))
let failures = 0
for (const file of files) {
  let matches = false
  try {
    matches = hash(readFileSync(join(root, file))) === hash(asar.extractFile(archive, file))
  } catch {
    /* reported below */
  }
  if (!matches) failures += 1
  console.log(JSON.stringify({ file, matches }))
}
console.log(JSON.stringify({ matched: files.length - failures, total: files.length }))
process.exitCode = failures ? 1 : 0
