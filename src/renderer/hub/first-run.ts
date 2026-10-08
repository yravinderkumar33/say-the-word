import type { AppStatus, CleanupFacts, DictationMode, PillState, Practice } from '@shared/ipc'
import { dictationKeyLabel, type DictationKey } from '@shared/keycodes'
import { RULES_ONLY, refusalWords } from './cleanup-view'
import { bytes } from './format'
import { modelStep } from './model-step'

/**
 * The first run: one step to a screen, each with one thing to do. The rules of the
 * flow are here, apart from the window, so that they can be tested: which steps there
 * are, when a step lets the user go on, and what the bar about the download says.
 */

export type StepId =
  'welcome' | 'microphone' | 'accessibility' | 'keys' | 'try' | 'cleaned' | 'ready'

const STEP_LABELS: Record<StepId, string> = {
  welcome: 'Welcome',
  microphone: 'Microphone',
  accessibility: 'Accessibility',
  keys: 'Keys',
  try: 'Try it',
  cleaned: 'Cleaned mode',
  ready: 'Ready',
}

/**
 * The steps, in order. "Keys" is there only when another app listens to the same key;
 * once it has been shown it stays, so that it does not vanish under the user when the
 * conflict is settled.
 */
export function stepOrder(keysNeeded: boolean): StepId[] {
  return [
    'welcome',
    'microphone',
    'accessibility',
    ...(keysNeeded ? (['keys'] as const) : []),
    'try',
    'cleaned',
    'ready',
  ]
}

/** Where a step stands for the list at the side: done, the one in hand, or still to come. */
export function stepStates(
  order: readonly StepId[],
  current: StepId,
): Array<{ id: StepId; label: string; state: 'done' | 'current' | 'todo'; optional: boolean }> {
  const at = order.indexOf(current)
  return order.map((id, index) => ({
    id,
    label: STEP_LABELS[id],
    state: index < at ? 'done' : index === at ? 'current' : 'todo',
    optional: id === 'cleaned',
  }))
}

/** The exercises of "Try it", ticked off as each way of dictating ends in a paste. */
export function exercisesDone(now: Practice, atStart: Practice): [boolean, boolean, boolean] {
  return [now.hold > atStart.hold, now.handsFree > atStart.handsFree, now.undo > atStart.undo]
}

/** The words of each exercise, with the keys in them as keycaps. */
export function exercises(key: DictationKey): Array<Array<string | { key: string }>> {
  const cap = { key: dictationKeyLabel(key) }
  return [
    ['Hold', cap, 'and say a sentence'],
    key === 'fn'
      ? ['Press', cap, 'twice for hands-free, speak, then press', cap, 'to stop']
      : [
          'Hold',
          cap,
          'and press',
          { key: 'Space' },
          'for hands-free, speak, then press',
          cap,
          'to stop',
        ],
    ['While speaking, press', { key: 'esc' }, 'to cancel, then click Undo on the pill'],
  ]
}

/** What the pill is saying, as the small legend beside the practice box lists it. */
export function legend(key: string): string[] {
  return [
    'Resting: ready',
    'Starting: too early to speak',
    'Listening: speak now',
    `Hands-free: press ${key} to stop`,
    'Processing: the text is on its way',
    'Message: what happened, and what can be done',
  ]
}

/** Which line of the legend the pill is at. */
export function legendIndex(pill: PillState): number {
  switch (pill.kind) {
    case 'resting':
      return 0
    case 'starting':
      return 1
    case 'listening':
      return pill.handsFree ? 3 : 2
    case 'processing':
      return 4
    case 'recovery':
      return 5
  }
}

/**
 * The line of the legend a screen reader is told as the pill changes. Nothing is said
 * while the microphone may be live, where a voice would be recorded with the dictation,
 * nor at rest, which is not news.
 */
export function legendSpoken(pill: PillState, key: string): string {
  if (pill.kind !== 'processing' && pill.kind !== 'recovery') return ''
  return legend(key)[legendIndex(pill)] ?? ''
}

/** The gestures, as the last step sums them up. */
export function gestureSummary(key: DictationKey): Array<{ caps: string[]; what: string }> {
  const cap = dictationKeyLabel(key)
  return [
    { caps: [cap], what: 'Hold to dictate, let go to paste' },
    key === 'fn'
      ? { caps: [cap, cap], what: `Press twice for hands-free; press ${cap} again to stop` }
      : { caps: [cap, 'Space'], what: `Lock on for hands-free; press ${cap} again to stop` },
    { caps: ['esc'], what: 'Cancel' },
    { caps: ['⌘', '⌃', 'V'], what: 'Paste the last dictation again' },
    { caps: ['⌘', '⌃', 'C'], what: 'Copy the last dictation' },
  ]
}

