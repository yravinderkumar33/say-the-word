import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AppStatus, PillState, Practice } from '@shared/ipc'
import { dictationKeyLabel } from '@shared/keycodes'
import { PRODUCT_NAME } from '@shared/product'
import { whenSettled } from './answers'
import { useOllama } from './Cleanup'
import {
  AppIcon,
  AttentionIcon,
  Button,
  DoneMark,
  ICONS,
  Icon,
  Keys,
  Meter,
  PopUp,
  ProblemIcon,
  ProgressBar,
  RadioMark,
  Toggle,
  radioKeys,
} from './components'
import { EXAMPLE, OLLAMA_OPENED, RULES_ONLY, RULES_ONLY_LABEL } from './cleanup-view'
import {
  barLine,
  canPractise,
  cleanedModelChange,
  cleanedPick,
  cleanedRows,
  cleanedSkip,
  downloadBar,
  exercises,
  exercisesDone,
  gestureSummary,
  legend,
  legendIndex,
  legendSpoken,
  modeSummary,
  stepOrder,
  stepStates,
  type DownloadBar,
  type StepId,
} from './first-run'
import { useMicTest } from './mic-test'
import { DOWNLOAD_NAME } from './model-step'
import { SYSTEM_DEFAULT, microphoneOptions } from './settings-view'

/** How long a step that completed by itself is shown as done before the next one comes. */
const MOVE_ON_AFTER_MS = 1_000
/** How long the bar says that the model has arrived before it goes. */
const DONE_BAR_FOR_MS = 3_500
/** How long the check listens before it says that it has heard nothing. */
const NOTHING_HEARD_AFTER_MS = 10_000
/** How long the check listens at all. A window left on this step does not keep the microphone. */
const CHECK_FOR_MS = 60_000
/** How long a switch in System Settings is waited for before a hint is given. */
const HINT_AFTER_MS = 8_000

/**
 * The first run: one step to a screen, each with one thing to do, and the speech model
 * arriving at the foot of the window meanwhile. It ends with a dictation actually
 * made, which is what the old checklist never got to.
 */
