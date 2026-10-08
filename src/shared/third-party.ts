/**
 * Whose work the app ships, and on what terms. The About page lists it.
 *
 * `package` names the npm package where there is one, so that a test can check each
 * licence against what the installed package says of itself; an entry without one is a
 * model or a library that comes inside another package.
 */
export interface ThirdParty {
  name: string
  licence: string
  /** What it is, in a few words. */
  what: string
  package?: string
}

export const THIRD_PARTY: readonly ThirdParty[] = [
  { name: 'Parakeet TDT 0.6b v3', licence: 'CC-BY-4.0', what: 'The speech model, by NVIDIA' },
  { name: 'Silero VAD', licence: 'MIT', what: 'Finds speech in the recording' },
  {
    name: 'sherpa-onnx',
    licence: 'Apache-2.0',
    what: 'Runs the speech model',
    package: 'sherpa-onnx-node',
  },
  { name: 'ONNX Runtime', licence: 'MIT', what: 'Inside sherpa-onnx, by Microsoft' },
  { name: 'Electron', licence: 'MIT', what: 'The app’s frame', package: 'electron' },
  { name: 'Chromium', licence: 'BSD-3-Clause and others', what: 'Inside Electron' },
  { name: 'Node.js', licence: 'MIT and others', what: 'Inside Electron' },
  { name: 'React', licence: 'MIT', what: 'Draws the windows', package: 'react' },
  { name: 'React DOM', licence: 'MIT', what: 'Draws the windows', package: 'react-dom' },
  { name: 'Scheduler', licence: 'MIT', what: 'Part of React', package: 'scheduler' },
  { name: 'Zod', licence: 'MIT', what: 'Checks what the app reads', package: 'zod' },
  { name: 'Tailwind CSS', licence: 'MIT', what: 'The windows’ styles', package: 'tailwindcss' },
]

/** The row's second line on the About page: the three named first, then how many others. */
export function thirdPartySummary(): string {
  return `Parakeet v3 (CC-BY-4.0), Electron, React and ${THIRD_PARTY.length - 3} others`
}
