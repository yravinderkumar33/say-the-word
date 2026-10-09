import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  debuggingSwitchesToRefuse,
  isDevelopmentManifest,
  switchesToIgnore,
} from '@shared/test-switches'
import { LogFile } from './log-file'

// Imported before everything else in `index.ts`, for its effect: in a release build the
// test switches are taken out of the environment before any module reads them, and
// before the helper and the speech worker inherit it. See `@shared/test-switches`.

function isDevBuild(): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'),
    ) as unknown
    return isDevelopmentManifest(manifest)
  } catch {
    return false
  }
}

const build = { packaged: app.isPackaged, devBuild: isDevBuild() }

for (const name of switchesToIgnore(Object.keys(process.env), build)) {
  delete process.env[name]
}

// A release build started with a debugging switch does not start at all. This runs
// before the app is ready, so `app.exit` ends the process before Chromium opens the port.
const refused = debuggingSwitchesToRefuse((name) => app.commandLine.hasSwitch(name), build)
if (refused.length > 0) {
  const line = `[app] started with ${refused.map((name) => `--${name}`).join(' ')}, which would open it to a debugger: not started`
  try {
    console.error(line)
    // Opened from Finder, the app has no terminal: the line goes where the log goes.
    new LogFile(join(app.getPath('logs'), 'main.log')).write(`error: ${line}`)
  } finally {
    app.exit(1)
  }
}
