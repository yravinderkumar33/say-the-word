import { PRODUCT_NAME } from '@shared/product'

/** What "Copy Diagnostics" describes. None of it is what was said, or where. */
export interface DiagnosticFacts {
  appVersion: string
  build: string
  macOS: string
  chip: string
  memoryGb: number
  electron: string
  helper: string
  accessibility: string
  microphone: string
  speech: string
  mode: string
  cleanup: string
  dictationKey: string
  history: string
  savingDictations: boolean
  paused: boolean
}

/**
 * The setup, as text to paste into a report of a problem: versions, permissions and
 * settings. It leaves out what was said, the dictionary, the names of microphones and
 * the log (which names the apps that were dictated into): the log can be looked at and
 * sent by hand.
 */
export function diagnostics(facts: DiagnosticFacts): string {
  const lines: Array<[string, string]> = [
    [PRODUCT_NAME, `${facts.appVersion} (${facts.build})`],
    ['macOS', facts.macOS],
    ['Mac', `${facts.chip}, ${facts.memoryGb} GB`],
    ['Electron', facts.electron],
    ['Shortcut helper', facts.helper],
    ['Accessibility', facts.accessibility],
    ['Microphone', facts.microphone],
    ['Speech', facts.speech],
    ['Mode', facts.mode],
    ['Cleanup', facts.cleanup || 'not in use'],
    ['Dictation key', facts.dictationKey],
    ['History', facts.history],
    ['Saving every dictation', facts.savingDictations ? 'on' : 'off'],
    ['Paused', facts.paused ? 'yes' : 'no'],
  ]
  return (
    lines.map(([name, value]) => `${name}: ${value}`).join('\n') +
    '\n\nThe log is not included. It never contains what was said, but it names the apps ' +
    'that were dictated into: Show Log opens it.\n'
  )
}
