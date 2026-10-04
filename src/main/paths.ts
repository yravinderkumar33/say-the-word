import { app } from 'electron'
import { join } from 'node:path'

/** A file shipped beside the app: `Contents/Resources/…` when packaged, `resources/…` in development. */
export function resourcePath(...parts: string[]): string {
  return app.isPackaged
    ? join(process.resourcesPath, ...parts)
    : join(app.getAppPath(), 'resources', ...parts)
}

export function helperBinaryPath(): string {
  return resourcePath('bin', 'flow-helper')
}

/** Directory holding the built renderer pages (`out/renderer`). */
export function rendererDir(): string {
  return join(__dirname, '../renderer')
}

export function preloadPath(name: 'overlay' | 'hub'): string {
  return join(__dirname, `../preload/${name}.js`)
}
