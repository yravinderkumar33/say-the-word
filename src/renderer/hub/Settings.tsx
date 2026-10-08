import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { AppStatus, PreferencePatch } from '@shared/ipc'
import { DICTATION_KEYS, dictationKeyLabel, type DictationKey } from '@shared/keycodes'
import { CUE_NAMES, playCue } from '../overlay/sounds'
import { whenSettled } from './answers'
import {
  Button,
  Field,
  Keys,
  LinkButton,
  Meter,
  PageTitle,
  ProblemIcon,
  RadioMark,
  Section,
  Segmented,
  SettingRow,
  Toggle,
  radioKeys,
  useSaidForAMoment,
} from './components'
import { bytes } from './format'
import { TEST_MS, useMicTest, type MicTest } from './mic-test'
import {
  ADDRESS_NOT_SAVED,
  MODEL_KEEPS,
  microphoneRows,
  modelState,
  moved,
  shortcutRows,
  type MicrophoneRow,
} from './settings-view'

/** How long after an arrow key a change of the microphones' order is taken to be that key's doing. */
const CARRY_FOCUS_FOR_MS = 2_000

/**
 * Settings: one page that scrolls, under plain headings. Every switch and chosen
 * option takes the ink colour; green appears only on the microphone test's meter,
 * because that is the one place here where audio is captured.
 */
export function Settings({ status, onChanged }: { status: AppStatus; onChanged: () => void }) {
  const prefs = status.preferences
  /** Asks for a change, then reads the status again, which says whether it was made. */
  const change = (patch: PreferencePatch): void =>
    whenSettled(window.flowHub.changePreference(patch), onChanged)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[30px] overflow-y-auto px-8 py-10 compact:px-6 compact:pt-6">
      <PageTitle>Settings</PageTitle>
      <Shortcuts status={status} onKey={(dictationKey) => change({ dictationKey })} />
      <Microphones status={status} onChanged={onChanged} />

      <Section title="Sounds">
        <SettingRow label="Play sounds">
          <Toggle label="Play sounds" on={prefs.sounds} onChange={(sounds) => change({ sounds })} />
        </SettingRow>
        <Volume
          value={prefs.soundVolume}
          onCommit={(soundVolume) =>
            window.flowHub.changePreference({ soundVolume }).finally(onChanged)
          }
        />
        <div className="grid grid-cols-5 gap-2 border-b border-line py-3 compact:grid-cols-3">
          {CUE_NAMES.map(({ cue, name }) => (
            <button
              key={cue}
              type="button"
              aria-label={`Play “${name}”`}
              onClick={() => playCue(cue, prefs.soundVolume)}
              className="flex h-[30px] items-center gap-2 rounded-control bg-card pr-2.5 pl-1.5"
            >
              <span className="grid size-5 flex-none place-items-center rounded-full bg-control shadow-control">
                <svg width="8" height="9" viewBox="0 0 8 9" fill="currentColor" aria-hidden="true">
                  <path d="M1 0.8v7.4L7.4 4.5z" />
                </svg>
              </span>
              <span className="text-caption whitespace-nowrap">{name}</span>
            </button>
          ))}
        </div>
      </Section>

      <div className="grid grid-cols-2 gap-7">
        <Section title="Pill">
          <div
            role="radiogroup"
            aria-label="When the pill is shown"
            className="flex flex-col"
            onKeyDown={radioKeys}
          >
            <PillChoice
              label="Show it at rest"
              chosen={prefs.pillAtRest}
              onChoose={() => change({ pillAtRest: true })}
            />
            <PillChoice
              label="Show it only while dictating"
              chosen={!prefs.pillAtRest}
              onChoose={() => change({ pillAtRest: false })}
            />
          </div>
        </Section>
        <Section title="General">
          <SettingRow
            label="Open at login"
            hint={prefs.openAtLogin === null ? 'In the installed app only.' : undefined}
          >
            <Toggle
              label="Open at login"
              on={prefs.openAtLogin === true}
              disabled={prefs.openAtLogin === null}
              onChange={(on) => void window.flowHub.setOpenAtLogin(on).then(onChanged, onChanged)}
            />
          </SettingRow>
          <SettingRow label="Show in Dock">
            <Toggle
              label="Show in Dock"
              on={prefs.showInDock}
              onChange={(showInDock) => change({ showInDock })}
            />
          </SettingRow>
        </Section>
      </div>

      <SpeechModel status={status} onKeep={(modelKeep) => change({ modelKeep })} />
      <Advanced status={status} onChanged={onChanged} />
    </div>
  )
}

