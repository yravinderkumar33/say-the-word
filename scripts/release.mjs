// Builds the download: the release identity (electron-builder.yml, where every test
// switch is ignored), signed with a Developer ID, notarized by Apple and stapled, as a
// DMG in dist/release/. Publishing it is a separate step, printed at the end.
//
// Needs, once per Mac: a "Developer ID Application" certificate in the keychain, and
// notarization credentials stored with `xcrun notarytool store-credentials say-the-word`
// (another profile name goes in SAY_THE_WORD_NOTARY_PROFILE).
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pRetry from 'p-retry'
import { take } from './lib/build-output.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const profile = process.env['SAY_THE_WORD_NOTARY_PROFILE'] || 'say-the-word'
const dmgName = 'Say-the-Word-arm64.dmg'

const run = (command, args, env = process.env) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env })
  if (result.status !== 0) {
    console.error(`Failed: ${command} ${args.join(' ')}`)
    process.exit(result.status ?? 1)
  }
}
const quiet = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8' })

// 1. What only the owner can provide comes first, before anything is built.
const identities = quiet('security', ['find-identity', '-v', '-p', 'codesigning']).stdout
const identity = /"(Developer ID Application: [^"]+)"/.exec(identities)?.[1]
if (!identity) {
  console.error(
    'No "Developer ID Application" certificate in the keychain. Create one in Xcode ›\n' +
      'Settings › Accounts › Manage Certificates › + › Developer ID Application.',
  )
  process.exit(1)
}
if (quiet('xcrun', ['notarytool', 'history', '--keychain-profile', profile]).status !== 0) {
  console.error(
    `No working notarization profile "${profile}". Store one with:\n` +
      `  xcrun notarytool store-credentials ${profile} --apple-id <Apple ID> --team-id <Team ID>\n` +
      'using an app-specific password from account.apple.com.',
  )
  process.exit(1)
}
console.log(`Signing as ${identity}; notarizing with profile "${profile}".`)

// 2. Build, sign and notarize the app; electron-builder staples it and makes the DMG.
const inUse = take('release')
if (inUse) {
  console.error(inUse)
  process.exit(1)
}
const staging = join(root, 'dist', '.release-staging')
// Apple's timestamp server, asked once for each of the bundle's files, now and then fails
// to answer one ("A timestamp was expected but was not found"): the build is tried again.
await pRetry(
  () => {
    rmSync(staging, { recursive: true, force: true })
    const result = spawnSync(
      join(root, 'node_modules', '.bin', 'electron-builder'),
      [
        '--config',
        'electron-builder.yml',
        '--mac',
        'dmg',
        '--arm64',
        `-c.directories.output=${staging}`,
        '-c.mac.notarize=true',
        `-c.dmg.artifactName=${dmgName}`,
        // Publishing is its own step, after the checks below.
        '--publish',
        'never',
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: {
          ...process.env,
          // electron-builder.env names the development identity; this build uses the other.
          CSC_NAME: identity.replace(/^Developer ID Application: /, ''),
          APPLE_KEYCHAIN_PROFILE: profile,
        },
      },
    )
    if (result.status !== 0) throw new Error(`electron-builder exited with ${result.status}`)
  },
  {
    retries: 1,
    onFailedAttempt: ({ error }) => console.error(`${error.message}; trying once more`),
  },
)
const appDir = join(staging, 'mac-arm64')
const app = join(appDir, readdirSync(appDir).find((name) => name.endsWith('.app')) ?? '')
const dmg = join(staging, dmgName)

// 3. The same checks as every package, then what a downloaded copy meets: Gatekeeper.
run(process.execPath, [join(root, 'scripts', 'check-pack.mjs'), appDir])
run('codesign', ['--sign', identity, '--timestamp', dmg])
run('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', profile, '--wait'])
run('xcrun', ['stapler', 'staple', dmg])
run('xcrun', ['stapler', 'validate', app])
run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app])
run('spctl', [
  '--assess',
  '--type',
  'open',
  '--context',
  'context:primary-signature',
  '--verbose=2',
  dmg,
])

// 4. Into place, with what publishing needs.
const final = join(root, 'dist', 'release')
mkdirSync(final, { recursive: true })
rmSync(join(final, dmgName), { force: true })
renameSync(dmg, join(final, dmgName))
rmSync(staging, { recursive: true, force: true })
const sha = createHash('sha256')
  .update(readFileSync(join(final, dmgName)))
  .digest('hex')
console.log(`\nReady: dist/release/${dmgName}\nSHA-256: ${sha}`)
console.log(
  `Publish with: gh release create v${version} dist/release/${dmgName} --title "Say the Word ${version}"`,
)
