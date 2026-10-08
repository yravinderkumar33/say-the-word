import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { spokenKeys } from '@shared/keycodes'
import type { ChipIcon, ModeGlyph } from './history-view'
import { GLYPH_TITLES } from './history-view'

/**
 * The small set of parts the window is built from. Each takes its colours and sizes
 * from the tokens, so it looks right in both appearances without saying so itself.
 */

// --- Keys ------------------------------------------------------------------------------

type KeycapSize = 'tiny' | 'small' | 'medium' | 'large'
const KEYCAP =
  'inline-flex flex-none items-center justify-center box-border border border-keycap-edge ' +
  'border-b-keycap-base bg-keycap font-sans not-italic text-ink'
const KEYCAP_SIZE: Record<KeycapSize, string> = {
  tiny: 'h-[19px] min-w-5 rounded-[4px] border-b-2 px-[5px] text-key',
  small: 'h-[22px] min-w-[22px] rounded-key border-b-2 px-1.5 text-key',
  medium: 'h-[26px] min-w-[30px] rounded-control border-b-2 px-[7px] text-[13px]/none font-medium',
  large: 'h-8 min-w-9 rounded-segment border-b-[2.5px] px-2 text-[15px]/none font-medium',
}

/**
 * A key, or a few keys pressed together, as they are printed on the keyboard. A screen
 * reader is told their names in words: it would read `Fn` letter by letter and `⌘⌃V`
 * as three signs.
 */
export function Keys({
  caps,
  size = 'small',
  className = '',
}: {
  caps: readonly string[]
  size?: KeycapSize
  className?: string
}) {
  return (
    <span
      role="img"
      aria-label={spokenKeys(caps)}
      className={`inline-flex flex-none gap-1 ${className}`}
    >
      {caps.map((cap, index) => (
        <kbd key={index} aria-hidden="true" className={`${KEYCAP} ${KEYCAP_SIZE[size]}`}>
          {cap}
        </kbd>
      ))}
    </span>
  )
}

// --- Buttons ---------------------------------------------------------------------------

/** `prominent` is the one fix button on a page. There is never more than one. */
export function Button(props: {
  onClick: () => void
  children: ReactNode
  prominent?: boolean
  small?: boolean
  disabled?: boolean
  /** The words in the colour for problems: a button that deletes everything. */
  danger?: boolean
  label?: string
}) {
  const size = props.small ? 'h-[22px] px-2.5 text-caption' : 'h-6 px-3'
  const look = props.prominent
    ? 'bg-prominent text-on-prominent'
    : `bg-control shadow-control ${props.danger ? 'text-problem' : 'text-ink'}`
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      aria-label={props.label}
      className={`inline-flex flex-none items-center gap-1.5 rounded-control font-medium whitespace-nowrap disabled:opacity-40 ${size} ${look}`}
    >
      {props.children}
    </button>
  )
}

/** How long a button says what it did ("Copied") before it says again what it does. */
const SAID_FOR_MS = 1_500

/**
 * Says for a moment that something was done, where the button that did it is. `said`
 * is what was done until the time is up; doing it again gives it the whole time again.
 */
export function useSaidForAMoment(): { said: string | null; say: (what: string) => void } {
  const [said, setSaid] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const say = useCallback((what: string) => {
    clearTimeout(timer.current)
    setSaid(what)
    timer.current = setTimeout(() => setSaid(null), SAID_FOR_MS)
  }, [])
  return { said, say }
}

/** Words that are a link: quiet, underlined, and reachable with the keyboard. */
export function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[3px] text-caption text-ink-2 underline underline-offset-2"
    >
      {children}
    </button>
  )
}

/**
 * The arrow keys in a group of which one is chosen (`role="radiogroup"`): they move the
 * keyboard to the next option and choose it, as a radio group of the system does.
 *
 * The keyboard goes with the choice. Left on the option that is no longer chosen, it
 * would be where Tab cannot come back to, and the next arrow would start from the wrong
 * place: of two options, it could never get back to the first.
 */
export function radioKeys(event: KeyboardEvent<HTMLElement>): void {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
  const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
  if (!forward && !back) return
  const options = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]:not(:disabled)'),
  ]
  const at = options.indexOf(event.target as HTMLElement)
  if (at === -1) return
  event.preventDefault()
  const next = options[(at + (forward ? 1 : -1) + options.length) % options.length]
  next?.focus()
  next?.click()
}