function Shortcuts({ status, onKey }: { status: AppStatus; onKey: (key: DictationKey) => void }) {
  const key = dictationKeyLabel(status.dictationKey)
  return (
    <Section title="Shortcuts">
      {shortcutRows(status.dictationKey).map((row) => (
        <div key={row.label} className="flex flex-col gap-1.5 border-b border-line py-[9px]">
          <div className="grid grid-cols-[minmax(0,1fr)_200px] items-center gap-3">
            <span>{row.label}</span>
            {/* The pop-up inside is not drawn, so the ring that shows the keyboard's place goes round the whole control. */}
            <div className="field relative flex h-[26px] items-center gap-1 rounded-control bg-field pr-1 pl-2 shadow-field">
              <span className="flex flex-1">
                <Keys caps={row.caps} size="tiny" />
              </span>
              {row.changeable && (
                <>
                  <span className="px-1 text-caption text-ink-2" aria-hidden="true">
                    Change
                  </span>
                  {/* The system's own menu, over the whole control: the two keys there are to choose from. */}
                  <select
                    aria-label="Dictation key"
                    value={status.dictationKey}
                    onChange={(event) => onKey(event.target.value as DictationKey)}
                    className="absolute inset-0 appearance-none rounded-control opacity-0"
                  >
                    {DICTATION_KEYS.map((option) => (
                      <option key={option} value={option}>
                        {option === 'fn'
                          ? 'Fn (the key with the globe)'
                          : '⌃⌥ (Control and Option)'}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>
          {row.changeable && status.conflict && (
            <p className="flex items-center justify-end gap-[7px] text-caption">
              <ProblemIcon size={13} />
              {status.conflict} is running and also listens to {key}. Choose ⌃⌥, or quit it.
            </p>
          )}
        </div>
      ))}
      <p className="pt-2 text-caption text-ink-2">
        The dictation key can be changed. The other shortcuts are fixed for now.
      </p>
    </Section>
  )
}

/**
 * The microphones, in the order they are tried. A row is dragged to its place, or
 * moved with the arrow keys from its handle. Test runs a meter on that row for ten
 * seconds, then lets the microphone go.
 */
function Microphones({ status, onChanged }: { status: AppStatus; onChanged: () => void }) {
  const rows = microphoneRows(status)
  const ranked = status.microphoneOrder.length > 0
  const mic = useMicTest()
  const [dragged, setDragged] = useState<number | null>(null)
  const reorder = (from: number, to: number): void => {
    if (from === to || to < 0 || to >= rows.length) return
    const order = moved(rows, from, to).map((row) => row.deviceId)
    void window.flowHub.setMicrophoneOrder(order).then(onChanged, onChanged)
  }
  // A row moved with the arrow keys takes the keyboard with it. The page moves the row
  // when the new order comes back, and a control that is moved lets the keyboard go.
  const carried = useRef<{ deviceId: string; at: number } | null>(null)
  const order = rows.map((row) => row.deviceId).join('\n')
  useEffect(() => {
    const row = carried.current
    carried.current = null
    // Only for the move just made: an order that changes later is not this key's doing.
    if (!row || performance.now() - row.at > CARRY_FOCUS_FOR_MS) return
    for (const handle of document.querySelectorAll<HTMLElement>('[data-handle]')) {
      if (handle.dataset['handle'] === row.deviceId) handle.focus()
    }
  }, [order])

  return (
    <Section
      title="Microphone"
      aside={
        ranked
          ? 'First connected is used · drag to reorder'
          : 'The system default is used · drag to set an order'
      }
    >
      {rows.length === 0 && (
        <p className="border-b border-line py-3 text-ink-2">
          The microphones are listed here once the microphone has been allowed.
        </p>
      )}
      {rows.map((row, index) => (
        <div
          key={row.deviceId}
          data-microphone={index + 1}
          draggable
          onDragStart={() => setDragged(index)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            if (dragged !== null) reorder(dragged, index)
            setDragged(null)
          }}
          onDragEnd={() => setDragged(null)}
          className={`grid min-h-[42px] grid-cols-[16px_18px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-line ${dragged === index ? 'opacity-50' : ''}`}
        >
          <button
            type="button"
            data-handle={row.deviceId}
            aria-label={`Move ${row.name}, number ${index + 1} of ${rows.length}. Up and down arrows move it`}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              carried.current = { deviceId: row.deviceId, at: performance.now() }
              reorder(index, index + (event.key === 'ArrowUp' ? -1 : 1))
            }}
            className="grid h-6 place-items-center rounded-[3px] text-ink-2"
          >
            <svg width="10" height="12" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true">
              {[2.5, 6, 9.5].flatMap((y) =>
                [3, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />),
              )}
            </svg>
          </button>
          <span className="text-caption text-ink-2 tabular-nums">{ranked ? index + 1 : ''}</span>
          <span className="flex min-w-0 flex-col gap-px">
            <span className={`truncate ${row.connected ? '' : 'text-ink-2'}`}>{row.name}</span>
            {(row.inUse || !row.connected) && (
              <span className="text-caption text-ink-2">
                {row.connected ? 'In use' : 'Not connected'}
              </span>
            )}
          </span>
          <MicrophoneTest row={row} mic={mic} />
        </div>
      ))}
      <p className="flex flex-wrap items-baseline gap-x-3 pt-2 text-caption text-ink-2">
        <span>
          Test listens for ten seconds, then lets the microphone go. No meter runs merely because
          this page is open.
        </span>
        {ranked && (
          <LinkButton
            onClick={() => void window.flowHub.setMicrophoneOrder([]).then(onChanged, onChanged)}
          >
            Follow the system default
          </LinkButton>
        )}
      </p>
    </Section>
  )
}

function MicrophoneTest({ row, mic }: { row: MicrophoneRow; mic: MicTest }) {
  if (mic.testing !== row.deviceId) {
    // A test that could not open the microphone says so here, where it was asked for.
    const problem = mic.failed === row.deviceId ? mic.problem : null
    return (
      <span className="flex items-center gap-2.5">
        {problem && (
          <span role="status" className="flex items-center gap-1.5 text-caption whitespace-nowrap">
            <ProblemIcon size={12} />
            {problem}
          </span>
        )}
        <Button small disabled={!row.connected} onClick={() => mic.start(row.deviceId, TEST_MS)}>
          Test
        </Button>
      </span>
    )
  }
  // In words as well as in green: the meter alone would say it by colour only.
  const says = mic.sound ? 'Hearing you' : 'Silent'
  return (
    <span className="flex items-center gap-2.5">
      <Meter level={mic.level} segments={20} says={says} />
      <span className="text-caption whitespace-nowrap text-ink-2 tabular-nums">
        {says} · {mic.secondsLeft ?? 0} s
      </span>
      <Button small onClick={mic.stop}>
        Stop
      </Button>
    </span>
  )
}

/** The volume of the cues. It is tried as it is dragged, and saved when it is let go. */
export function Volume({
  value,
  onCommit,
}: {
  value: number
  onCommit: (value: number) => Promise<{ ok: boolean; appliedVolume?: number }>
}) {
  const [shown, setShown] = useState(value)
  const draft = useRef(0)
  const editing = useRef(false)
  const pending = useRef<{ value: number; revision: number } | null>(null)
  useEffect(() => {
    if (!editing.current && !pending.current) setShown(value)
  }, [value])
  const commit = (): void => {
    editing.current = false
    const revision = draft.current
    if (pending.current?.revision === revision || (shown === value && !pending.current)) return
    pending.current = { value: shown, revision }
    void onCommit(shown)
      .then(
        (result) => {
          if (draft.current === revision) setShown(result.appliedVolume ?? value)
        },
        () => {
          if (draft.current === revision) setShown(value)
        },
      )
      .finally(() => {
        if (pending.current?.revision === revision) pending.current = null
      })
  }
  return (
    <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_220px] items-center gap-3 border-b border-line">
      <span>Volume</span>
      <div className="flex items-center gap-2 text-ink-2">
        <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <path d="M2 5h2.5L8 2v10L4.5 9H2z" />
        </svg>
        <input
          type="range"
          aria-label="Volume"
          min={0}
          max={100}
          value={Math.round(shown * 100)}
          onChange={(event) => {
            editing.current = true
            draft.current++
            setShown(Number(event.target.value) / 100)
          }}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="flex-1"
          style={{ '--filled': `${Math.round(shown * 100)}%` } as CSSProperties}
        />
        <svg width="14" height="12" viewBox="0 0 16 14" fill="none" aria-hidden="true">
          <path d="M2 5h2.5L8 2v10L4.5 9H2z" fill="currentColor" />
          <path
            d="M10.5 4.5a3.5 3.5 0 0 1 0 5M12.5 2.5a6.3 6.3 0 0 1 0 9"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      </div>
    </div>
  )
}

function PillChoice(props: { label: string; chosen: boolean; onChoose: () => void }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.chosen}
      // One stop for Tab: the option chosen. The arrow keys reach the other.
      tabIndex={props.chosen ? 0 : -1}
      onClick={props.onChoose}
      className="flex min-h-10 items-center gap-2.5 border-b border-line text-left"
    >
      <RadioMark chosen={props.chosen} />
      {props.label}
    </button>
  )
}

