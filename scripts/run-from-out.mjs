// Runs a command that uses the build in out/, holding the build output for as long as the
// command runs (see lib/build-output.mjs). `electron . --smoke` runs the app from there,
// and `electron-vite dev` builds into it again at every change: a build started meanwhile
// would take the files from under either.
//
//   node scripts/run-from-out.mjs <name> <command> [arguments…]
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { take } from './lib/build-output.mjs'

const [what, command, ...args] = process.argv.slice(2)
const inUse = take(what)
if (inUse) {
  console.error(inUse)
  process.exit(1)
}
const child = spawn(command, args, { stdio: 'inherit' })
// A signal meant for the command reaches it, and this waits for the command to end.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  console.error(`${command}: ${error.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(code ?? 128 + constants.signals[signal]))
