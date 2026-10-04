/**
 * The switches the automated tests use: a recording in place of the microphone, a
 * control line on standard input, a folder of their own for settings and for saved
 * dictations, the dev server's address. All of them are read from the environment.
 *
 * A release build must ignore every one. Whoever can start the app can set its
 * environment, and with these switches could have it record through its own Microphone
 * permission and write the audio wherever they chose. They are honoured only when the
 * app runs from the source tree, or in the build made for development
 * (`electron-builder.dev.yml` marks that one).
 */
export interface BuildKind {
  /** True when the app runs from a packaged bundle. */
  packaged: boolean
  /** True for the development build: packaged, but made for testing. */
  devBuild: boolean
}

const PREFIXES = ['WHISPER_FLOW_', 'FLOW_HELPER_']
const NAMES = new Set(['ELECTRON_RENDERER_URL'])

export function isTestSwitch(name: string): boolean {
  return NAMES.has(name) || PREFIXES.some((prefix) => name.startsWith(prefix))
}

/** The environment variables this build must not act on. */
export function switchesToIgnore(names: string[], build: BuildKind): string[] {
  if (!build.packaged || build.devBuild) return []
  return names.filter(isTestSwitch)
}