export function FirstRun({ status, onChanged }: { status: AppStatus; onChanged: () => void }) {
  const [step, setStep] = useState<StepId>('welcome')
  /** Once another dictation app has been found, its step stays in the list. */
  const [keysNeeded, setKeysNeeded] = useState(false)
  useEffect(() => {
    if (status.conflict) setKeysNeeded(true)
  }, [status.conflict])
  const order = stepOrder(keysNeeded)
  const at = order.indexOf(step)
  const go = (to: number): void => {
    const next = order[to]
    if (next) setStep(next)
  }
  const next = (): void => go(at + 1)
  // For the automated tests and the pictures, which cannot grant a permission to reach
  // the steps behind it: the control line asks for a step by name.
  useEffect(() => {
    const jump = (event: Event): void => {
      const wanted = (event as CustomEvent<StepId>).detail
      if (wanted === 'keys') setKeysNeeded(true)
      setStep(wanted)
    }
    window.addEventListener('flow-test-step', jump)
    return () => window.removeEventListener('flow-test-step', jump)
  }, [])

  // A step that has changed under the keyboard starts again from its heading. The practice
  // sees to its own: there the keyboard belongs in the box, and this effect runs after
  // the step's own, so it would take the keyboard out of the box again.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (step !== 'try') heading.current?.focus()
  }, [step])

  /** The model was not there at some point: its arrival is then worth a line. */
  const [seenMissing, setSeenMissing] = useState(false)
  useEffect(() => {
    if (!status.speech.modelDownloaded) setSeenMissing(true)
  }, [status.speech.modelDownloaded])
  const [doneBarGone, setDoneBarGone] = useState(false)
  const bar = downloadBar(status.speech, seenMissing)
  useEffect(() => {
    if (bar.kind !== 'done') return setDoneBarGone(false)
    const timer = setTimeout(() => setDoneBarGone(true), DONE_BAR_FOR_MS)
    return () => clearTimeout(timer)
  }, [bar.kind])

  const key = dictationKeyLabel(status.dictationKey)
  const change = (asked: Promise<unknown>): void => whenSettled(asked, onChanged)

  const [practiceFrom] = useState<Practice>(status.practice)
  const practised = exercisesDone(status.practice, practiceFrom)
  // The microphones there are, as far as the check is concerned: which ones, and which of
  // them the system takes by default. A speaker or a camera that comes and goes changes
  // nothing that was heard.
  const [inputs, setInputs] = useState<{ ids: string[]; defaultGroup: string }>({
    ids: [],
    defaultGroup: '',
  })
  useEffect(() => {
    let alive = true
    const look = (): void => {
      navigator.mediaDevices.enumerateDevices().then(
        (devices) => {
          if (!alive) return
          const audio = devices.filter((device) => device.kind === 'audioinput')
          const next = {
            ids: audio.map((device) => device.deviceId).sort(),
            defaultGroup: audio.find((device) => device.deviceId === 'default')?.groupId ?? '',
          }
          setInputs((before) => (JSON.stringify(before) === JSON.stringify(next) ? before : next))
        },
        () => {},
      )
    }
    look()
    navigator.mediaDevices.addEventListener('devicechange', look)
    return () => {
      alive = false
      navigator.mediaDevices.removeEventListener('devicechange', look)
    }
  }, [])
  const [heardKey, setHeardKey] = useState<string | null>(null)
  // "Heard you" is about one microphone: the one chosen, while it is there, or the one the
  // system takes by default. Another one, or another default, has not been heard.
  const microphoneCheckKey = JSON.stringify([
    status.microphoneInUse,
    status.microphone,
    status.microphoneInUse ? inputs.ids.includes(status.microphoneInUse) : inputs.defaultGroup,
  ])
  useEffect(() => setHeardKey(null), [microphoneCheckKey])
  const heard = heardKey === microphoneCheckKey && status.microphone === 'granted'
  /** The model picked for Cleaned mode: a name, `RULES_ONLY` for none, or null before anything is picked. */
  const [cleaned, setCleaned] = useState<string | null>(null)
  // On for a new installation. Shown again from Settings, it starts from what is so.
  const [openAtLogin, setOpenAtLogin] = useState(
    status.firstRun === 'again' ? status.preferences.openAtLogin === true : true,
  )
  const skipCleaned = cleanedSkip(status.firstRun, status.mode)

  /** What each step's buttons at the foot of the window say, and what they do. */
  const footer: Record<StepId, Footer> = {
    welcome: {
      primary: 'Get started',
      enabled: true,
      onPrimary: () => {
        // The one thing the app fetches, and it is this click that starts it.
        if (bar.kind === 'needed') change(window.flowHub.downloadModel())
        next()
      },
    },
    microphone: { primary: 'Continue', enabled: heard, onPrimary: next },
    accessibility: {
      primary: 'Continue',
      enabled: status.helper.accessibilityTrusted === true,
      onPrimary: next,
    },
    keys: { primary: 'Continue', enabled: status.conflict === null, onPrimary: next },
    try: {
      primary: 'Continue',
      enabled: practised.every(Boolean),
      onPrimary: next,
      ...(practised.every(Boolean) ? {} : { skip: 'Practise later', onSkip: next }),
    },
    cleaned: {
      primary: 'Use Cleaned',
      enabled: true,
      onPrimary: () => {
        // The mode is what was chosen here, whatever becomes of the model: one that cannot be
        // used leaves Cleaned mode with the rules only, and Home and Cleanup say why. With
        // nothing picked, the model stays as the setting has it, Ollama running or not.
        const model = cleanedModelChange(cleaned)
        const chosen: Promise<unknown> = model
          ? window.flowHub.chooseCleanupModel(model.model).catch(() => undefined)
          : Promise.resolve()
        change(chosen.then(() => window.flowHub.setMode('cleaned')))
        next()
      },
      skip: skipCleaned.label,
      onSkip: () => {
        if (skipCleaned.mode) change(window.flowHub.setMode(skipCleaned.mode))
        next()
      },
    },
    ready: {
      primary: 'Start dictating',
      enabled: true,
      // The switch as it stands, on or off: the main process sets the login item to it.
      onPrimary: () => change(window.flowHub.finishFirstRun(openAtLogin)),
    },
  }
  const foot = footer[step]

  return (
    <div className="flex min-h-0 flex-1 bg-bg text-body text-ink" data-first-run={step}>
      <nav
        aria-label="Setup steps"
        className="drags-window flex w-[212px] flex-none flex-col gap-0.5 border-r border-line bg-sidebar px-2.5 pt-14 pb-4 compact:w-[180px]"
      >
        <p className="px-2.5 pb-3 text-caption text-ink-2">Set up {PRODUCT_NAME}</p>
        <ol className="flex flex-col gap-0.5">
          {stepStates(order, step).map((item) => (
            <li
              key={item.id}
              data-step={item.id}
              data-step-state={item.state}
              aria-current={item.state === 'current' ? 'step' : undefined}
              className={`flex h-[30px] items-center gap-2 rounded-control px-2.5 ${
                item.state === 'current' ? 'bg-fill-selected font-semibold shadow-selected' : ''
              }`}
            >
              {item.state === 'current' ? (
                <span
                  aria-hidden="true"
                  className="box-border size-4 flex-none rounded-full border-[4.5px] border-ink"
                />
              ) : (
                <DoneMark done={item.state === 'done'} size={16} />
              )}
              {/* The step's name is never broken: "Optional" gives way to it. */}
              <span className="flex-1 whitespace-nowrap">
                {item.label}
                {item.state === 'done' && <span className="only-spoken">, done</span>}
              </span>
              {item.optional && (
                <span className="min-w-0 truncate text-[11px] font-normal text-ink-2">
                  Optional
                </span>
              )}
            </li>
          ))}
        </ol>
        <div className="flex-1" />
        <p className="px-2.5 text-caption text-pretty text-ink-2">Everything runs on this Mac.</p>
      </nav>

      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="drags-window-over-page absolute inset-x-0 top-0 h-11" />
        <div className="min-h-0 flex-1 overflow-y-auto px-14 pt-[60px] pb-6 compact:px-7 compact:pt-8">
          <div className="flex max-w-[560px] flex-col">
            {step === 'welcome' && <Welcome heading={heading} keyLabel={key} bar={bar} />}
            {step === 'microphone' && (
              <MicrophoneStep
                checkKey={microphoneCheckKey}
                heading={heading}
                status={status}
                keyLabel={key}
                onChanged={onChanged}
                onHeard={() => setHeardKey(microphoneCheckKey)}
                heard={heard}
                onSkip={next}
              />
            )}
            {step === 'accessibility' && (
              <AccessibilityStep heading={heading} status={status} keyLabel={key} onDone={next} />
            )}
            {step === 'keys' && (
              <KeysStep heading={heading} status={status} keyLabel={key} onChanged={onChanged} />
            )}
            {step === 'try' && (
              <TryStep
                heading={heading}
                status={status}
                keyLabel={key}
                bar={bar}
                done={practised}
                onChanged={onChanged}
              />
            )}
            {step === 'cleaned' && (
              <CleanedStep heading={heading} picked={cleaned} onPick={setCleaned} />
            )}
            {step === 'ready' && (
              <ReadyStep
                heading={heading}
                status={status}
                keyLabel={key}
                openAtLogin={openAtLogin}
                onOpenAtLogin={setOpenAtLogin}
              />
            )}
          </div>
        </div>

        <div className="flex flex-none items-center gap-2.5 py-3.5 pr-6 pl-14 compact:pl-7">
          {at > 0 && <FootButton onClick={() => go(at - 1)}>Back</FootButton>}
          <span className="flex-1" />
          {foot.skip && foot.onSkip && <FootButton onClick={foot.onSkip}>{foot.skip}</FootButton>}
          <button
            type="button"
            disabled={!foot.enabled}
            onClick={foot.onPrimary}
            className="h-7 rounded-control bg-prominent px-4 font-medium text-on-prominent disabled:bg-fill disabled:text-ink-2"
          >
            {foot.primary}
          </button>
        </div>

        {/* There from the start, so that a change of it is read out, and apart from the bar,
            whose figures change at every look. */}
        <p className="only-spoken" aria-live="polite">
          {barLine(bar)}
        </p>
        {bar.kind !== 'hidden' && !(bar.kind === 'done' && doneBarGone) && (
          <ModelBar bar={bar} onChanged={onChanged} />
        )}
      </main>
    </div>
  )
}