/** One of a few, of which exactly one is chosen. The arrow keys move the choice, as in a radio group. */
export function Segmented<Value extends string>(props: {
  label: string
  value: Value
  options: ReadonlyArray<{ value: Value; label: string }>
  onChange: (value: Value) => void
  compact?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      className="inline-flex flex-none rounded-segment bg-fill p-0.5"
      onKeyDown={radioKeys}
    >
      {props.options.map((option) => {
        const chosen = option.value === props.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            onClick={() => props.onChange(option.value)}
            className={
              `rounded-[5px] whitespace-nowrap ${props.compact ? 'px-3 py-[3px]' : 'px-4 py-1'} ` +
              (chosen ? 'bg-segment-on font-medium shadow-segment' : '')
            }
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/** A pop-up button: one choice shown, the others in the system's own menu. */
export function PopUp(props: {
  label: string
  value: string
  options: ReadonlyArray<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  return (
    <span className="relative inline-flex min-w-0 flex-none">
      <select
        aria-label={props.label}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="h-6 max-w-64 appearance-none truncate rounded-control bg-control pr-[26px] pl-2.5 text-ink shadow-control"
      >
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <svg
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-ink-2"
        width="8"
        height="12"
        viewBox="0 0 8 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M1.5 4.5 4 2l2.5 2.5M1.5 7.5 4 10l2.5-2.5" />
      </svg>
    </span>
  )
}

/**
 * A switch. On is told by where the knob is and by the filled track, never by a
 * colour of its own: it takes the ink colour.
 */
export function Toggle(props: {
  label: string
  on: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={props.label}
      aria-checked={props.on}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.on)}
      className={`relative h-[18px] w-[30px] flex-none rounded-full disabled:opacity-45 ${props.on ? 'bg-ink' : 'bg-fill-strong'}`}
    >
      <span
        className={`absolute top-0.5 size-3.5 rounded-full transition-[left] duration-[var(--dur-2)] ${
          props.on ? 'left-3.5 bg-bg' : 'left-0.5 bg-knob shadow-knob'
        }`}
      />
    </button>
  )
}

/** The mark of a choice among a few: a filled ring for the one chosen. */
export function RadioMark({ chosen }: { chosen: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`box-border size-4 flex-none rounded-full ${
        chosen ? 'border-[5px] border-ink' : 'border-[1.5px] border-fill-strong'
      }`}
    />
  )
}

/** A field to type in. */
export function Field(props: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Called once for each edit: when Return is pressed, or else when the field is left. */
  onCommit?: () => void
  mono?: boolean
  disabled?: boolean
  className?: string
  icon?: ReactNode
}) {
  // Return and then Tab would otherwise commit the same edit twice.
  const edited = useRef(false)
  const commit = (): void => {
    if (!edited.current) return
    edited.current = false
    props.onCommit?.()
  }
  return (
    <span
      className={`field flex h-[26px] min-w-0 items-center gap-[7px] rounded-control bg-field px-[9px] shadow-field ${props.disabled ? 'opacity-45' : ''} ${props.className ?? ''}`}
    >
      {props.icon}
      <input
        type="text"
        aria-label={props.label}
        value={props.value}
        placeholder={props.placeholder}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(event) => {
          edited.current = true
          props.onChange(event.target.value)
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
        }}
        className={`min-w-0 flex-1 bg-transparent outline-none ${props.mono ? 'font-mono text-[12px]' : ''}`}
      />
    </span>
  )
}

// --- Chips, tiles, glyphs --------------------------------------------------------------

const CHIP_ICONS: Record<ChipIcon, string> = {
  shield: 'M7 1.5 2.5 3.2v3.3c0 2.8 1.9 4.8 4.5 5.9 2.6-1.1 4.5-3.1 4.5-5.9V3.2z',
  minus: 'M7 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM4.6 7h4.8',
  copy: 'M5 5h6.5v7H5zM2.5 9.5V2h6',
  mute: 'M7 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM3.2 3.2l7.6 7.6',
}

/** How a dictation ended, when it did not end in a paste: an icon and words, never a colour alone. */
export function Chip({ icon, children }: { icon: ChipIcon; children: ReactNode }) {
  return (
    <span
      data-chip
      className="inline-flex h-5 flex-none items-center gap-[5px] rounded-[5px] bg-fill px-[7px] text-[11.5px] whitespace-nowrap text-ink-2 shadow-chip"
    >
      <svg
        width="11"
        height="11"
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={CHIP_ICONS[icon]} />
      </svg>
      {children}
    </span>
  )
}

const GLYPHS: Record<ModeGlyph, string> = {
  // Quotation marks: every word, as it was said.
  verbatim: 'M3 4.5h3v3L4.5 10M8.5 4.5h3v3L10 10',
  // Lines with a tick: tidied, by the rules.
  rules: 'M2.5 4h9M2.5 7h6M2.5 10h3.5M9.5 9.2l1.3 1.3 2-2.5',
  cleaned: 'M2.5 4h9M2.5 7h7M2.5 10h4',
}

/** The mode a dictation ran in, shown only when it was not the usual one. */
export function ModeMark({ glyph }: { glyph: ModeGlyph }) {
  return (
    <svg
      className="flex-none text-ink-2"
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={GLYPH_TITLES[glyph]}
    >
      <title>{GLYPH_TITLES[glyph]}</title>
      <path d={GLYPHS[glyph]} />
    </svg>
  )
}

/** Stands for an app: a neutral tile with its initial. Empty when the app was never read. */
export function AppTile({ name, large = false }: { name: string | null; large?: boolean }) {
  return (
    <span
      className={`grid flex-none place-items-center bg-app-tile font-semibold text-app-tile-ink ${
        large ? 'size-[30px] rounded-segment text-[14px]' : 'size-5 rounded-[5px] text-[11px]'
      }`}
      title={name ?? undefined}
      role="img"
      aria-label={name ?? 'An app that was not read'}
    >
      {name?.trim().charAt(0).toUpperCase() ?? ''}
    </span>
  )
}

// --- Bars, notices, cards --------------------------------------------------------------

/**
 * Shown on every page for as long as dictations are being written to disk. It is the
 * one setting that keeps the recordings of what was said, so it is said in words, with
 * the way to end it. Amber is used for nothing but saving.
 */
export function SavingBar({
  onStop,
  besideWindowButtons = false,
}: {
  onStop: () => void
  /**
   * Across the whole top of the window, as in the first run: it starts to the right of the
   * close, minimise and zoom buttons, which are drawn over that corner.
   */
  besideWindowButtons?: boolean
}) {
  return (
    <div
      role="status"
      // Above the strip that drags the window, which lies over the top of every page:
      // under it, the button could not be clicked.
      className={`relative z-10 flex min-h-[38px] flex-none items-center gap-2.5 border-b border-saving-line bg-saving-bg pr-3 text-saving ${besideWindowButtons ? 'pl-[84px]' : 'pl-4'}`}
    >
      <Icon size={16} strokeWidth={1.5} d={ICONS.save} />
      <span className="flex-1 font-semibold">Every dictation is being saved</span>
      <Button onClick={onStop}>Stop Saving</Button>
    </div>
  )
}

/** Something went wrong, or needs saying: a card with a triangle, a few words, and what can be done. */
export function Notice(props: {
  /** For tests: which notice this is. */
  name: string
  title: string
  children?: ReactNode
  actions?: ReactNode
  /** An icon of its own, in place of the triangle. */
  icon?: ReactNode
}) {
  return (
    <div
      data-notice={props.name}
      className="flex items-start gap-3 rounded-card bg-card px-3.5 py-3 shadow-outline"
    >
      {props.icon ?? <ProblemIcon size={18} />}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="font-semibold">{props.title}</span>
        {props.children && <span className="text-pretty text-ink-2">{props.children}</span>}
      </div>
      {props.actions && <div className="flex flex-none items-center gap-2">{props.actions}</div>}
    </div>
  )
}

/** The mark of a problem: a triangle, in the colour for problems. Words always go with it. */
export function ProblemIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      className="mt-px flex-none text-problem"
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 1.6 12.9 12.2H1.1z" />
      <path d="M7 5.6v3" />
      <circle cx="7" cy="10.3" r="0.6" fill="currentColor" />
    </svg>
  )
}

