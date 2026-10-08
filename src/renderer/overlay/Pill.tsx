import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { PillAction, PillMessageKind } from '@shared/ipc'
import { dictationKeyLabel, dictationKeySpoken } from '@shared/keycodes'
import {
  acceptsClicks,
  getLevel,
  getPillPrefs,
  getPillSenses,
  getPillState,
  noteLayoutChange,
  subscribeToPill,
} from './pill-store'
import { isClickable, layoutOf, pillView, spokenFor, type PillView } from './pill-view'

/** Sends a button's action, unless the click came too soon after the pill changed. */
function act(action: PillAction): void {
  if (acceptsClicks()) window.flow.sendPillAction(action)
}

/** How long the pointer rests on the pill before its hint appears. Passing over it shows nothing. */
const HOVER_HINT_MS = 500

/** Relative height of each bar, tallest in the middle. */
const BARS = [0.45, 0.75, 1, 0.7, 0.4]
/** A bar never disappears: at rest it is a dot. */
const BAR_MIN_PX = 3
const BAR_MAX_PX = 18

/**
 * The pill. What it shows is decided in the main process (see `PillPresenter`) and
 * worked out for drawing in `pillView`; this component only draws it.
 *
 * The window lets every click through to the app underneath, except while the pointer
 * is over a pill that can be clicked: one with buttons, or the resting pill, which
 * starts a hands-free recording when clicked.
 */
export function Pill() {
  const state = useSyncExternalStore(subscribeToPill, getPillState)
  const senses = useSyncExternalStore(subscribeToPill, getPillSenses)
  const prefs = useSyncExternalStore(subscribeToPill, getPillPrefs)
  const [hover, setHover] = useState(false)
  const now = useClock(state.kind === 'listening' && state.handsFree)

  const resting = state.kind === 'resting'
  const paused = prefs.pausedUntil !== null
  const local = {
    ...senses,
    hover: hover && resting,
    now,
    key: dictationKeyLabel(prefs.key),
    keySpoken: dictationKeySpoken(prefs.key),
    atRest: prefs.pillAtRest,
    pausedUntil: prefs.pausedUntil === null ? null : timeOfDay(prefs.pausedUntil),
  }
  const view = pillView(state, local)
  const clickable = isClickable(view, paused)
  const layout = layoutOf(view)
  /** The words on the pill: they decide its width, and so where its edges are. */
  const words = 'text' in view ? view.text : null

  const pill = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const canClick = useRef(clickable)
  const takingClicks = useRef(false)
  const over = useRef(false)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const atRest = useRef(resting)

  /**
   * The hint shows once the pointer has rested on the pill at rest. It is the resting
   * pill's: a pointer on a button of another state has not asked for it, and one that
   * is still there when the pill comes to rest starts its wait then.
   */
  const armHint = useCallback((): void => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverTimer.current =
      over.current && atRest.current ? setTimeout(() => setHover(true), HOVER_HINT_MS) : null
  }, [])

  /**
   * Decides whether the window should take clicks: only while the pointer is inside a
   * pill that can be clicked. It is worked out from where the pointer is, not from
   * enter and leave events: a button that disappears under the pointer never reports
   * that the pointer left, and the window would go on swallowing clicks meant for the
   * app underneath.
   */
  const sync = useCallback((): void => {
    const box = pill.current?.getBoundingClientRect()
    const at = pointer.current
    const inside =
      Boolean(box && at) &&
      at!.x >= box!.left &&
      at!.x <= box!.right &&
      at!.y >= box!.top &&
      at!.y <= box!.bottom

    if (inside !== over.current) {
      over.current = inside
      if (!inside) setHover(false)
      armHint()
    }

    const take = inside && canClick.current
    if (take === takingClicks.current) return
    takingClicks.current = take
    window.flow.setInteractive(take)
  }, [armHint])

  useEffect(() => {
    const moved = (event: PointerEvent): void => {
      pointer.current = { x: event.clientX, y: event.clientY }
      sync()
    }
    const left = (): void => {
      pointer.current = null
      sync()
    }
    window.addEventListener('pointermove', moved)
    document.documentElement.addEventListener('pointerleave', left)
    return () => {
      window.removeEventListener('pointermove', moved)
      document.documentElement.removeEventListener('pointerleave', left)
      if (hoverTimer.current) clearTimeout(hoverTimer.current)
    }
  }, [sync])

  // A hint belongs to the pill at rest. Whatever comes next starts without one.
  useEffect(() => {
    atRest.current = resting
    if (!resting) setHover(false)
    armHint()
  }, [resting, armHint])

  useEffect(() => {
    canClick.current = clickable
    sync()
    // The pill changes size over a moment; look again once it has settled. A message
    // that replaces another changes its size too, so this follows every change.
    const later = [120, 320].map((ms) => setTimeout(sync, ms))
    return () => later.forEach(clearTimeout)
  }, [clickable, layout, view.shape, words, sync])

  // The hint brings a button with it, where a moment ago there was only the pill.
  const shownLayout = useRef(layout)
  useEffect(() => {
    if (shownLayout.current === layout) return
    shownLayout.current = layout
    noteLayoutChange()
  }, [layout])

  return (
    <div className="pill-stage">
      <div
        className="pill"
        data-state={state.kind}
        data-hands-free={state.kind === 'listening' && state.handsFree}
        data-shape={view.shape}
        data-waiting={view.shape === 'rest' && view.waiting}
        data-live={view.shape === 'mic' && view.live}
        data-cancel={view.shape === 'processing' && view.canCancel}
        data-busy={view.shape === 'processing' && view.busy}
        data-kind={view.shape === 'message' ? view.kind : undefined}
        role="status"
        ref={pill}
        onClick={() => resting && !paused && act('start')}
      >
        <span className="pill-says">{spokenFor(state, local)}</span>
        <Contents view={view} />
      </div>
    </div>
  )
}

