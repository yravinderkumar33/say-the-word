// Writes the licence notices of everything bundled into the app to
// resources/notices/THIRD-PARTY-NOTICES.txt, which the package carries in its Resources.
//
// The licences of the bundled packages ask for their notice to travel with every copy.
// Which packages are bundled is worked out the way tests/unit/third-party.test.ts does:
// what the source imports, the runtime dependencies, and everything those bring with
// them. Electron's own licences (LICENSE.electron.txt, LICENSES.chromium.html) are put
// into the bundle by electron-builder, so Electron is left out here.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = (name) =>
  JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))

const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const imported = new Set(Object.keys(own.dependencies ?? {}))
const read = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) read(path)
    else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      const text = readFileSync(path, 'utf8')
      for (const [, name] of text.matchAll(/(?:from|import)\s+['"]([^'"./][^'"]*)['"]/g)) {
        if (!name || name.startsWith('node:') || name.startsWith('@shared')) continue
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

const bundled = new Set()
const visit = (name) => {
  if (bundled.has(name) || name === 'electron') return
  if (!existsSync(join(root, 'node_modules', name, 'package.json'))) return
  bundled.add(name)
  const installed = manifest(name)
  for (const dependency of Object.keys({
    ...installed.dependencies,
    ...installed.optionalDependencies,
  }))
    visit(dependency)
}
for (const name of imported) visit(name)

const sections = []
let apache = false
for (const name of [...bundled].sort()) {
  const dir = join(root, 'node_modules', name)
  const { version, license } = manifest(name)
  const files = readdirSync(dir).filter((file) => /^(licen[cs]e|notice|copying)/i.test(file))
  if (files.length > 0) {
    const texts = files.map((file) => readFileSync(join(dir, file), 'utf8').trim())
    sections.push(`${name} ${version} (${license})\n\n${texts.join('\n\n')}`)
  } else if (license === 'Apache-2.0') {
    // sherpa-onnx's npm packages ship no licence file; the licence's text is appended once.
    const { author, homepage } = manifest(name)
    sections.push(
      `${name} ${version} (Apache-2.0)\n\nCopyright ${author ?? 'its authors'}. ${homepage ?? ''}\n` +
        'Licensed under the Apache License, Version 2.0, whose text is at the end of this file.',
    )
    apache = true
  } else {
    console.error(`${name} ships no licence file: add its notice by hand before releasing`)
    process.exit(1)
  }
}

// Not npm packages: the model is downloaded by the user, and the others come inside
// sherpa-onnx's prebuilt library.
const outside = `Parakeet TDT 0.6b v3 (CC-BY-4.0), by NVIDIA. The speech model is not part of
this package; the app downloads it when you ask. https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
Licence: https://creativecommons.org/licenses/by/4.0/

ONNX Runtime (MIT), Copyright (c) Microsoft Corporation, inside sherpa-onnx's library.
https://github.com/microsoft/onnxruntime/blob/main/LICENSE

Silero VAD (MIT), Copyright (c) 2020-present Silero Team.
https://github.com/snakers4/silero-vad/blob/master/LICENSE

Electron and Chromium: see LICENSE.electron.txt and LICENSES.chromium.html beside this file.`

const rule = '\n\n' + '-'.repeat(78) + '\n\n'
// The plain Apache-2.0 text, as TypeScript (a build tool here) ships it.
if (apache)
  sections.push(
    readFileSync(join(root, 'node_modules', 'typescript', 'LICENSE.txt'), 'utf8').trim(),
  )
const out = join(root, 'resources', 'notices')
mkdirSync(out, { recursive: true })
writeFileSync(
  join(out, 'THIRD-PARTY-NOTICES.txt'),
  `Say the Word includes the following third-party software.${rule}${outside}${rule}${sections.join(rule)}\n`,
)
console.log(`Notices for ${bundled.size} packages written to resources/notices/`)
