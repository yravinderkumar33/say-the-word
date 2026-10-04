import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import type { PillAction } from '@shared/ipc'
import { acceptsClicks, getLevel, getPillState, subscribeToPill } from './pill-store'

/** Sends a button's action, unless the click came too soon after the pill changed. */
function act(action: PillAction): void {
  if (acceptsClicks()) window.flow.sendPillAction(action)
}

/** Relative height of each bar, tallest in the middle. */
const BARS = [0.42, 0.68, 0.9, 1, 0.9, 0.68, 0.42]
/** A bar never disappears: at rest it is a dot. */
const BAR_FLOOR = 0.14

/**
 * The pill. What it shows is decided in the main process (see `PillPresenter`);
 * this component only draws it.
 *
 * The window lets every click through to the app underneath, except while the pointer
 * is over a pill that can be clicked: one with buttons, or the resting pill, which
 * starts a hands-free recording when clicked.
 */
export function Pill() {
  const state = useSyncExternalStore(subscribeToPill, getPillState)
  const handsFree = state.kind === 'listening' && state.handsFree
  const clickable =
    state.kind === 'resting' ||
    state.kind === 'processing' ||
    state.kind === 'recovery' ||
    handsFree

  const pill = useRef<HTMLDivElement>(null)
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const canClick = useRef(clickable)
  const takingClicks = useRef(false)

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
    const take = inside && canClick.current
    if (take === takingClicks.current) return
    takingClicks.current = take
    window.flow.setInteractive(take)
  }, [])

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
    }
  }, [sync])

  useEffect(() => {
    canClick.current = clickable
    sync()
    // The pill changes size over a moment; look again once it has settled. A message
    // that replaces another changes its size too, so this follows every change.
    const later = [120, 320].map((ms) => setTimeout(sync, ms))
    return () => later.forEach(clearTimeout)
  }, [clickable, state, sync])

  return (
    <div className="pill-stage">
      <div
        className="pill"
        data-state={state.kind}
        data-hands-free={handsFree}
        role="status"
        ref={pill}
        onClick={() => state.kind === 'resting' && act('start')}
      >
        {(state.kind === 'starting' || state.kind === 'listening') && (
          <Bars live={state.kind === 'listening'} />
        )}

        {handsFree && (
          <div className="pill-actions">
            <IconButton label="Stop" icon="stop" onClick={() => act('stop')} />
            <IconButton label="Cancel" onClick={() => act('cancel')} />
          </div>
        )}

        {state.kind === 'processing' && (
          <>
            <div className="pill-dots" aria-label="Processing">
              <span />
              <span />
              <span />
            </div>
            <IconButton label="Cancel" onClick={() => act('cancel')} />
          </>
        )}

        {state.kind === 'recovery' && (
          <>
            <span className="pill-message">{state.message}</span>
            {state.redo && (
              <button
                type="button"
                className="pill-button"
                aria-label={state.redo}
                onClick={() => act('redo')}
              >
                {state.redo}
              </button>
            )}
            {state.canCopy && (
              <button type="button" className="pill-button" onClick={() => act('copy')}>
                Copy
              </button>
            )}
            <IconButton label="Dismiss" onClick={() => act('dismiss')} />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The level bars. They move only with captured audio, so moving bars always mean the
 * microphone is being heard. Before audio flows (`live` false) they lie flat.
 */
function Bars({ live }: { live: boolean }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    if (!live) {
      for (const bar of bars.current) if (bar) bar.style.transform = `scaleY(${BAR_FLOOR})`
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
        const height = Math.min(1, smoothed * (BARS[index] ?? 1) * sway * 1.5)
        bar.style.transform = `scaleY(${Math.max(BAR_FLOOR, height).toFixed(3)})`
      })
      frame = requestAnimationFrame(draw)
    }
    frame = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(frame)
  }, [live])

  return (
    <div className="pill-bars" aria-label={live ? 'Listening' : 'Starting the microphone'}>
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

function IconButton(props: { label: string; icon?: 'close' | 'stop'; onClick: () => void }) {
  return (
    <button
      type="button"
      className="pill-icon-button"
      aria-label={props.label}
      data-icon={props.icon ?? 'close'}
      onClick={props.onClick}
    >
      <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
        {props.icon === 'stop' ? (
          <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
        ) : (
          <path
            d="M1 1l8 8M9 1l-8 8"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        )}
      </svg>
    </button>
  )
}
