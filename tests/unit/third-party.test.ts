import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { THIRD_PARTY, thirdPartySummary } from '@shared/third-party'

const root = join(import.meta.dirname, '..', '..')
const manifest = (path: string): { license?: string; dependencies?: Record<string, string> } =>
  JSON.parse(readFileSync(path, 'utf8')) as {
    license?: string
    dependencies?: Record<string, string>
  }

describe('whose work the app ships', () => {
  it('names each package under the licence the installed package gives itself', () => {
    for (const item of THIRD_PARTY) {
      if (!item.package) continue
      const installed = manifest(join(root, 'node_modules', item.package, 'package.json'))
      expect(installed.license, item.name).toBe(item.licence)
    }
  })

  it('lists everything the app needs at run time', () => {
    const needed = Object.keys(manifest(join(root, 'package.json')).dependencies ?? {})
    const listed = new Set(THIRD_PARTY.map((item) => item.package))

    for (const name of needed) expect(listed.has(name), name).toBe(true)
  })

  it('is built only from packages whose licences ask for nothing more than their notice', () => {
    // What the source imports ends up inside the app, whichever list of package.json
    // names it, and so does what those packages bring with them. The About page names the
    // parts a reader would look for, not every helper; what this test guards is that no
    // package under a licence with conditions beyond a notice (GPL, AGPL and the like)
    // can be bundled unnoticed.
    const imported = new Set<string>()
    const read = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) read(path)
        else if (/\.(ts|tsx|css)$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8')
          for (const [, name] of text.matchAll(/(?:from|import)\s+['"]([^'"./][^'"]*)['"]/g)) {
            if (!name || name.startsWith('node:') || name.startsWith('@shared')) continue
            // `react-dom/client` is react-dom; `@scope/name/part` is `@scope/name`.
            imported.add(
              name
                .split('/')
                .slice(0, name.startsWith('@') ? 2 : 1)
                .join('/'),
            )
          }
        }
      }
    }
    read(join(root, 'src'))
    expect([...imported].sort()).toEqual(expect.arrayContaining(['electron', 'react', 'zod']))

    const permissive = /^(MIT|ISC|0BSD|BSD-2-Clause|BSD-3-Clause|Apache-2\.0)$/
    const acceptable = (licence: string | undefined): boolean =>
      licence !== undefined &&
      licence
        .replace(/^\(|\)$/g, '')
        .split(' OR ')
        .some((one) => permissive.test(one.trim()))
    const seen = new Set<string>()
    const check = (name: string): void => {
      if (seen.has(name)) return
      seen.add(name)
      const installed = manifest(join(root, 'node_modules', name, 'package.json'))
      expect(acceptable(installed.license), `${name}: ${installed.license}`).toBe(true)
      // Electron's own dependencies fetch it at install time; none of them is in the app.
      if (name === 'electron') return
      for (const dependency of Object.keys(installed.dependencies ?? {})) check(dependency)
    }
    for (const name of imported) check(name)
    expect(seen.has('scheduler')).toBe(true)
  })

  it('names the speech model and its terms, which ask to be shown', () => {
    expect(THIRD_PARTY[0]).toMatchObject({ name: 'Parakeet TDT 0.6b v3', licence: 'CC-BY-4.0' })
    expect(thirdPartySummary()).toBe(
      `Parakeet v3 (CC-BY-4.0), Electron, React and ${THIRD_PARTY.length - 3} others`,
    )
  })
})
