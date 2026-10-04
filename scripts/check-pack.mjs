// Verifies the packaged app: signature, entitlements, bundled helper, then runs the
// packaged app's own `--smoke` check. Run automatically by `npm run pack`, on the staged
// bundle before it is moved into place.
//
//   node scripts/check-pack.mjs            checks dist/mac-arm64
//   node scripts/check-pack.mjs <folder>   checks the bundle in that folder
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = process.argv[2] ?? join(root, 'dist', 'mac-arm64')
const failures = []
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' })

const appName = existsSync(distDir)
  ? readdirSync(distDir).find((name) => name.endsWith('.app'))
  : null
if (!appName) {
  console.error(`No .app found in ${distDir}`)
  process.exit(1)
}
const appPath = join(distDir, appName)
const executable = join(appPath, 'Contents', 'MacOS', appName.replace(/\.app$/, ''))
const helper = join(appPath, 'Contents', 'Resources', 'bin', 'flow-helper')
console.log(`Packaged app: ${appPath}`)

// 1. Signature is valid for the whole bundle.
const verify = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
if (verify.status === 0) console.log('  ok  codesign --verify --deep --strict')
else failures.push(`codesign verify failed:\n${verify.stderr}`)

// 2. Signed with a real identity (not ad hoc), with the hardened runtime.
const info = run('codesign', ['--display', '--verbose=4', appPath]).stderr
const authority = /Authority=(.+)/.exec(info)?.[1]
if (authority) console.log(`  ok  signed by a certificate (${authority.split(':')[0]})`)
else failures.push('app is not signed with a certificate (ad hoc or unsigned)')
if (/flags=.*runtime/.test(info)) console.log('  ok  hardened runtime enabled')
else failures.push('hardened runtime flag missing')

// 3. Entitlements include microphone access.
const entitlements = run('codesign', ['--display', '--entitlements', '-', '--xml', appPath]).stdout
if (entitlements.includes('com.apple.security.device.audio-input')) {
  console.log('  ok  microphone entitlement present')
} else failures.push('com.apple.security.device.audio-input entitlement missing')

// 4. The helper is bundled, signed, and runs.
if (!existsSync(helper)) {
  failures.push(`helper missing at ${helper}`)
} else {
  const helperVerify = run('codesign', ['--verify', '--strict', helper])
  if (helperVerify.status === 0) console.log('  ok  bundled helper is signed')
  else failures.push(`helper signature invalid:\n${helperVerify.stderr}`)
  try {
    const version = execFileSync(helper, ['--version'], { encoding: 'utf8' }).trim()
    console.log(`  ok  bundled helper runs (${version})`)
  } catch (error) {
    failures.push(`helper did not run: ${error.message}`)
  }
}

// 5. The speech library's native code sits outside the archive, and is signed.
const unpacked = join(appPath, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')
const natives = existsSync(unpacked)
  ? readdirSync(unpacked)
      .filter((name) => name.startsWith('sherpa-onnx-darwin-'))
      .flatMap((name) =>
        readdirSync(join(unpacked, name))
          .filter((file) => /\.(node|dylib)$/.test(file))
          .map((file) => join(unpacked, name, file)),
      )
  : []
if (natives.length === 0) {
  failures.push(`speech library binaries missing under ${unpacked}`)
} else {
  const unsigned = natives.filter((file) => run('codesign', ['--verify', '--strict', file]).status)
  if (unsigned.length === 0)
    console.log(`  ok  speech library unpacked and signed (${natives.length} files)`)
  else failures.push(`speech library files not signed: ${unsigned.join(', ')}`)
}

// 6. The packaged app passes its own smoke check. With the speech model on disk this
// loads the native speech library inside the signed app and transcribes a recording.
const smokeAudio = join(root, 'tests', 'fixtures', 'audio', 'short.daniel.wav')
const smoke = spawnSync(executable, ['--smoke'], {
  encoding: 'utf8',
  timeout: 120_000,
  env: {
    ...process.env,
    ...(existsSync(smokeAudio) ? { WHISPER_FLOW_SMOKE_AUDIO: smokeAudio } : {}),
  },
})
const resultLine = smoke.stdout.split('\n').find((line) => line.startsWith('SMOKE_RESULT '))
if (!resultLine) {
  failures.push(
    `packaged smoke produced no result (exit ${smoke.status})\n${smoke.stderr.slice(-800)}`,
  )
} else {
  const report = JSON.parse(resultLine.slice('SMOKE_RESULT '.length))
  for (const item of report.checks) {
    const mark = item.skipped ? 'skip' : item.ok ? 'ok ' : 'FAIL'
    console.log(`  ${mark} smoke: ${item.name} — ${item.detail}`)
  }
  if (!report.packaged) failures.push('smoke ran, but the app did not report itself as packaged')
  if (!report.ok) failures.push('packaged smoke check failed')
}

if (failures.length > 0) {
  console.error('\nPackage checks failed:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('Package checks passed.')