interface Footer {
  primary: string
  enabled: boolean
  onPrimary: () => void
  skip?: string
  onSkip?: () => void
}

type Heading = React.RefObject<HTMLHeadingElement | null>

function FootButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-7 rounded-control bg-control px-3.5 font-medium shadow-control"
    >
      {children}
    </button>
  )
}

/** A step's name, and under it what the step is about. Focus is put here when the step comes. */
function StepHead(props: { heading: Heading; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h1 ref={props.heading} tabIndex={-1} className="text-status outline-none">
        {props.title}
      </h1>
      {props.children && <div className="text-lede text-pretty text-ink-2">{props.children}</div>}
    </div>
  )
}

/** "Done", with a tick: said in words, and weight, never by a colour. */
function DoneLine({ children }: { children: ReactNode }) {
  return (
    <p className="inline-flex items-center gap-2 font-semibold" data-done="true">
      <Icon d="M2.8 7.3 5.6 10l5.6-6" viewBox={14} size={14} strokeWidth={1.8} />
      {children}
    </p>
  )
}

// --- Welcome ---------------------------------------------------------------------------

function Welcome({
  heading,
  keyLabel,
  bar,
}: {
  heading: Heading
  keyLabel: string
  bar: DownloadBar
}) {
  const promises: Array<[string, string]> = [
    [
      'M8 2.5a2 2 0 0 1 2 2v3.5a2 2 0 0 1-4 0V4.5a2 2 0 0 1 2-2zM4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5',
      'Speech is recognized on this Mac, by a model stored on this Mac.',
    ],
    [
      'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM4.2 4.2l7.6 7.6',
      'No account, no cloud and no telemetry.',
    ],
    [
      'M3.5 7.5h9v6h-9zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2',
      'What you say is written to disk only if you choose to keep a history.',
    ],
  ]
  return (
    <div className="flex flex-col gap-7 pt-5">
      <AppIcon size={88} />
      <div className="flex flex-col gap-3">
        <h1 ref={heading} tabIndex={-1} className="text-status outline-none">
          {PRODUCT_NAME}
        </h1>
        <p className="flex flex-wrap items-center gap-1.5 text-lede">
          <span>Hold</span>
          <Keys caps={[keyLabel]} />
          <span>and speak. Let go, and the text is typed into the app you are using.</span>
        </p>
      </div>
      <ul className="flex flex-col border-t border-line">
        <li className="border-b border-line py-3.5 text-[17px] font-semibold tracking-[-0.01em]">
          Everything runs on this Mac.
        </li>
        {promises.map(([icon, words]) => (
          <li
            key={words}
            className="grid grid-cols-[20px_minmax(0,1fr)] items-start gap-2.5 border-b border-line py-[11px]"
          >
            <Icon d={icon} className="mt-px text-ink-2" />
            <span>{words}</span>
          </li>
        ))}
      </ul>
      <p className="text-caption text-pretty text-ink-2">
        {bar.kind === 'needed'
          ? `The speech model (${bar.size}) is downloaded when you click Get started, at the foot of this window. It is the one thing ${PRODUCT_NAME} fetches; you can carry on while it arrives.`
          : bar.kind === 'hidden' || bar.kind === 'done'
            ? 'The speech model is already on this Mac: nothing needs to be downloaded.'
            : `The speech model is on its way, at the foot of this window. It is the one thing ${PRODUCT_NAME} fetches; you can carry on while it arrives.`}
      </p>
    </div>
  )
}

// --- Microphone ------------------------------------------------------------------------

