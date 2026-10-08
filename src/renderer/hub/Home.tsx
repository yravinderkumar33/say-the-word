import type { ReactNode } from 'react'
import type { AppStatus, DictationMode, HubPage } from '@shared/ipc'
import { dictationKeyLabel } from '@shared/keycodes'
import { whenSettled } from './answers'
import {
  AttentionIcon,
  Button,
  Keys,
  LinkButton,
  PopUp,
  ProgressBar,
  Segmented,
} from './components'
import { DictationRow, ROW_COLUMNS } from './DictationRow'
import { rowView } from './history-view'
import {
  figures,
  gestures,
  homeStatus,
  microphoneCaption,
  modeCaption,
  type HomeAction,
  type HomeStatus,
} from './home-status'
import { DOWNLOAD_NAME } from './model-step'
import { SYSTEM_DEFAULT, microphoneOptions } from './settings-view'

const MODES: ReadonlyArray<{ value: DictationMode; label: string }> = [
  { value: 'verbatim', label: 'Verbatim' },
  { value: 'cleaned', label: 'Cleaned' },
]

/**
 * Home: whether dictation is ready or what stands in its way, the two things changed
 * most often (the mode and the microphone), the gestures, and the last few dictations.
 *
 * The status line and the two controls stay in place; the rest scrolls under them
 * when the window is small or its text is large.
 */
export function Home(props: {
  status: AppStatus
  onChanged: () => void
  onPage: (page: HubPage) => void
  onOpen: (id: string) => void
}) {
  const { status, onChanged } = props
  const key = dictationKeyLabel(status.dictationKey)
  const top = homeStatus(status, key)
  /** Asks for a change, then reads the status again, which says whether it was made. */
  const change = (asked: Promise<unknown>): void => whenSettled(asked, onChanged)

  const setMode = (mode: DictationMode): void => change(window.flowHub.setMode(mode))
  const chooseMicrophone = (value: string): void =>
    change(window.flowHub.chooseMicrophone(value === SYSTEM_DEFAULT ? null : value))
  const run = (action: HomeAction): void => change(ACTIONS[action]())

  const mode = <Segmented label="Mode" value={status.mode} options={MODES} onChange={setMode} />
  const microphone = (
    <PopUp
      label="Microphone"
      value={status.microphoneInUse ?? SYSTEM_DEFAULT}
      options={microphoneOptions(status)}
      onChange={chooseMicrophone}
    />
  )
  // Cleaned is using the rules only because Ollama is not running, and it is there to be started.
  const canStartOllama =
    status.mode === 'cleaned' &&
    status.ollamaInstalled &&
    status.cleanup.includes('Ollama is not running')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex-none px-11 pt-[46px] compact:flex compact:flex-col compact:gap-3.5 compact:border-b compact:border-line compact:px-7 compact:pt-[22px] compact:pb-3.5">
        {/* There from the start, so that a change of it is read out, and apart from the line
            drawn below, whose figures change at every look. */}
        <p className="only-spoken" aria-live="polite">
          {top.spoken}
        </p>
        <StatusLine status={top} keyLabel={key} onAction={run} />

        <div className="mt-[26px] border-t border-line compact:hidden">
          <Row label="Mode">
            {mode}
            <Caption>{modeCaption(status.mode, status.cleanup)}</Caption>
            {canStartOllama && (
              <LinkButton onClick={() => change(window.flowHub.startOllama())}>
                Start Ollama
              </LinkButton>
            )}
          </Row>
          <Row label="Microphone">
            {microphone}
            <Caption>{microphoneCaption(status)}</Caption>
          </Row>
        </div>
        {/* The same two controls on one line. They name themselves, so the captions go. */}
        <div className="hidden flex-wrap items-center gap-3 compact:flex">
          <Segmented label="Mode" value={status.mode} options={MODES} onChange={setMode} compact />
          {microphone}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-11 pb-6 compact:px-7 compact:pb-4">
        <div className="mt-[26px] flex items-baseline justify-between compact:mt-5">
          <h2 className="text-heading">Gestures</h2>
          {status.helper.accessibilityTrusted !== true && (
            <Caption>They work once Accessibility is on.</Caption>
          )}
        </div>
        {/* Text, not stops: the keyboard passes over them. */}
        <ul className="mt-1.5 grid flex-none grid-cols-2 gap-x-8 compact:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] compact:gap-x-6">
          {gestures(status.dictationKey).map((gesture) => (
            <li
              key={gesture.does}
              className="flex items-center gap-3 border-b border-line py-[9px] compact:gap-2.5"
            >
              <span className="flex w-[84px] flex-none compact:w-[78px]">
                <Keys caps={gesture.keys} />
              </span>
              <span>{gesture.does}</span>
            </li>
          ))}
        </ul>

        <div className="mt-[26px] flex items-baseline justify-between compact:mt-[22px]">
          <h2 className="text-heading">Recent</h2>
          <LinkButton onClick={() => props.onPage('history')}>Show all in History</LinkButton>
        </div>
        <Recent status={status} onOpen={props.onOpen} />

        <div className="min-h-5 flex-1" />
        <Figures status={status} />
      </div>
    </div>
  )
}