export type DownloadBar =
  /** Nothing to say: the download has not been asked for, or the model was there all along. */
  | { kind: 'hidden' }
  | { kind: 'needed'; size: string }
  | { kind: 'running'; progress: number; got: string; size: string }
  | { kind: 'checking' }
  | { kind: 'stopped' }
  | { kind: 'damaged' }
  | { kind: 'done'; size: string }

/**
 * What the bar at the foot of the window says about the speech model. `seenMissing`:
 * the model was not there at some point during this run, so its arrival is news.
 */
export function downloadBar(speech: AppStatus['speech'], seenMissing: boolean): DownloadBar {
  const size = bytes(speech.modelBytes)
  const model = modelStep(speech)
  if (model.action === 'cancel') {
    const progress = speech.downloadProgress ?? 0
    return { kind: 'running', progress, got: bytes(progress * speech.modelBytes), size }
  }
  if (model.action === 'tryAgain') return { kind: 'stopped' }
  if (model.wouldNotStart) return { kind: 'damaged' }
  if (model.action === 'download') return { kind: 'needed', size }
  if (!model.done) return seenMissing ? { kind: 'checking' } : { kind: 'hidden' }
  return seenMissing ? { kind: 'done', size } : { kind: 'hidden' }
}

/**
 * The bar's sentence: what it says, and what a screen reader is told when it changes.
 * The figures of a download are drawn beside it and are not part of it: they change at
 * every look, and would be read out each time.
 */
export function barLine(bar: DownloadBar): string {
  switch (bar.kind) {
    case 'hidden':
      return ''
    case 'running':
      return 'Downloading the speech model'
    case 'checking':
      return 'Checking the model files…'
    case 'needed':
      return 'The speech model is not downloaded.'
    case 'stopped':
      return 'The download stopped. What was downloaded is kept.'
    case 'damaged':
      return 'The speech model could not be started.'
    case 'done':
      return `The speech model is ready. ${bar.size}, stored on this Mac.`
  }
}

/** True when the speech model is in place and dictation can be practised. */
export function canPractise(speech: AppStatus['speech']): boolean {
  return modelStep(speech).done
}

/** The mode the setup ended in, as the last step says it. */
export function modeSummary(status: Pick<AppStatus, 'mode' | 'cleanup'>): string {
  if (status.mode === 'verbatim') return 'Verbatim'
  return status.cleanup.includes('rules only') ? 'Cleaned (rules only)' : 'Cleaned'
}

// --- Cleaned mode ----------------------------------------------------------------------

/**
 * The Cleaned step's way past it. On a first run it keeps Verbatim. Shown again from
 * Settings, it leaves the mode as it is, and says which that is.
 */
export function cleanedSkip(
  firstRun: AppStatus['firstRun'],
  mode: DictationMode,
): { label: string; mode: DictationMode | null } {
  if (firstRun !== 'again') return { label: 'Skip and keep Verbatim', mode: 'verbatim' }
  return { label: `Skip and keep ${mode === 'cleaned' ? 'Cleaned' : 'Verbatim'}`, mode: null }
}

/** A model the Cleaned step offers: its name, what is said under it, and its size. */
export interface CleanedRow {
  name: string
  note: string
  size: string
}

/**
 * The models the Cleaned step offers: those Ollama lists, and the one chosen, which is
 * what the setting says even when Ollama does not list it (it is not running, say).
 */
export function cleanedRows(facts: CleanupFacts | null): CleanedRow[] {
  if (!facts) return []
  const where = facts.local ? 'Runs on this Mac' : `Runs at ${facts.host}`
  const rows = facts.models.map((model) => ({
    name: model.name,
    note: where,
    size: model.bytes === null ? '' : bytes(model.bytes),
  }))
  const { chosen } = facts
  if (chosen && !rows.some((row) => row.name === chosen)) {
    const refusal = refusalWords(facts)
    rows.unshift({
      name: chosen,
      note:
        facts.ollama !== 'running'
          ? 'Needs Ollama. Rules only is used until then.'
          : refusal
            ? `${refusal.title}.`
            : where,
      size: '',
    })
  }
  return rows
}

/**
 * The pick the Cleaned step shows: the user's own while it is on offer, or else what the
 * setting says. Null while Ollama is still being looked for and nothing has been picked.
 */
export function cleanedPick(picked: string | null, facts: CleanupFacts | null): string | null {
  if (picked === RULES_ONLY || cleanedRows(facts).some((row) => row.name === picked)) return picked
  return facts ? (facts.chosen ?? RULES_ONLY) : null
}

/**
 * What "Use Cleaned" changes besides the mode: the model picked, or null for the rules
 * alone. Nothing picked leaves the model as the setting has it, whether or not Ollama
 * could be asked just then.
 */
export function cleanedModelChange(picked: string | null): { model: string | null } | null {
  return picked === null ? null : { model: picked === RULES_ONLY ? null : picked }
}
