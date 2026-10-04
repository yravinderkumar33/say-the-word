// Asserts that `electron-vite build` produced every piece the app needs.
// Run automatically at the end of `npm run build`.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = (...parts) => join(root, 'out', ...parts)
const failures = []

function expectFile(label, path) {
  if (existsSync(path)) console.log(`  ok  ${label}`)
  else failures.push(`${label}: missing ${path}`)
}

function expectMatch(label, dir, test) {
  const found = existsSync(dir) ? readdirSync(dir).filter(test) : []
  if (found.length > 0) console.log(`  ok  ${label} (${found.join(', ')})`)
  else failures.push(`${label}: nothing matching in ${dir}`)
  return found
}

console.log('Build assertions:')
expectFile('main entry', out('main', 'index.js'))
expectMatch('speech worker chunk', out('main'), (name) => /^stt-worker.*\.js$/.test(name))
expectFile('overlay preload', out('preload', 'overlay.js'))
expectFile('hub preload', out('preload', 'hub.js'))
expectFile('overlay page', out('renderer', 'overlay.html'))
expectFile('hub page', out('renderer', 'hub.html'))
expectFile('helper binary', join(root, 'resources', 'bin', 'flow-helper'))

// The worklet must be emitted as transpiled JavaScript, not inlined or shipped as TypeScript.
const assets = out('renderer', 'assets')
const worklets = expectMatch('capture worklet asset', assets, (name) =>
  /^pcm\.worklet.*\.js$/.test(name),
)
for (const name of worklets) {
  const source = readFileSync(join(assets, name), 'utf8')
  if (source.includes('registerProcessor(')) console.log('  ok  worklet registers its processor')
  else failures.push(`worklet ${name} does not contain registerProcessor(`)
}

// Sandboxed preloads cannot load other files, so each must be self-contained.
for (const name of ['overlay.js', 'hub.js']) {
  const path = out('preload', name)
  if (!existsSync(path)) continue
  const requires = [...readFileSync(path, 'utf8').matchAll(/require\(["']([^"']+)["']\)/g)].map(
    (match) => match[1],
  )
  const foreign = requires.filter((id) => id !== 'electron')
  if (foreign.length === 0) console.log(`  ok  preload ${name} is self-contained`)
  else failures.push(`preload ${name} requires ${foreign.join(', ')}`)
}

if (failures.length > 0) {
  console.error('\nBuild assertions failed:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('Build assertions passed.')
