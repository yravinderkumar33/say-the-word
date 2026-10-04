import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { switchesToIgnore } from '@shared/test-switches'

// Imported before everything else in `index.ts`, for its effect: in a release build the
// test switches are taken out of the environment before any module reads them, and
// before the helper and the speech worker inherit it. See `@shared/test-switches`.

function isDevBuild(): boolean {
  try {
    const manifest = JSON.parse(
      readFileSync(join(app.getAppPath(), 'package.json'), 'utf8'),
    ) as unknown
    return (
      typeof manifest === 'object' &&
      manifest !== null &&
      (manifest as Record<string, unknown>)['whisperFlowDevBuild'] === true
    )
  } catch {
    return false
  }
}

for (const name of switchesToIgnore(Object.keys(process.env), {
  packaged: app.isPackaged,
  devBuild: isDevBuild(),
})) {
  delete process.env[name]
}
