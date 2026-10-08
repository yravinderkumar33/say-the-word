import type { CleanupFacts, ModelRefusal, TryResult } from '@shared/ipc'
import { bytes, seconds } from './format'

/**
 * What the Cleanup page says about Ollama, its models and a sentence being tried.
 * Kept apart from the window so that the wording can be tested.
 */

/** The pop-up's value for "Rules only (no model)": a model's name is never empty. */
export const RULES_ONLY = ''
export const RULES_ONLY_LABEL = 'Rules only (no model)'

/** The example every page that explains Cleaned mode uses. */
export const EXAMPLE = {
  spoken: 'um so let’s meet thursday no wait friday at 3 pm and uh bring the the q3 report',
  verbatim: 'Um, so let’s meet Thursday, no wait, Friday at 3 PM and uh bring the the Q3 report.',
  cleaned: 'So let’s meet Friday at 3 PM and bring the Q3 report.',
}

/** What Cleaned may do to a text, and what it never does. */
export const MAY_CHANGE =
  'Hesitations such as um and uh · false starts and self-corrections · repeated words · punctuation and capitals'
export const NEVER_CHANGES =
  'Numbers · names · email addresses · links · a “not”. It never rephrases and never adds a word.'

export type OllamaAction = 'get' | 'start'
export type OllamaIcon = 'tick' | 'stopped' | 'absent'

/** Said under the row about Ollama once "Get Ollama" has opened its page. */
export const OLLAMA_OPENED =
  'Opened ollama.com in your browser. When Ollama is installed and open, this row changes by itself.'

/**
 * The row about Ollama as the Cleanup page and the first run both show it: while it is
 * looked for, while it is being started, and what was found, with the one thing to do.
 */
export function ollamaRow(
  facts: CleanupFacts | null,
  starting: boolean,
  product: string,
): { text: string; icon: OllamaIcon | null; action: OllamaAction | null } {
  if (!facts) return { text: 'Looking for Ollama…', icon: null, action: null }
  const line = ollamaLine(facts, product)
  return {
    text: starting ? 'Starting Ollama…' : line.text,
    icon: line.ok ? 'tick' : facts.ollama === 'notRunning' ? 'stopped' : 'absent',
    // Started already: it is not offered again while it starts.
    action: starting && line.action === 'start' ? null : line.action,
  }
}

/** The row about Ollama: one sentence, and the one thing to do when there is one. */
export function ollamaLine(
  facts: CleanupFacts,
  product: string,
): { text: string; ok: boolean; action: OllamaAction | null } {
  if (facts.ollama === 'running') {
    return {
      text: facts.local
        ? `Running on this Mac, at ${facts.host}`
        : `Running at ${facts.host}, which is not this Mac`,
      ok: true,
      action: null,
    }
  }
  if (!facts.local) {
    return { text: `Nothing answers at ${facts.host}`, ok: false, action: null }
  }
  if (facts.ollama === 'notRunning') {
    return { text: 'Installed on this Mac, and not running.', ok: false, action: 'start' }
  }
  return {
    text: `Not installed. A separate free app that runs the model; ${product} does not include it.`,
    ok: false,
    action: 'get',
  }
}

/** The choices of the model pop-up: the models that run on this Mac, then the rules alone. */
export function modelOptions(facts: CleanupFacts): Array<{ value: string; label: string }> {
  const options = facts.models.map((model) => ({ value: model.name, label: model.name }))
  // The one chosen is shown even when it is not among them: it is what the setting says.
  if (facts.chosen && !options.some((option) => option.value === facts.chosen)) {
    options.unshift({ value: facts.chosen, label: facts.chosen })
  }
  return [...options, { value: RULES_ONLY, label: RULES_ONLY_LABEL }]
}