/** A time of day as the pill says it: `11:42`. */
function timeOfDay(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** The time now, kept up to date once a second while something on the pill counts it. */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [running])
  return now
}

/** What is inside the pill. Each group of contents fades in as the pill takes its shape. */
function Contents({ view }: { view: PillView }) {
  switch (view.shape) {
    case 'hidden':
      return null
    case 'rest':
      return view.waiting ? (
        <Inner key="waiting">
          <Dot />
        </Inner>
      ) : null
    case 'hint':
      return (
        <Inner key="hint">
          <Words dim>{view.text}</Words>
        </Inner>
      )
    case 'waitingHint':
      return (
        <Inner key="waitingHint">
          <Dot />
          <Words dim>{view.text}</Words>
          <TextButton label="Copy" onClick={() => act('copy')} />
        </Inner>
      )
    case 'mic':
      // One group for starting and listening: the bars are already there when the pill
      // goes live, and must not blink out at the very moment that says "speak now".
      return (
        <Inner key="mic">
          <Bars live={view.live} />
          {view.text && <Words dim>{view.text}</Words>}
        </Inner>
      )
    case 'handsFree':
      return (
        <Inner key="mic">
          <Bars live />
          <span className="pill-clock" data-last={view.lastMinute} aria-hidden="true">
            {view.clock}
          </span>
          <div className="pill-actions">
            <button
              type="button"
              className="pill-stop"
              aria-label="Stop"
              onClick={(event) => {
                event.stopPropagation()
                act('stop')
              }}
            >
              <span />
            </button>
            <CloseButton label="Cancel" onClick={() => act('cancel')} />
          </div>
        </Inner>
      )
    case 'processing':
      return (
        <Inner key="processing">
          <div className="pill-track" aria-hidden="true">
            <span className="pill-sweep" data-motion="sweep" />
          </div>
          {view.text && (
            <Words dim small={!view.busy}>
              {view.text}
            </Words>
          )}
          {view.canCancel && <CloseButton label="Cancel" onClick={() => act('cancel')} />}
        </Inner>
      )
    case 'confirm':
      return (
        <Inner key={`confirm:${view.text}`}>
          <Icon name="check" />
          <Words>{view.text}</Words>
        </Inner>
      )
    case 'message':
      return (
        <Inner key={`message:${view.text}`}>
          <Icon name={MESSAGE_ICON[view.kind]} />
          <Words shrink>{view.text}</Words>
          {view.redo && <TextButton label={view.redo} onClick={() => act('redo')} />}
          {view.canCopy && <TextButton label="Copy" onClick={() => act('copy')} />}
          <CloseButton label="Dismiss" onClick={() => act('dismiss')} />
        </Inner>
      )
  }
}

