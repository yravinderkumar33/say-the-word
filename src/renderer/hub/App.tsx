import { useEffect, useState, type ReactNode } from 'react'
import type { AppStatus } from '@shared/ipc'

const POLL_MS = 1_500

/**
 * The setup window: the three things dictation needs (two permissions and the speech
 * model), each with its state and the one button that moves it forward. The full Hub
 * (onboarding, history, settings) arrives in Phase 6.
 */
export function App() {
  const { status, error } = useStatus()

  return (
    <main className="mx-auto flex max-w-xl flex-col gap-5 px-10 py-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Whisper Flow</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Hold <Key>Fn</Key>, speak, and release. The text is typed where your cursor is. Everything
          runs on this Mac.
        </p>
      </header>

      {error && <p className="text-sm text-red-600">Could not read status: {error}</p>}

      {status && (
        <>
          <Readiness status={status} />
          <ol className="flex flex-col gap-3">
            <AccessibilityStep status={status} />
            <MicrophoneStep status={status} />
            <ModelStep status={status} />
          </ol>
          <Details status={status} />
        </>
      )}
    </main>
  )
}

function useStatus(): { status: AppStatus | null; error: string | null } {
  const [status, setStatus] = useState<AppStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const refresh = (): void => {
      window.flowHub.getStatus().then(
        (next) => {
          if (cancelled) return
          setStatus(next)
          setError(null)
        },
        (reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
        },
      )
    }
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  return { status, error }
}

function isReady(status: AppStatus): boolean {
  return (
    status.helper.tapInstalled === true &&
    status.microphone === 'granted' &&
    status.speech.modelDownloaded &&
    status.speech.state !== 'failed' &&
    // The files are there but the app has not taken them in yet: not ready until it has.
    status.speech.state !== 'modelMissing'
  )
}

function Readiness({ status }: { status: AppStatus }) {
  if (isReady(status)) {
    return (
      <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
        Ready. Click into any text field, hold <Key>Fn</Key> and speak.
      </p>
    )
  }
  return (
    <p className="text-sm text-neutral-500">
      Three things are needed before the first dictation. Each is asked for once.
    </p>
  )
}

function AccessibilityStep({ status }: { status: AppStatus }) {
  const { helper } = status
  const done = helper.accessibilityTrusted === true
  return (
    <Step
      title="Accessibility"
      done={done}
      state={
        !helper.running ? 'Helper not running' : done ? stepDone(helper.tapInstalled) : 'Needed'
      }
      action={
        // The prompt is shown by the helper, so without it the button could do nothing.
        done || !helper.running ? null : (
          <Button onClick={() => void window.flowHub.requestAccessibility()}>
            Open the permission prompt
          </Button>
        )
      }
    >
      Lets Whisper Flow notice the <Key>Fn</Key> key and paste into the app you are using. It sees
      shortcut keys only, never what you type.
      {!status.packaged && <DevelopmentNote />}
    </Step>
  )
}

function stepDone(tapInstalled: boolean | null): string {
  return tapInstalled ? 'Granted, shortcuts active' : 'Granted, starting shortcuts…'
}

function MicrophoneStep({ status }: { status: AppStatus }) {
  const done = status.microphone === 'granted'
  const refused = status.microphone === 'denied' || status.microphone === 'restricted'
  return (
    <Step
      title="Microphone"
      done={done}
      state={done ? 'Granted' : refused ? 'Switched off' : 'Needed'}
      action={
        done ? null : (
          <Button onClick={() => void window.flowHub.requestMicrophone()}>
            {refused ? 'Open System Settings' : 'Allow the microphone'}
          </Button>
        )
      }
    >
      Used only while you hold the dictation key. Audio is turned into text on this Mac and is not
      stored.
      {!status.packaged && <DevelopmentNote />}
    </Step>
  )
}

function ModelStep({ status }: { status: AppStatus }) {
  const { speech } = status
  const megabytes = Math.round(speech.modelBytes / 1_000_000)
  const downloading = speech.downloadProgress !== null
  return (
    <Step
      title="Speech model"
      done={speech.modelDownloaded && speech.state !== 'modelMissing'}
      state={
        speech.modelDownloaded
          ? SPEECH_STATE[speech.state]
          : downloading
            ? `Downloading, ${Math.floor((speech.downloadProgress ?? 0) * 100)}%`
            : 'Not downloaded'
      }
      action={
        speech.modelDownloaded || downloading ? null : (
          <Button onClick={() => void window.flowHub.downloadModel()}>
            {speech.downloadError ? 'Try again' : `Download (${megabytes} MB)`}
          </Button>
        )
      }
    >
      {speech.modelLabel} turns speech into text. It is downloaded once; after that, dictation works
      without a network connection.
      {downloading && (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
          <div
            className="h-full rounded-full bg-neutral-900 transition-[width] duration-500 dark:bg-neutral-100"
            style={{ width: `${(speech.downloadProgress ?? 0) * 100}%` }}
          />
        </div>
      )}
      {speech.downloadError && (
        <span className="mt-2 block text-red-600">
          The download stopped: {speech.downloadError}. What was downloaded is kept.
        </span>
      )}
    </Step>
  )
}

const SPEECH_STATE: Record<AppStatus['speech']['state'], string> = {
  ready: 'Downloaded and loaded',
  // The model is unloaded after a while without dictation and loaded again when needed.
  stopped: 'Downloaded',
  loading: 'Loading…',
  // Shown only while the files are on disk and the app is about to take them in.
  modelMissing: 'Downloaded, loading…',
  failed: 'Could not start',
}

function Step(props: {
  title: string
  done: boolean
  state: string
  action: ReactNode
  children: ReactNode
}) {
  return (
    <li className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-semibold">
          <span
            aria-hidden="true"
            className={`mr-2 inline-block size-2 rounded-full align-middle ${
              props.done ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
          />
          {props.title}
        </h2>
        <span className="text-xs text-neutral-500 tabular-nums">{props.state}</span>
      </div>
      <div className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-400">
        {props.children}
      </div>
      {props.action && <div className="mt-3">{props.action}</div>}
    </li>
  )
}

function Button({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
    >
      {children}
    </button>
  )
}

function Key({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 font-sans text-[0.85em] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200">
      {children}
    </kbd>
  )
}

/** In development macOS attributes permissions to the terminal that started the app. */
function DevelopmentNote() {
  return (
    <span className="mt-2 block text-xs text-neutral-500">
      Development build: macOS asks on behalf of the terminal that started the app.
    </span>
  )
}

function Details({ status }: { status: AppStatus }) {
  const rows: Array<[string, string]> = [
    ['App version', status.versions.app],
    ['Build', status.packaged ? 'Packaged' : 'Development'],
    ['Runtime', `Electron ${status.versions.electron}, Node ${status.versions.node}`],
    [
      'Helper',
      status.helper.running
        ? `Running, protocol ${status.helper.protocol ?? 'unknown'}`
        : 'Not running',
    ],
    ['Speech engine', status.speech.engine ?? 'Not loaded'],
  ]
  return (
    <details className="text-sm text-neutral-500">
      <summary className="cursor-default select-none">Details</summary>
      <dl className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-6 px-4 py-2.5">
            <dt>{label}</dt>
            <dd className="font-medium text-neutral-800 tabular-nums dark:text-neutral-200">
              {value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
