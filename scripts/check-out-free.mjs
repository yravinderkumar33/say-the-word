// Run before a build: refuses while an app under test is running from `out/`, and takes
// the build output for the command line this is a step of (see lib/build-output.mjs).
import { take } from './lib/build-output.mjs'

// The shell that runs the rest of the command line holds it until that line has ended.
const why = take(process.env['npm_lifecycle_event'] ?? 'a build', process.ppid)
if (why) {
  console.error(why)
  process.exit(1)
}
