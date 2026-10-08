import { useEffect, useRef, useState } from 'react'
import type { AppStatus, CleanupFacts, DictationMode, TryResult } from '@shared/ipc'
import { PRODUCT_NAME } from '@shared/product'
import { whenSettled } from './answers'
import { Button, ICONS, Icon, Notice, PageTitle, PopUp, ProblemIcon, radioKeys } from './components'
import {
  EXAMPLE,
  MAY_CHANGE,
  NEVER_CHANGES,
  OLLAMA_OPENED,
  RULES_ONLY,
  modelNote,
  modelOptions,
  ollamaRow,
  refusalWords,
  tryColumns,
  type OllamaAction,
  type OllamaIcon,
} from './cleanup-view'
import { useFacts } from './use-facts'

/** Ollama can be started or stopped at any time, and nothing announces it. */
const LOOK_EVERY_MS = 2_500
/** A sentence is tried once the typing has paused for this long. */
const TRY_AFTER_MS = 500
/** How long "Starting Ollama…" is shown before the row says again what it finds. */
const STARTING_FOR_MS = 12_000

/** Ollama as this page and the first run show it, and the one thing to do about it. */
export interface Ollama {
  facts: CleanupFacts | null
  refresh: () => void
  /** The row's sentence, its icon, and what its one button does. */
  text: string
  icon: OllamaIcon | null
  action: OllamaAction | null
  /** "Get Ollama" has opened its page, and Ollama is still not installed. */
  opened: boolean
  start: () => void
  get: () => void
}

/**
 * Ollama, looked for now and again: it can be started or stopped at any time, and
 * nothing announces it. `onChanged` is told when a start has been asked for.
 */
export function useOllama(onChanged?: () => void): Ollama {
  const { facts, refresh } = useFacts<CleanupFacts>(
    () => window.flowHub.getCleanupFacts(),
    LOOK_EVERY_MS,
  )
  const [starting, setStarting] = useState(false)
  const [opened, setOpened] = useState(false)
  // "Starting" lasts until Ollama answers, or for so long at most. A second press gives it
  // the whole time again, and a page that goes leaves no timer behind.
  const startingFor = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(startingFor.current), [])
  const running = facts?.ollama === 'running'
  useEffect(() => {
    if (!running) return
    clearTimeout(startingFor.current)
    setStarting(false)
  }, [running])

  const row = ollamaRow(facts, starting, PRODUCT_NAME)
  const done = (): void => {
    onChanged?.()
    refresh()
  }
  return {
    facts,
    refresh,
    ...row,
    opened: opened && row.action === 'get',
    start: () => {
      clearTimeout(startingFor.current)
      setStarting(true)
      startingFor.current = setTimeout(() => setStarting(false), STARTING_FOR_MS)
      whenSettled(window.flowHub.startOllama(), done)
    },
    get: () => {
      setOpened(true)
      void window.flowHub.openLink('ollama')
    },
  }
}

/**
 * Cleanup: what the two modes do to the same sentence, whether Ollama is there to run
 * the model, which model, and a place to try a sentence of one's own.
 */
export function Cleanup({ status, onChanged }: { status: AppStatus; onChanged: () => void }) {
  const ollama = useOllama(onChanged)
  const { facts, refresh } = ollama
  const done = (): void => {
    onChanged()
    refresh()
  }
  const setMode = (mode: DictationMode): void => whenSettled(window.flowHub.setMode(mode), done)

  const refusal = facts ? refusalWords(facts) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-8 pt-10 pb-4 compact:px-6 compact:pt-6">
      <PageTitle>Cleanup</PageTitle>

      {/* The mode in use is told by a keyline and by words, not by a colour. */}
      <div
        role="radiogroup"
        aria-label="Mode"
        className="grid grid-cols-2 gap-3"
        onKeyDown={radioKeys}
      >
        <ModeCard
          mode="verbatim"
          name="Verbatim"
          text={EXAMPLE.verbatim}
          chosen={status.mode === 'verbatim'}
          onChoose={setMode}
        />
        <ModeCard
          mode="cleaned"
          name="Cleaned"
          text={EXAMPLE.cleaned}
          chosen={status.mode === 'cleaned'}
          onChoose={setMode}
        />
      </div>

      <div className="flex flex-col border-t border-line">
        <div className="grid min-h-[46px] grid-cols-[96px_minmax(0,1fr)_auto] items-center gap-3 border-b border-line">
          <span className="text-ink-2">Ollama</span>
          <span className="flex items-center gap-2" data-ollama={facts?.ollama}>
            {ollama.icon && (
              <Icon
                d={ICONS[ollama.icon]}
                size={14}
                strokeWidth={ollama.icon === 'tick' ? 1.7 : 1.4}
                className={ollama.icon === 'tick' ? '' : 'text-ink-2'}
              />
            )}
            <span>{ollama.text}</span>
          </span>
          {ollama.action === 'get' && <Button onClick={ollama.get}>Get Ollama</Button>}
          {ollama.action === 'start' && <Button onClick={ollama.start}>Start Ollama</Button>}
        </div>
        {ollama.opened && (
          <p className="border-b border-line py-2 text-caption text-ink-2">{OLLAMA_OPENED}</p>
        )}
        <div className="grid min-h-[46px] grid-cols-[96px_minmax(0,1fr)] items-center gap-3 border-b border-line">
          <span className="text-ink-2">Model</span>
          <div className="flex items-center gap-3">
            {facts && (
              <PopUp
                label="Model"
                value={facts.chosen ?? RULES_ONLY}
                options={modelOptions(facts)}
                onChange={(name) =>
                  whenSettled(
                    window.flowHub.chooseCleanupModel(name === RULES_ONLY ? null : name),
                    done,
                  )
                }
              />
            )}
            <span className="text-caption text-ink-2">{facts ? modelNote(facts) : ''}</span>
          </div>
        </div>
      </div>

      {facts && refusal && (
        <Notice
          name="model-refused"
          title={refusal.title}
          actions={
            facts.alternative && (
              <Button
                prominent
                onClick={() =>
                  whenSettled(window.flowHub.chooseCleanupModel(facts.alternative), done)
                }
              >
                Choose {facts.alternative}
              </Button>
            )
          }
        >
          {refusal.body}
        </Notice>
      )}

      <div className="grid grid-cols-2 gap-6">
        <div className="flex flex-col gap-1.5">
          <h2 className="text-heading">Cleaned may change</h2>
          <p className="leading-[1.6] text-ink-2">{MAY_CHANGE}</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <h2 className="text-heading">It never changes</h2>
          <p className="leading-[1.6] text-ink-2">{NEVER_CHANGES}</p>
        </div>
      </div>

      <TryIt facts={facts} />
    </div>
  )
}

