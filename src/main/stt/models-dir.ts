import { homedir } from 'node:os'
import { join } from 'node:path'

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
