// Writes electron-builder.env (git-ignored) with the local code-signing identity.
//
// Local builds are signed with a real certificate so that macOS keeps the app's
// Accessibility and Microphone grants across rebuilds. An ad-hoc signature changes
// with every build, and each change makes macOS forget the grants.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const listing = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
  encoding: 'utf8',
})
const identities = [...listing.matchAll(/"([^"]+)"/g)].map((match) => match[1])
const preferred =
  identities.find((name) => name.startsWith('Developer ID Application:')) ??
  identities.find((name) => name.startsWith('Apple Development:')) ??
  identities[0]

if (!preferred) {
  console.error(
    'No code-signing identity found in the keychain.\n' +
      'Create one in Xcode (Settings → Accounts → Manage Certificates → Apple Development), then run this again.',
  )
  process.exit(1)
}

writeFileSync(join(root, 'electron-builder.env'), `CSC_NAME=${preferred}\n`)
const kind = preferred.split(':')[0]
console.log(`electron-builder.env written (identity type: ${kind}).`)