export function MicrophoneStep(props: {
  heading: Heading
  /** What the check is of. When it changes, the check starts again; the step stays as it is. */
  checkKey: string
  status: AppStatus
  keyLabel: string
  heard: boolean
  onHeard: () => void
  onChanged: () => void
  onSkip: () => void
}) {
  const { status, heard, onHeard, checkKey } = props
  const mic = useMicTest()
  const allowed = status.microphone === 'granted'
  const refused = status.microphone === 'denied' || status.microphone === 'restricted'
  const [asked, setAsked] = useState(false)
  const [silent, setSilent] = useState(false)
  /** The check has listened for as long as it does, heard nothing, and let the microphone go. */
  const [over, setOver] = useState(false)
  /** Counts the times "Listen Again" was pressed: each starts the check afresh. */
  const [round, setRound] = useState(0)
  const inUse = status.microphoneInUse

  // The check starts by itself once the microphone is allowed, and again when another is
  // chosen. It ends by itself too: "during this check" is a minute, not for as long as the
  // window is left open on this step.
  const { start, stop } = mic
  useEffect(() => {
    if (!allowed || heard) return
    setSilent(false)
    setOver(false)
    start(inUse, CHECK_FOR_MS, checkKey)
    const quiet = setTimeout(() => setSilent(true), NOTHING_HEARD_AFTER_MS)
    const end = setTimeout(() => setOver(true), CHECK_FOR_MS)
    return () => {
      clearTimeout(quiet)
      clearTimeout(end)
      stop()
    }
  }, [allowed, inUse, heard, round, start, stop, checkKey])
  // Heard: the microphone has done what the check was for, and is let go. Only by the
  // check of what is in use now: the one before may have heard a voice a moment ago.
  useEffect(() => {
    if (mic.heard && mic.label === checkKey && mic.testing === (inUse ?? '')) onHeard()
  }, [mic.heard, mic.label, checkKey, onHeard])

  const ask = (): void => {
    setAsked(true)
    void window.flowHub.requestMicrophone().then(props.onChanged, props.onChanged)
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <StepHead heading={props.heading} title="Microphone">
        <span className="flex flex-wrap items-center gap-1.5">
          <span>{PRODUCT_NAME} listens while you hold</span>
          <Keys caps={[props.keyLabel]} />
          <span>and stops when you let go.</span>
        </span>
      </StepHead>

      {!allowed && !refused && (
        <div className="flex flex-col items-start gap-3.5">
          <button
            type="button"
            onClick={ask}
            className="h-[30px] rounded-control bg-prominent px-4 font-medium text-on-prominent"
          >
            Allow the microphone
          </button>
          <p className="text-caption text-ink-2">
            macOS will ask you to confirm. On only while you dictate, and during this check.
          </p>
        </div>
      )}

      {refused && (
        <div className="flex gap-3.5 rounded-card bg-card p-5" data-notice="microphone-refused">
          <AttentionIcon size={22} />
          <div className="flex flex-col items-start gap-2">
            <p className="text-[14px] font-semibold">The microphone is not allowed</p>
            <p className="text-pretty text-ink-2">
              Turn on {PRODUCT_NAME} in System Settings › Privacy &amp; Security › Microphone. This
              step continues by itself when it is on.
            </p>
            <button
              type="button"
              onClick={ask}
              className="mt-1 h-7 rounded-control bg-prominent px-3.5 font-medium text-on-prominent"
            >
              Open System Settings
            </button>
            {asked && (
              <p className="text-caption text-ink-2">Waiting for the switch in System Settings…</p>
            )}
          </div>
        </div>
      )}

      {allowed && (
        <>
          <div className="flex flex-col gap-4 rounded-card bg-card p-5">
            <CheckRow label="Microphone">
              <PopUp
                label="Microphone"
                value={inUse ?? SYSTEM_DEFAULT}
                options={microphoneOptions(status)}
                onChange={(value) =>
                  void window.flowHub
                    .chooseMicrophone(value === SYSTEM_DEFAULT ? null : value)
                    .then(props.onChanged, props.onChanged)
                }
              />
            </CheckRow>
            <CheckRow label="Level">
              <Meter
                level={mic.level}
                segments={24}
                wide
                says={heard ? 'Heard you' : mic.sound ? 'Hearing you' : 'Silent'}
              />
            </CheckRow>
            <CheckRow label="">
              {heard ? (
                <DoneLine>Heard you. The microphone works.</DoneLine>
              ) : mic.problem ? (
                <span className="flex items-center gap-1.5">
                  <ProblemIcon />
                  {mic.problem}. Choose another microphone above.
                </span>
              ) : over ? (
                <span className="flex items-center gap-3" data-check="over">
                  <span className="text-ink-2">The check has stopped listening.</span>
                  <Button onClick={() => setRound((count) => count + 1)}>Listen Again</Button>
                </span>
              ) : (
                <span className="text-ink-2">Say a few words, as you would to a colleague.</span>
              )}
            </CheckRow>
          </div>
          {silent && !heard ? (
            <p className="flex flex-wrap items-baseline gap-x-3 text-caption text-ink-2">
              <span>
                Nothing heard yet. Check that the microphone is not muted, or choose another one
                above.
              </span>
              <button
                type="button"
                onClick={props.onSkip}
                className="rounded-[3px] underline underline-offset-2"
              >
                Continue without the check
              </button>
            </p>
          ) : (
            <p className="text-caption text-ink-2">
              On only while you dictate, and during this check.
            </p>
          )}
        </>
      )}
    </div>
  )
}

function CheckRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-[84px] flex-none text-ink-2">{label}</span>
      {children}
    </div>
  )
}

// --- Accessibility ---------------------------------------------------------------------