function ModeCard(props: {
  mode: DictationMode
  name: string
  text: string
  chosen: boolean
  onChoose: (mode: DictationMode) => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.chosen}
      // The card holds an example sentence as well as its name: this is the name alone.
      data-name={props.name}
      onClick={() => props.onChoose(props.mode)}
      tabIndex={props.chosen ? 0 : -1}
      className={`flex flex-col gap-1.5 rounded-card px-3.5 py-3 text-left ${props.chosen ? 'shadow-chosen' : 'shadow-outline'}`}
    >
      <span className="flex items-center gap-1.5 font-semibold">
        {props.name}
        {props.chosen && <span className="text-caption font-normal text-ink-2">· your mode</span>}
      </span>
      <span className="text-pretty">{props.text}</span>
    </button>
  )
}

/**
 * A sentence of one's own, three ways. It is typed or dictated here and goes to the
 * model on this Mac, exactly as a dictation's text would; it is kept nowhere.
 */
export function TryIt({ facts }: { facts: CleanupFacts | null }) {
  const [typed, setTyped] = useState('')
  const [result, setResult] = useState<TryResult | null>(null)
  const [busy, setBusy] = useState(false)
  /** Goes up when a comparison is to be made again for the same sentence. */
  const [again, setAgain] = useState(0)
  /** Counts the sentences tried, so that an answer overtaken by a later one is dropped. */
  const tries = useRef(0)

  // What the person chose: a change of it starts the comparison again at once, even
  // half-way. What Ollama says of itself (running, the digest) comes and goes, now and
  // then for a moment; a comparison is never cut off for that, and is made again after.
  const chosen = JSON.stringify([facts?.host, facts?.chosen])
  const identity =
    facts?.identity ?? JSON.stringify([facts?.host, facts?.chosen, facts?.refusal, facts?.ollama])
  useEffect(() => {
    setResult(null)
    const sentence = typed.trim()
    const mine = ++tries.current
    if (!sentence) {
      setBusy(false)
      return
    }
    const timer = setTimeout(() => {
      setBusy(true)
      window.flowHub.tryCleanup(sentence).then(
        (next) => {
          if (mine !== tries.current) return
          setResult(next)
          setBusy(false)
        },
        () => {
          if (mine === tries.current) setBusy(false)
        },
      )
    }, TRY_AFTER_MS)
    return () => {
      clearTimeout(timer)
      tries.current++
    }
  }, [typed, chosen, again])

  // A comparison made under facts that are no longer so (the model has come or gone, its
  // digest changed) is made again, once, when it is over.
  const outdated =
    result !== null && !busy && Boolean(result.identity) && result.identity !== identity
  useEffect(() => {
    if (outdated) setAgain((count) => count + 1)
  }, [outdated])

  return (
    <section aria-label="Try it" className="flex flex-col gap-2.5 rounded-card bg-card p-3.5">
      <h2 className="text-heading">Try it</h2>
      <span className="field flex h-7 items-center rounded-control bg-field px-[9px] shadow-field">
        {/* It may have been dictated, and so may the texts below: a picture leaves them blank. */}
        <input
          type="text"
          aria-label="A sentence to try"
          placeholder="Type or dictate a sentence"
          value={typed}
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
          className="min-w-0 flex-1 bg-transparent outline-none"
          data-said
        />
      </span>
      <div className="grid grid-cols-3 gap-2.5">
        {tryColumns(typed.trim() ? result : null, facts, busy).map((column) => (
          <div
            key={column.label}
            data-try={column.label.split(' ')[0]}
            data-model={column.model ?? undefined}
            className="flex min-h-[72px] flex-col gap-1.5 rounded-[8px] bg-bg px-3 py-2.5 shadow-outline"
          >
            <div className="flex justify-between gap-1.5 text-caption">
              <span className="min-w-0 truncate" title={column.model ?? undefined}>
                <span className="font-semibold">{column.label}</span>
                {column.model && (
                  <span className="tracking-tight text-ink-2"> · {column.model}</span>
                )}
              </span>
              <span className="whitespace-nowrap text-ink-2 tabular-nums">{column.time}</span>
            </div>
            <span
              className={`text-pretty ${column.dim ? 'text-ink-2' : ''}`}
              {...(column.said ? { 'data-said': '' } : {})}
            >
              {column.text}
            </span>
            {column.problem && (
              <span className="flex items-center gap-1.5 text-caption">
                <ProblemIcon size={12} />
                {column.problem}
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