/** What each button under the status line asks the app to do. */
const ACTIONS: Record<HomeAction, () => Promise<unknown>> = {
  accessibility: () => window.flowHub.requestAccessibility(),
  microphone: () => window.flowHub.requestMicrophone(),
  download: () => window.flowHub.downloadModel(),
  tryAgain: () => window.flowHub.downloadModel(),
  cancel: () => window.flowHub.cancelDownload(),
  checkFiles: () => window.flowHub.repairModel(),
  resume: () => window.flowHub.resumeDictation(),
  otherKey: () => window.flowHub.changePreference({ dictationKey: 'ctrlOption' }),
}

/**
 * The line that says whether dictation is ready, or the one thing that stands in its
 * way. When there is a button, that button is the first stop in the page. A screen
 * reader is told of a change by the line above it, which only it hears.
 */
function StatusLine(props: {
  status: HomeStatus
  keyLabel: string
  onAction: (action: HomeAction) => void
}) {
  const { status } = props
  if (status.ready) {
    return (
      <div>
        <h1 className="flex flex-wrap items-center gap-2.5 text-status compact:gap-2 compact:text-status-compact">
          <span>Ready. Hold</span>
          {/* One keycap, in the size that suits the window. Only the one that is drawn is read out. */}
          <span className="inline-flex compact:hidden">
            <Keys caps={[props.keyLabel]} size="large" />
          </span>
          <span className="hidden compact:inline-flex">
            <Keys caps={[props.keyLabel]} size="medium" />
          </span>
          <span>to dictate</span>
        </h1>
        <p className="mt-2 text-caption text-ink-2 compact:hidden">Everything runs on this Mac.</p>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-3.5">
      {status.needsUser && <AttentionIcon />}
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="text-status compact:text-status-compact">{status.title}</h1>
        {status.detail && (
          <p className="max-w-[520px] leading-normal text-pretty text-ink-2">{status.detail}</p>
        )}
        {status.progress !== null && <ProgressBar value={status.progress} label={DOWNLOAD_NAME} />}
        {status.problem && <p className="max-w-[520px] text-problem">{status.problem}</p>}
        {status.action && (
          <div className="mt-1.5">
            <Button
              prominent={status.needsUser}
              onClick={() => status.action && props.onAction(status.action.does)}
            >
              {status.action.label}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

/** One setting: what it is, the control, and a sentence on what the choice means. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)] items-center border-b border-line py-[13px]">
      <span className="text-ink-2">{label}</span>
      <div className="flex flex-wrap items-center gap-3.5">{children}</div>
    </div>
  )
}

function Caption({ children }: { children: ReactNode }) {
  return <span className="text-caption text-ink-2">{children}</span>
}

/** The last few dictations, as the History page lists them. Return, or a click, opens one there. */
function Recent({ status, onOpen }: { status: AppStatus; onOpen: (id: string) => void }) {
  if (status.recent.length === 0) {
    return (
      <p className="mt-1 flex h-10 flex-none items-center border-b border-line text-ink-2">
        {status.history.paused
          ? 'History is paused: new dictations are not listed.'
          : 'Nothing yet. The last few dictations are listed here.'}
      </p>
    )
  }
  return (
    <ul className="mt-1 flex-none" aria-label="Recent dictations">
      {status.recent.map((row) => {
        const view = rowView(row, status.mode)
        return (
          <li key={row.id} className="border-b border-line">
            <button
              type="button"
              data-row={row.id}
              title="Opens in History"
              onClick={() => onOpen(row.id)}
              className={`grid h-10 w-full items-center gap-3 rounded-control text-left hover:bg-row-hover ${ROW_COLUMNS}`}
            >
              <DictationRow row={view} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** How much has been dictated, and the promise that goes with counting it. */
function Figures({ status }: { status: AppStatus }) {
  const list = figures(status.usage)
  const line = (short: boolean): ReactNode =>
    list.map((figure, index) => (
      <span key={index}>
        {index > 0 && ' · '}
        {figure.before}
        <span className="font-medium text-ink">{figure.number}</span>
        {short ? figure.afterShort : figure.after}
      </span>
    ))
  return (
    // Side by side where there is room; otherwise the promise goes under the figures.
    <div className="flex flex-none flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-t border-line pt-3 text-caption whitespace-nowrap text-ink-2">
      <span className="compact:hidden">{line(false)}</span>
      <span className="hidden compact:inline">{line(true)}</span>
      <span>Counted on this Mac. Never sent anywhere.</span>
    </div>
  )
}