function AccessibilityStep(props: {
  heading: Heading
  status: AppStatus
  keyLabel: string
  onDone: () => void
}) {
  const on = props.status.helper.accessibilityTrusted === true
  const [opened, setOpened] = useState(false)
  const [hint, setHint] = useState(false)
  /** How the step was found: one that was done already is not walked past by itself. */
  const [wasOn] = useState(on)

  useEffect(() => {
    if (!opened || on) return
    const timer = setTimeout(() => setHint(true), HINT_AFTER_MS)
    return () => clearTimeout(timer)
  }, [opened, on])
  // The switch was turned on while this step was showing: it moves on by itself. What to
  // do then is read when the time comes: the function is a new one at every drawing, and
  // a wait that began again with each of them would never end on a slow day.
  const onDone = useRef(props.onDone)
  useEffect(() => {
    onDone.current = props.onDone
  })
  useEffect(() => {
    if (!on || wasOn) return
    const timer = setTimeout(() => onDone.current(), MOVE_ON_AFTER_MS)
    return () => clearTimeout(timer)
  }, [on, wasOn])

  return (
    <div className="flex flex-col gap-[22px]">
      <StepHead heading={props.heading} title="Accessibility">
        Lets {PRODUCT_NAME} notice the {props.keyLabel} key and paste into the app you are using. It
        sees shortcut keys only, never what you type.
      </StepHead>

      {/* The list in System Settings, drawn in this app's own style: which row, and which switch. */}
      <div className="flex flex-col gap-2.5 rounded-card bg-card p-[18px]" aria-hidden="true">
        <p className="flex items-center gap-2 text-caption text-ink-2">
          <Icon d={ICONS.back} size={10} strokeWidth={1.5} />
          <span>
            System Settings › Privacy &amp; Security ›{' '}
            <strong className="font-semibold text-ink">Accessibility</strong>
          </span>
        </p>
        <div className="overflow-hidden rounded-[8px] bg-bg shadow-outline">
          <ListedApp name="Terminal" />
          <div className="flex h-11 items-center gap-2.5 rounded-control border-b border-line px-3.5 shadow-chosen">
            <AppIcon size={22} />
            <span className="flex-1 font-semibold">{PRODUCT_NAME}</span>
            {!on && (
              <span className="inline-flex items-center gap-2 text-caption text-ink-2">
                Turn this on
                <Icon d="M1 5h11M8.5 1.5 12 5 8.5 8.5" viewBox={14} size={14} />
              </span>
            )}
            <Switch on={on} />
          </div>
          <ListedApp name="Script Editor" on />
        </div>
      </div>

      {on ? (
        <DoneLine>Accessibility is on.</DoneLine>
      ) : (
        <>
          <div className="flex items-center gap-3.5">
            <button
              type="button"
              onClick={() => {
                setOpened(true)
                void window.flowHub.requestAccessibility()
              }}
              className="h-[30px] rounded-control bg-prominent px-4 font-medium text-on-prominent"
            >
              Open System Settings
            </button>
            {opened && (
              <span className="text-ink-2">
                Waiting for the switch. This step continues by itself.
              </span>
            )}
          </div>
          {hint && (
            <p className="text-caption text-pretty text-ink-2">
              The switch is still off. If {PRODUCT_NAME} is not in the list, click + under it and
              choose {PRODUCT_NAME} in Applications.
            </p>
          )}
          {!props.status.packaged && (
            <p className="text-caption text-pretty text-ink-2">
              Development build: macOS asks on behalf of the terminal that started the app.
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** A switch as System Settings draws one. It is a picture: the real one is in System Settings. */
function Switch({ on, dim = false }: { on: boolean; dim?: boolean }) {
  return (
    <span
      className={`relative h-[18px] w-[30px] flex-none rounded-full ${on ? 'bg-ink' : 'bg-fill-strong'} ${dim ? 'opacity-50' : ''}`}
    >
      <span
        className={`absolute top-0.5 size-3.5 rounded-full ${on ? 'left-3.5 bg-bg' : 'left-0.5 bg-knob shadow-knob'}`}
      />
    </span>
  )
}

function ListedApp({ name, on = false }: { name: string; on?: boolean }) {
  return (
    <div className="flex h-10 items-center gap-2.5 border-b border-line px-3.5 last:border-b-0">
      <span className="grid size-[22px] place-items-center rounded-[5px] bg-app-tile text-[11px] font-semibold text-app-tile-ink">
        {name.charAt(0)}
      </span>
      <span className="flex-1">{name}</span>
      <Switch on={on} dim={on} />
    </div>
  )
}

// --- Keys ------------------------------------------------------------------------------

function KeysStep(props: {
  heading: Heading
  status: AppStatus
  keyLabel: string
  onChanged: () => void
}) {
  const { status } = props
  /** The app that was in the way when this step came, for the line that says it is settled. */
  const [other] = useState(status.conflict)
  const settled = status.conflict === null
  return (
    <div className="flex flex-col gap-[22px]">
      <StepHead heading={props.heading} title="Keys">
        {settled
          ? 'One app listens to the key now.'
          : `${status.conflict} is running and also listens to the ${props.keyLabel} key. Two apps on one key would both start at once.`}
      </StepHead>
      {settled ? (
        <DoneLine>
          {status.dictationKey === 'ctrlOption'
            ? `${PRODUCT_NAME} now listens to ⌃⌥.`
            : `${other ?? 'The other app'} has quit. ${props.keyLabel} belongs to ${PRODUCT_NAME}.`}
        </DoneLine>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5 rounded-card bg-card p-4 shadow-outline">
            <span className="text-[14px] font-semibold">Quit {status.conflict}</span>
            <span className="text-pretty text-ink-2">
              Keep {props.keyLabel} for {PRODUCT_NAME}. Quit it from its own menu: this step
              continues by itself.
            </span>
          </div>
          <button
            type="button"
            onClick={() =>
              void window.flowHub
                .changePreference({ dictationKey: 'ctrlOption' })
                .then(props.onChanged, props.onChanged)
            }
            className="flex flex-col gap-1.5 rounded-card bg-card p-4 text-left shadow-outline"
          >
            <span className="flex items-center gap-1.5 text-[14px] font-semibold">
              Use <Keys caps={['⌃⌥']} /> instead
            </span>
            <span className="text-pretty text-ink-2">
              Both apps keep working. You can change it in Settings.
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

// --- Try it ----------------------------------------------------------------------------

function TryStep(props: {
  heading: Heading
  status: AppStatus
  keyLabel: string
  bar: DownloadBar
  done: [boolean, boolean, boolean]
  onChanged: () => void
}) {
  const { status, bar } = props
  const ready = canPractise(status.speech)
  const box = useRef<HTMLTextAreaElement>(null)
  // The text lands where the keyboard is, so the keyboard is put in the box as soon as it
  // can be dictated into. Until then the step starts from its heading, like the others.
  const { heading } = props
  useEffect(() => {
    if (ready) box.current?.focus()
    else heading.current?.focus()
  }, [ready, heading])

  return (
    <div className="flex flex-col gap-5">
      <StepHead heading={props.heading} title="Try it">
        The text lands in the box below. Nothing here is kept.
      </StepHead>

      {!ready && (
        <div
          className="flex flex-col gap-2.5 rounded-card bg-card px-[18px] py-4"
          data-notice="model-wait"
        >
          {bar.kind === 'running' && (
            <>
              <span>
                The speech model is still downloading: {bar.got} of {bar.size}.
              </span>
              <ProgressBar value={bar.progress} label={DOWNLOAD_NAME} slim />
              <span className="text-caption text-ink-2">
                The exercises start when it is in place. You can also continue and practise later.
              </span>
            </>
          )}
          {bar.kind === 'stopped' && (
            <ProblemLine
              text="The download stopped. What was downloaded is kept."
              action="Try again"
              onAction={() => whenSettled(window.flowHub.downloadModel(), props.onChanged)}
            />
          )}
          {bar.kind === 'damaged' && (
            <ProblemLine
              text="The speech model could not be started, so it cannot be used."
              action="Check the model files"
              onAction={() => whenSettled(window.flowHub.repairModel(), props.onChanged)}
            />
          )}
          {bar.kind === 'needed' && (
            <ProblemLine
              text="The speech model is not downloaded."
              action={`Download (${bar.size})`}
              onAction={() => whenSettled(window.flowHub.downloadModel(), props.onChanged)}
            />
          )}
          {(bar.kind === 'checking' || bar.kind === 'hidden' || bar.kind === 'done') && (
            <span>Loading the speech model…</span>
          )}
        </div>
      )}

      <div className={`flex flex-col gap-5 ${ready ? '' : 'opacity-40'}`}>
        <span className="field block rounded-[8px] bg-bg shadow-[0_0_0_1px_var(--line),inset_0_1px_2px_rgb(0_0_0/0.04)]">
          {/* The practice dictations land here: what was said, which a picture leaves blank. */}
          <textarea
            ref={box}
            aria-label="Practice box"
            placeholder="Your words appear here."
            disabled={!ready}
            rows={4}
            spellCheck={false}
            className="block min-h-[92px] w-full resize-none bg-transparent px-4 py-3.5 text-[14px] leading-[1.55] outline-none"
            data-said
          />
        </span>
        <div className="grid grid-cols-[minmax(0,1fr)_220px] items-start gap-6">
          <ol className="flex flex-col border-t border-line" aria-label="Exercises">
            {exercises(status.dictationKey).map((parts, index) => (
              <li
                key={index}
                data-done={props.done[index]}
                className="flex min-h-11 items-center gap-3 border-b border-line py-1.5"
              >
                <DoneMark done={props.done[index] ?? false} />
                {/* One sentence with its keys in it: it breaks where a sentence would. */}
                <span className="min-w-0 leading-[26px] text-pretty">
                  {parts.map((part, at) => (
                    <Fragment key={at}>
                      {at > 0 && ' '}
                      {typeof part === 'string' ? (
                        part
                      ) : (
                        <Keys caps={[part.key]} className="align-middle" />
                      )}
                    </Fragment>
                  ))}
                  {props.done[index] && <span className="only-spoken">, done</span>}
                </span>
              </li>
            ))}
          </ol>
          <PillMirror keyLabel={props.keyLabel} />
        </div>
      </div>
    </div>
  )
}

function ProblemLine(props: { text: string; action: string; onAction: () => void }) {
  return (
    <div className="flex items-center gap-2.5">
      <ProblemIcon size={16} />
      <span className="flex-1">{props.text}</span>
      <Button onClick={props.onAction}>{props.action}</Button>
    </div>
  )
}

/**
 * What the pill is saying, beside the practice box: a small drawing of it as it
 * changes, and its states by name with the one it is in picked out. It is a picture of
 * the pill, which is itself above the Dock; nothing here can be pressed.
 */
function PillMirror({ keyLabel }: { keyLabel: string }) {
  const [pill, setPill] = useState<PillState>({ kind: 'resting', waiting: false })
  useEffect(() => window.flowHub.onPill(setPill), [])
  const at = legendIndex(pill)
  const live = pill.kind === 'listening'
  const pillBody =
    'flex items-center rounded-full bg-[var(--pill-bg)] text-[var(--pill-ink)] shadow-[var(--pill-shadow)]'
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-caption text-ink-2">The pill says</p>
      <div
        aria-hidden="true"
        data-mirror={pill.kind}
        className="flex h-16 items-center justify-center overflow-hidden rounded-[8px] bg-[linear-gradient(90deg,var(--pill-behind-light)_50%,var(--pill-behind-dark)_50%)] shadow-outline"
      >
        {pill.kind === 'resting' && (
          <span className="h-1.5 w-9 rounded-full bg-[var(--pill-rest)] shadow-[var(--pill-rest-shadow)]" />
        )}
        {(pill.kind === 'starting' || live) && (
          <span
            className={`${pillBody} gap-2.5 px-[15px] text-[12.5px]/none font-medium ${live ? 'h-[30px]' : 'h-7'}`}
          >
            <span className="flex h-[18px] items-center gap-[3px]">
              {[8, 13, 18, 12, 7].map((height, index) => (
                <span
                  key={index}
                  data-motion="bar"
                  className="w-[3px] origin-center rounded-[2px]"
                  style={{
                    height: live ? height : 3,
                    background: live ? 'var(--pill-live)' : 'var(--pill-idle)',
                    animation: live
                      ? `mirror-bar ${520 + index * 70}ms ease-in-out ${index * 60}ms infinite alternate`
                      : undefined,
                  }}
                />
              ))}
            </span>
            {live && pill.handsFree && (
              <span className="grid size-5 place-items-center rounded-full bg-[var(--pill-ink)]">
                <span className="size-[7px] rounded-[2px] bg-[var(--pill-bg)]" />
              </span>
            )}
          </span>
        )}
        {pill.kind === 'processing' && (
          <span className={`${pillBody} h-6 px-[13px]`}>
            <span className="relative h-[3px] w-7 overflow-hidden rounded-[2px] bg-[var(--pill-track)]">
              <span
                data-motion="sweep"
                className="absolute top-0 left-0 h-[3px] w-2.5 rounded-[2px] bg-[var(--pill-ink)]"
                style={{ animation: 'mirror-sweep 800ms ease-in-out infinite alternate' }}
              />
            </span>
          </span>
        )}
        {pill.kind === 'recovery' && (
          <span
            className={`${pillBody} h-[30px] max-w-[200px] gap-[7px] pr-1 pl-2.5 text-[12px]/none font-medium`}
          >
            <span className="truncate">{pill.message}</span>
            {pill.redo && (
              <span className="flex h-[22px] flex-none items-center rounded-full bg-[var(--pill-btn)] px-[9px] font-semibold text-[var(--pill-btn-ink)]">
                {pill.redo}
              </span>
            )}
          </span>
        )}
      </div>
      {/* The list says which state is current by its weight alone, and that is not announced. */}
      <p className="only-spoken" aria-live="polite">
        {legendSpoken(pill, keyLabel)}
      </p>
      <ul className="flex flex-col gap-0.5" aria-label="What the pill is saying">
        {legend(keyLabel).map((line, index) => (
          <li
            key={line}
            aria-current={index === at ? 'true' : undefined}
            className={`flex items-start gap-2 py-[3px] text-caption/4 ${index === at ? 'font-semibold text-ink' : 'text-ink-2'}`}
          >
            {/* Beside the first line of a state whose words take two. */}
            <span
              aria-hidden="true"
              className={`mt-[5.5px] size-[5px] flex-none rounded-full ${index !== at ? '' : index === 2 || index === 3 ? 'bg-live' : 'bg-ink'}`}
            />
            <span className="min-w-0">{line}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// --- Cleaned mode ----------------------------------------------------------------------

function CleanedStep(props: {
  heading: Heading
  picked: string | null
  onPick: (model: string) => void
}) {
  const ollama = useOllama()
  const { facts } = ollama
  const running = facts?.ollama === 'running'
  // Until the user picks, the step shows what the setting says, Ollama running or not.
  // "Rules only" is a pick like any other: once made it stands, whatever Ollama lists.
  const rows = cleanedRows(facts)
  const shown = cleanedPick(props.picked, facts)
  // One stop for Tab in the group: the option chosen, or the first while none is.
  const stop = shown ?? rows[0]?.name ?? RULES_ONLY
  return (
    <div className="flex flex-col gap-5">
      <StepHead heading={props.heading} title="Cleaned mode">
        The same words, tidied by a model running on this Mac. It never changes numbers, names,
        email addresses, links or a “not”, and never rephrases or adds anything.
      </StepHead>

      <dl className="flex flex-col border-t border-line">
        {(
          [
            ['Spoken', EXAMPLE.spoken, 'text-ink-2 italic'],
            ['Verbatim', EXAMPLE.verbatim, ''],
            ['Cleaned', EXAMPLE.cleaned, 'font-semibold'],
          ] as const
        ).map(([name, text, look]) => (
          <div
            key={name}
            className="grid grid-cols-[76px_minmax(0,1fr)] gap-3 border-b border-line py-[11px]"
          >
            <dt className="text-ink-2">{name}</dt>
            <dd className={look}>{text}</dd>
          </div>
        ))}
      </dl>

      {/* The same row as on the Cleanup page, in the same words. */}
      <div
        className="flex items-center gap-3 rounded-card bg-card px-3.5 py-3"
        data-ollama={facts?.ollama}
      >
        <Icon
          d={ICONS[ollama.icon ?? 'absent']}
          strokeWidth={ollama.icon === 'tick' ? 1.6 : 1.4}
          className={ollama.icon === 'tick' ? '' : 'text-ink-2'}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-semibold">Ollama</span>
          <span className="text-caption text-pretty text-ink-2">{ollama.text}</span>
        </div>
        {ollama.action === 'get' && <Button onClick={ollama.get}>Get Ollama</Button>}
        {ollama.action === 'start' && <Button onClick={ollama.start}>Start Ollama</Button>}
      </div>
      {ollama.opened && <p className="-mt-3 text-caption text-ink-2">{OLLAMA_OPENED}</p>}

      <div className="flex flex-col gap-2">
        <h2 className="text-heading">Model</h2>
        <div
          role="radiogroup"
          aria-label="Model"
          className="flex flex-col overflow-hidden rounded-card shadow-outline"
          onKeyDown={radioKeys}
        >
          {rows.map((row) => (
            <ModelChoice
              key={row.name}
              name={row.name}
              note={row.note}
              size={row.size}
              chosen={shown === row.name}
              tabStop={stop === row.name}
              onChoose={() => props.onPick(row.name)}
            />
          ))}
          <ModelChoice
            name={RULES_ONLY_LABEL}
            note={`Tidies hesitations and repeated words with fixed rules.${running ? '' : ' Works now.'}`}
            size=""
            chosen={shown === RULES_ONLY}
            tabStop={stop === RULES_ONLY}
            onChoose={() => props.onPick(RULES_ONLY)}
          />
          {!running && (
            <div className="flex min-h-11 items-center gap-3 px-3.5 py-2 opacity-55">
              <RadioMark chosen={false} />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">Models appear here when Ollama is running</span>
                <span className="text-caption text-ink-2">
                  Only models that run on this Mac are listed
                </span>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ModelChoice(props: {
  name: string
  note: string
  size: string
  chosen: boolean
  /** The one option of the group that Tab stops at. The arrow keys reach the others. */
  tabStop: boolean
  onChoose: () => void
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.chosen}
      tabIndex={props.tabStop ? 0 : -1}
      // The row holds a note and a size beside the name: this is the name alone.
      data-name={props.name}
      onClick={props.onChoose}
      className="flex min-h-11 items-center gap-3 border-b border-line px-3.5 py-2 text-left"
    >
      <RadioMark chosen={props.chosen} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-medium">{props.name}</span>
        <span className="text-caption text-ink-2">{props.note}</span>
      </span>
      <span className="text-caption text-ink-2 tabular-nums">{props.size}</span>
    </button>
  )
}

// --- Ready -----------------------------------------------------------------------------

function ReadyStep(props: {
  heading: Heading
  status: AppStatus
  keyLabel: string
  openAtLogin: boolean
  onOpenAtLogin: (on: boolean) => void
}) {
  const canOpenAtLogin = props.status.preferences.openAtLogin !== null
  return (
    <div className="flex flex-col gap-[22px]">
      <StepHead heading={props.heading} title="Ready">
        {PRODUCT_NAME} is set up, in {modeSummary(props.status)} mode. You can change anything later
        in Settings.
      </StepHead>

      <ul className="flex flex-col rounded-card bg-card px-[18px] py-1.5">
        {gestureSummary(props.status.dictationKey).map((gesture) => (
          <li
            key={gesture.what}
            className="flex min-h-10 items-center gap-3.5 border-b border-line last:border-b-0"
          >
            <span className="flex w-[92px] flex-none">
              <Keys caps={gesture.caps} />
            </span>
            <span>{gesture.what}</span>
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2.5">
          <div
            aria-hidden="true"
            className="flex h-[30px] items-center justify-end gap-3.5 rounded-control bg-fill px-3 text-caption"
          >
            <span className="h-1 w-7 rounded-[2px] bg-fill-strong" />
            <span className="flex items-center gap-[1.5px] rounded-[4px] px-1 py-0.5 shadow-[0_0_0_1.5px_var(--ink)]">
              {[5, 9, 12, 8, 4].map((height, index) => (
                <span key={index} className="w-0.5 rounded-[1px] bg-ink" style={{ height }} />
              ))}
            </span>
            <span className="tabular-nums">10:42</span>
          </div>
          <p>
            <strong className="font-semibold">The menu bar.</strong>{' '}
            <span className="text-ink-2">
              Status, mode, microphone, recent dictations and this window.
            </span>
          </p>
        </div>
        <div className="flex flex-col gap-2.5">
          <div
            aria-hidden="true"
            className="flex h-[30px] items-center justify-center rounded-control bg-fill"
          >
            <span className="h-1.5 w-9 rounded-full bg-[var(--pill-rest)] shadow-[var(--pill-rest-shadow)]" />
          </div>
          <p>
            <strong className="font-semibold">The pill,</strong>{' '}
            <span className="text-ink-2">
              just above the Dock. It says what is happening while you dictate.
            </span>
          </p>
        </div>
      </div>

      <label className="flex items-center gap-3 border-y border-line py-3">
        <span className="flex flex-1 flex-col gap-0.5">
          <span className="font-medium">Open at login</span>
          <span className="text-caption text-ink-2">
            {canOpenAtLogin
              ? `So that ${props.keyLabel} works from the moment you sign in.`
              : 'In the installed app only: this is a development run.'}
          </span>
        </span>
        <Toggle
          label="Open at login"
          on={props.openAtLogin && canOpenAtLogin}
          disabled={!canOpenAtLogin}
          onChange={props.onOpenAtLogin}
        />
      </label>
    </div>
  )
}

// --- The bar about the speech model ----------------------------------------------------

/** The bar at the foot of the window. A screen reader is told of its changes by a line apart from it. */
function ModelBar({ bar, onChanged }: { bar: DownloadBar; onChanged: () => void }) {
  const after = (asked: Promise<unknown>): void => whenSettled(asked, onChanged)
  const line = barLine(bar)
  return (
    <div
      data-model-bar={bar.kind}
      className="flex min-h-10 flex-none items-center gap-3 border-t border-line bg-sidebar pr-5 pl-6 text-caption"
    >
      {bar.kind === 'running' && (
        <>
          <Icon d={ICONS.save} size={14} strokeWidth={1.5} className="text-ink-2" />
          <span>{line}</span>
          <span className="w-[180px] flex-none">
            <ProgressBar value={bar.progress} label={DOWNLOAD_NAME} slim />
          </span>
          <span className="text-ink-2 tabular-nums">
            {bar.got} of {bar.size}
          </span>
        </>
      )}
      {bar.kind === 'checking' && <span>{line}</span>}
      {bar.kind === 'needed' && (
        <>
          <ProblemIcon />
          <span className="flex-1 font-semibold">{line}</span>
          <Button small onClick={() => after(window.flowHub.downloadModel())}>
            Download ({bar.size})
          </Button>
        </>
      )}
      {bar.kind === 'stopped' && (
        <>
          <ProblemIcon />
          <span className="flex-1 font-semibold">{line}</span>
          <Button small onClick={() => after(window.flowHub.downloadModel())}>
            Try again
          </Button>
        </>
      )}
      {bar.kind === 'damaged' && (
        <>
          <ProblemIcon />
          <span className="font-semibold">{line}</span>
          <span className="flex-1 text-ink-2">Only the damaged files are fetched again.</span>
          <Button small onClick={() => after(window.flowHub.repairModel())}>
            Check the model files
          </Button>
        </>
      )}
      {bar.kind === 'done' && (
        <>
          <Icon d="M2.8 7.3 5.6 10l5.6-6" viewBox={14} size={14} strokeWidth={1.8} />
          <span>{line}</span>
        </>
      )}
    </div>
  )
}