function SpeechModel(props: {
  status: AppStatus
  onKeep: (keep: AppStatus['preferences']['modelKeep']) => void
}) {
  const { speech, preferences } = props.status
  const state = modelState(speech)
  return (
    <Section title="Speech model">
      <SettingRow
        tall
        label={<span className="font-medium">{speech.modelLabel}</span>}
        hint={`${bytes(speech.modelBytes)} · ${speech.modelLanguages} European languages · stored on this Mac`}
      >
        <span
          className="inline-flex items-center gap-1.5 text-caption"
          data-model-state={state.word}
        >
          <span
            aria-hidden="true"
            className={`box-border size-[7px] rounded-full ${state.loaded ? 'bg-ink' : 'border border-ink-2'}`}
          />
          {state.word}
        </span>
      </SettingRow>
      <SettingRow
        tall
        label="Keep it in memory"
        hint="About 1.9 GB while loaded. Loading again takes about a second."
      >
        <Segmented
          label="Keep the speech model in memory"
          value={preferences.modelKeep}
          options={MODEL_KEEPS}
          onChange={props.onKeep}
          compact
        />
      </SettingRow>
    </Section>
  )
}

function Advanced({ status, onChanged }: { status: AppStatus; onChanged: () => void }) {
  const [address, setAddress] = useState(status.preferences.ollamaUrl)
  const [problem, setProblem] = useState<string | null>(null)
  const { said: copied, say } = useSaidForAMoment()
  const saved = status.preferences.ollamaUrl
  // The address in force, whenever it changes: after a commit, as the setting has it.
  useEffect(() => setAddress(saved), [saved])

  const commit = (): void => {
    if (address.trim() === saved) return setProblem(null)
    void window.flowHub.changePreference({ ollamaUrl: address }).then(
      (result) => {
        setProblem(result.ok ? null : result.problem)
        onChanged()
      },
      () => {
        setProblem(ADDRESS_NOT_SAVED)
        onChanged()
      },
    )
  }
  const saving = status.savingDictations

  return (
    <Section title="Advanced">
      <SettingRow tall label="Log" hint="It never contains what you said.">
        <span className="flex gap-2">
          <Button onClick={() => void window.flowHub.showLog()}>Show Log</Button>
          <Button
            onClick={() =>
              // Not copied: the button does not say that it was.
              void window.flowHub.copyDiagnostics().then(
                () => say('diagnostics'),
                () => {},
              )
            }
          >
            {copied ? 'Copied' : 'Copy Diagnostics'}
          </Button>
        </span>
      </SettingRow>
      <SettingRow
        tall
        label="Ollama address"
        hint={problem ? <Problem>{problem}</Problem> : undefined}
      >
        <Field
          label="Ollama address"
          value={address}
          onChange={setAddress}
          onCommit={commit}
          mono
          className="w-60"
        />
      </SettingRow>
      <SettingRow
        tall
        label="Save every dictation (recording and text)"
        hint={
          saving
            ? 'On. Each recording and its text is written to a folder, to score the recognizer on your voice. It can be switched off here, or in the menu bar.'
            : 'Off. Writes each recording and its text to a folder, to score the recognizer on your voice. It can be switched on only from the menu bar: Advanced › Save Every Dictation.'
        }
      >
        <Toggle
          label="Save every dictation"
          on={saving}
          disabled={!saving}
          onChange={() => void window.flowHub.stopSavingDictations().then(onChanged, onChanged)}
        />
      </SettingRow>
      <SettingRow tall label="Setup guide" hint="The steps shown at the first launch.">
        <Button onClick={() => void window.flowHub.showFirstRunAgain().then(onChanged, onChanged)}>
          Show Again
        </Button>
      </SettingRow>
    </Section>
  )
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <span data-notice="setting-problem" className="flex items-center gap-1.5 text-ink">
      <ProblemIcon size={12} />
      {children}
    </span>
  )
}
