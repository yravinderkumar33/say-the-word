import { join } from 'node:path'
import { LEGACY_DATA_NAME } from '@shared/product'

/**
 * Electron would derive this folder from the new product name. Every earlier build
 * (source, development package and release) used the same name in package.json, so
 * keep that folder rather than creating an empty profile after the public rename.
 * A test's explicit folder still wins, keeping tests away from the user's data.
 */
export function userDataPath(appData: string, override?: string): string {
  return override || join(appData, LEGACY_DATA_NAME)
}