/** A line icon on a 16 px grid, drawn for this app. It takes the colour of the words beside it. */
export function Icon(props: {
  d: string
  size?: number
  strokeWidth?: number
  className?: string
  viewBox?: number
}) {
  const size = props.size ?? 16
  const box = props.viewBox ?? 16
  return (
    <svg
      className={`flex-none ${props.className ?? ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      fill="none"
      stroke="currentColor"
      strokeWidth={props.strokeWidth ?? 1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={props.d} />
    </svg>
  )
}

/** The outlines of the icons that appear in more than one place. */
export const ICONS = {
  save: 'M8 2.5v7M5 6.8 8 9.8l3-3 M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2',
  cup: 'M3 6h8v3.5a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM11 7h1a1.5 1.5 0 0 1 0 3h-1M5.5 2.5V4M8 2.5V4',
  tick: 'M3.5 8.4 6.5 11l6-6.5',
  search: 'M6.8 2.3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zM10.2 10.2l3.5 3.5',
  chip: 'M3.5 3.5h9v9h-9zM6 6h4v4H6zM6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2',
  pause: 'M8 2a6 6 0 1 1 0 12A6 6 0 0 1 8 2zM6.5 5.6v4.8M9.5 5.6v4.8',
  info: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM8 7.3v3.7M8 5.2v.1',
  out: 'M6 3.5h6.5V10M12.5 3.5 4 12',
  back: 'M10 3 5 8l5 5',
  plus: 'M8 2v12M2 8h12',
  absent: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM5.5 8h5',
  stopped: 'M8 2.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zM6.5 5.8v4.4M9.5 5.8v4.4',
} as const

/** Something that needs the user: a circle with an exclamation mark, in the colour for problems. */
export function AttentionIcon({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="mt-0.5 flex-none text-problem"
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="14" cy="14" r="12" stroke="currentColor" strokeWidth="2.2" />
      <path d="M14 8v7.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="14" cy="19.6" r="1.5" fill="currentColor" />
    </svg>
  )
}

/** A filled disc with a tick: done. An empty ring: still to do. */
export function DoneMark({ done, size = 18 }: { done: boolean; size?: number }) {
  if (!done) {
    return (
      <span
        aria-hidden="true"
        className="box-border flex-none rounded-full border-[1.5px] border-fill-strong"
        style={{ width: size, height: size }}
      />
    )
  }
  return (
    <span
      aria-hidden="true"
      className="grid flex-none place-items-center rounded-full bg-ink text-bg"
      style={{ width: size, height: size }}
    >
      <svg
        width={size * 0.62}
        height={size * 0.62}
        viewBox="0 0 14 14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.8 7.3 5.6 10l5.6-6" />
      </svg>
    </span>
  )
}

/** How far something has got, from 0 to 1. `label` is what a screen reader calls it. */
export function ProgressBar({
  value,
  label,
  slim = false,
}: {
  value: number
  label: string
  slim?: boolean
}) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className={`w-full overflow-hidden rounded-full bg-fill-strong ${slim ? 'h-1' : 'h-1.5 max-w-[520px]'}`}
    >
      <div
        className="h-full rounded-full bg-ink transition-[width] duration-[var(--dur-3)]"
        style={{ width: `${Math.min(1, Math.max(0, value)) * 100}%` }}
      />
    </div>
  )
}

/**
 * A level meter: segments that light with the sound. Green, because this is the one
 * place besides the pill where audio is being captured, and words beside it say the
 * same: a screen reader is given "Hearing you" or "Silent", not the segments.
 */
export function Meter(props: { level: number; segments: number; wide?: boolean; says: string }) {
  const lit = Math.round(Math.min(1, Math.max(0, props.level)) * props.segments)
  return (
    <div
      role="meter"
      aria-label="Microphone level"
      aria-valuetext={props.says}
      aria-valuenow={lit}
      aria-valuemin={0}
      aria-valuemax={props.segments}
      className="flex flex-none items-center gap-0.5"
    >
      {Array.from({ length: props.segments }, (_, index) => (
        <span
          key={index}
          className={`rounded-[2px] ${props.wide ? 'h-4 w-1.5' : 'h-3 w-1 rounded-[1.5px]'} ${index < lit ? 'bg-live' : 'bg-meter-idle'}`}
        />
      ))}
    </div>
  )
}

/** The app's icon: the pill as an object, its bars at the heights they have while listening. */
export function AppIcon({ size }: { size: number }) {
  return (
    <svg
      className="flex-none"
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
    >
      <rect x="100" y="100" width="824" height="824" rx="185" fill="#1c1c1e" />
      <rect
        x="102"
        y="102"
        width="820"
        height="820"
        rx="183"
        fill="none"
        stroke="rgb(255 255 255 / 0.14)"
        strokeWidth="4"
      />
      <rect x="232" y="392" width="560" height="240" rx="120" fill="#34343a" />
      {[
        [338, 480, 64],
        [414, 448, 128],
        [490, 420, 184],
        [566, 456, 112],
        [642, 484, 56],
      ].map(([x, y, height]) => (
        <rect key={x} x={x} y={y} width="44" height={height} rx="22" fill="#3ddc84" />
      ))}
    </svg>
  )
}

// --- Page furniture --------------------------------------------------------------------

/** A page's name, at its top. */
export function PageTitle({ children }: { children: ReactNode }) {
  return <h1 className="text-title">{children}</h1>
}

/** One row of a list of settings: what it is on the left, the control on the right. */
export function SettingRow(props: {
  label: ReactNode
  hint?: ReactNode
  children?: ReactNode
  tall?: boolean
}) {
  return (
    <div
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-line ${props.tall ? 'min-h-14 py-2' : 'min-h-10 py-1.5'}`}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span>{props.label}</span>
        {props.hint && <span className="text-caption text-pretty text-ink-2">{props.hint}</span>}
      </span>
      {props.children}
    </div>
  )
}

/** A named group of settings. */
export function Section(props: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id={id} className="text-section">
          {props.title}
        </h2>
        {props.aside && (
          <span className="text-caption whitespace-nowrap text-ink-2">{props.aside}</span>
        )}
      </div>
      <div className="flex flex-col border-t border-line">{props.children}</div>
    </section>
  )
}
