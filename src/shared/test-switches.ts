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

/** The new marker and older development packages both require an explicit boolean. */
export function isDevelopmentManifest(manifest: unknown): boolean {
  if (typeof manifest !== 'object' || manifest === null) return false
  const fields = manifest as Record<string, unknown>
  return fields['sayTheWordDevBuild'] === true || fields['whisperFlowDevBuild'] === true
}

// These names are a tooling interface, retained across the public product rename.
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

/**
 * Chromium's and Node's switches that open the app to a debugger. Whoever attaches one
 * can drive the app's pages, and so record through its Microphone permission and read
 * the history: what the test switches are kept out for. Node's act before any of the
 * app's code runs (`--inspect-brk` stops at its first line), so against those it is the
 * build itself that must be closed (Electron's `nodeCliInspect` fuse).
 */
const DEBUGGING_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-debugging-address',
  'inspect',
  'inspect-brk',
  'inspect-brk-node',
  'inspect-port',
]

/** The debugging switches this build was started with, and refuses to run under. */
export function debuggingSwitchesToRefuse(
  given: (name: string) => boolean,
  build: BuildKind,
): string[] {
  if (!build.packaged || build.devBuild) return []
  return DEBUGGING_SWITCHES.filter((name) => given(name))
}