/** What is said beside the model pop-up. */
export function modelNote(facts: CleanupFacts): string {
  if (!facts.chosen) return 'Hesitations and repeated words are removed by fixed rules.'
  if (facts.ollama !== 'running') return 'Models appear here when Ollama is running'
  if (facts.refusal) return 'Refused · rules only in use'
  const size = facts.models.find((model) => model.name === facts.chosen)?.bytes ?? null
  return [
    ...(facts.typicalMs !== null
      ? [`Usually ${seconds(facts.typicalMs)} from release to text`]
      : []),
    ...(size !== null ? [bytes(size)] : []),
  ].join(' · ')
}

const REFUSALS: Record<ModelRefusal, { title: string; why: (model: string) => string }> = {
  remote: {
    title: 'The chosen model does not run on this Mac',
    why: (model) =>
      `Ollama would run ${model} on another machine. What you say is never sent there.`,
  },
  blocked: {
    title: 'The chosen model answered from another machine',
    why: (model) => `${model} is not asked again until the app is restarted.`,
  },
  notInstalled: {
    title: 'The chosen model is not installed',
    why: (model) => `${model} is not among Ollama’s models on this Mac.`,
  },
  notATextModel: {
    title: 'The chosen model cannot write text',
    why: (model) => `${model} is not a model that writes text.`,
  },
  serverNotLocal: {
    title: 'The Ollama address is not on this Mac',
    why: () => 'Only an address on this Mac is used. It is set in Settings, under Advanced.',
  },
  redirected: {
    title: 'The Ollama address sends requests elsewhere',
    why: () => 'A request is never sent on to an address it was not meant for.',
  },
}

/** A refused model, in the app's own words. */
export function refusalWords(facts: CleanupFacts): { title: string; body: string } | null {
  if (!facts.refusal || !facts.chosen) return null
  const words = REFUSALS[facts.refusal]
  return {
    title: words.title,
    body: `${words.why(facts.chosen)} Cleaned uses rules only until then.`,
  }
}

export interface TryColumn {
  label: string
  /** The model that wrote it, named beside the label: the name is cut short before the label is. */
  model: string | null
  time: string
  text: string
  /** Drawn more quietly: a hint, or a text that a dictation would not have used. */
  dim: boolean
  /** Said under a text that came, and would not have been used. */
  problem: string | null
  /** Made from the sentence, which may have been dictated: a picture leaves it blank. */
  said: boolean
}

/** The three results of "Try it", side by side. Before anything is typed, what each column is for. */
export function tryColumns(
  result: TryResult | null,
  facts: CleanupFacts | null,
  busy: boolean,
): TryColumn[] {
  const model = facts?.ollama === 'running' && !facts.refusal ? facts.chosen : null
  if (!result) {
    return [
      {
        label: 'Verbatim',
        model: null,
        time: '',
        text: 'Type a sentence above to compare.',
        dim: true,
        problem: null,
        said: false,
      },
      {
        label: 'Rules only',
        model: null,
        time: '',
        text: '',
        dim: true,
        problem: null,
        said: false,
      },
      {
        label: 'Cleaned',
        model,
        time: '',
        text: model
          ? ''
          : facts?.chosen
            ? 'Needs Ollama. Rules only is used until then.'
            : 'No model is chosen. Rules only is used.',
        dim: true,
        problem: null,
        said: false,
      },
    ]
  }
  const column = (label: string, part: { text: string; ms: number }): TryColumn => ({
    label,
    model: null,
    time: seconds(part.ms),
    text: part.text,
    dim: false,
    problem: null,
    said: true,
  })
  const cleaned = result.cleaned
  return [
    column('Verbatim', result.verbatim),
    column('Rules only', result.rules),
    cleaned
      ? {
          label: 'Cleaned',
          model: cleaned.model,
          time: seconds(cleaned.ms),
          text: cleaned.text,
          dim: !cleaned.used,
          problem: cleaned.used ? null : cleaned.why,
          said: true,
        }
      : {
          label: 'Cleaned',
          model,
          time: '',
          text: busy
            ? 'Asking the model…'
            : facts?.chosen
              ? 'Needs Ollama. Rules only is used until then.'
              : 'No model is chosen. Rules only is used.',
          dim: true,
          problem: null,
          said: false,
        },
  ]
}