/** A group of contents. A different `key` where it is used is a different group, and fades in afresh. */
function Inner({ children }: { children: ReactNode }) {
  return (
    <div className="pill-inner" data-motion="fade">
      {children}
    </div>
  )
}

function Words(props: { dim?: boolean; small?: boolean; shrink?: boolean; children: ReactNode }) {
  return (
    <span
      className="pill-words"
      data-dim={props.dim}
      data-small={props.small}
      data-shrink={props.shrink}
      aria-hidden="true"
    >
      {props.children}
    </span>
  )
}

/** The mark for text that was not pasted and is waiting to be fetched. */
function Dot() {
  return <span className="pill-dot" aria-hidden="true" />
}

/**
 * The level bars. They move only with captured audio, so moving bars always mean the
 * microphone is being heard. Before audio flows (`live` false) they lie flat and dim;
 * live, they rise and take the one colour that means "you are being heard".
 */
function Bars({ live }: { live: boolean }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    if (!live) {
      for (const bar of bars.current) if (bar) bar.style.height = `${BAR_MIN_PX}px`
      return
    }
    let frame = 0
    let smoothed = 0
    const draw = (time: number): void => {
      const level = getLevel()
      // Up at once, down slowly: the bars follow speech without flickering.
      smoothed = level > smoothed ? level : smoothed * 0.88 + level * 0.12
      bars.current.forEach((bar, index) => {
        if (!bar) return
        // A slow sway per bar keeps a steady sound from drawing a frozen shape.
        const sway = 0.8 + 0.2 * Math.sin(time / 110 + index * 1.9)
        const height = BAR_MIN_PX + smoothed * (BARS[index] ?? 1) * sway * (BAR_MAX_PX - 1)
        bar.style.height = `${Math.min(BAR_MAX_PX, Math.max(BAR_MIN_PX, height)).toFixed(1)}px`
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [live])

  return (
    <div className="pill-bars" data-live={live} aria-hidden="true">
      {BARS.map((_, index) => (
        <span
          key={index}
          ref={(element) => {
            bars.current[index] = element
          }}
        />
      ))}
    </div>
  )
}

function TextButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="pill-button"
      aria-label={label}
      onClick={(event) => {
        // The pill itself is a button at rest; a click on one of its buttons is not for it.
        event.stopPropagation()
        onClick()
      }}
    >
      {label}
    </button>
  )
}

function CloseButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="pill-icon-button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
        <path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </button>
  )
}

type IconName = 'plain' | 'shield' | 'alert' | 'info' | 'check'

/** Each kind of message has its own icon, so that the kind is never told by colour alone. */
const MESSAGE_ICON: Record<Exclude<PillMessageKind, 'confirm'>, IconName> = {
  plain: 'plain',
  protected: 'shield',
  problem: 'alert',
  note: 'info',
}

const ICON_PATHS: Record<IconName, string[]> = {
  shield: [
    'M7 1.5 2.5 3.2v3.3c0 2.8 1.9 4.8 4.5 5.9 2.6-1.1 4.5-3.1 4.5-5.9V3.2z',
    'M5 7l1.4 1.4L9.2 5.6',
  ],
  alert: ['M7 1.6 12.9 12.2H1.1z', 'M7 5.6v3'],
  info: ['M7 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z', 'M7 6.3v3.5'],
  plain: ['M7 1.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11z', 'M4.6 7h4.8'],
  check: ['M2.8 7.3 5.6 10l5.6-6'],
}
/** Where the dot of an icon sits, for the two that have one. */
const ICON_DOT: Partial<Record<IconName, number>> = { alert: 10.3, info: 4.3 }

function Icon({ name }: { name: IconName }) {
  const dot = ICON_DOT[name]
  return (
    <svg
      className="pill-icon"
      data-icon={name}
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
      {dot !== undefined && <circle cx="7" cy={dot} r="0.9" fill="currentColor" stroke="none" />}
    </svg>
  )
}
