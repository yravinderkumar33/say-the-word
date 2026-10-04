import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_MODEL, type ModelSpec } from './model-catalog'

/**
 * Where speech models live. One folder is shared by every build of the app (release,
 * local development build, scripts), so a 670 MB model is downloaded only once.
 *
 * It never sits inside the app bundle: the bundle is signed, and models are data.
 * `WHISPER_FLOW_MODELS_DIR` overrides the location, mainly for tests.
 */
export function modelsRoot(): string {
  const override = process.env['WHISPER_FLOW_MODELS_DIR']
  if (override) return override
  return join(homedir(), 'Library', 'Application Support', 'Whisper Flow', 'models')
}

/**
 * The model the app uses. `WHISPER_FLOW_MODEL_SOURCE` makes its files come from another
 * address (`<address>/<file name>`), so that a test can serve them from this machine and
 * slow or cut the connection when it likes. Sizes and checksums stay those of the
 * catalog: whatever the address serves is checked against them like any download.
 */
export function modelToUse(spec: ModelSpec = DEFAULT_MODEL): ModelSpec {
  const source = process.env['WHISPER_FLOW_MODEL_SOURCE']
  if (!source) return spec
  const base = source.replace(/\/+$/, '')
  return { ...spec, files: spec.files.map((file) => ({ ...file, url: `${base}/${file.name}` })) }
}
