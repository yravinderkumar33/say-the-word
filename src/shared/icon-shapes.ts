import { bars, colour, type Shape } from './raster'

/**
 * The menu-bar icon in its five states, on an 18 px grid. It is a template image:
 * macOS tints it, so one colour is all there is and the states are told apart by
 * shape alone.
 */
export type TrayIconState = 'ready' | 'live' | 'attention' | 'paused' | 'saving'

export const TRAY_ICON_SIZE = 18

/** Bars 2 px wide with their left edges at these places. */
const BAR_LEFTS = [2, 5, 8, 11, 14]
const trayBars = (lefts: readonly number[], heights: readonly number[], middle = 9): Shape[] =>
  bars(
    lefts.map((left) => left + 1),
    2,
    heights,
    middle,
  )

export const TRAY_ICONS: Record<TrayIconState, Shape[]> = {
  // The mark: five bars, short at the ends.
  ready: trayBars(BAR_LEFTS, [4, 8, 12, 8, 4]),
  // The pill, filled, with the bars cut out of it: the strongest shape, for the state that matters most.
  live: [
    { x: 0.5, y: 3, w: 17, h: 12, rx: 6 },
    ...trayBars([3.5, 6.5, 9.5, 12.5], [3, 7, 5, 3]).map((bar) => ({ ...bar, cut: true })),
  ],
  // Three bars, then an exclamation mark where the last two stood.
  attention: [
    ...trayBars(BAR_LEFTS.slice(0, 3), [4, 8, 12]),
    { x: 13, y: 3, w: 2.6, h: 8, rx: 1.3 },
    { x: 13, y: 12.6, w: 2.6, h: 2.6, rx: 1.3 },
  ],
  // All five flattened to dots: nothing will be heard until dictation is resumed.
  paused: trayBars(BAR_LEFTS, [2, 2, 2, 2, 2]),
  // The bars sit on a line, as if written to disk. Amber cannot be had here, so the shape says it.
  saving: [...trayBars(BAR_LEFTS, [3, 6, 9, 6, 3], 7.5), { x: 1, y: 14, w: 16, h: 2, rx: 1 }],
}

/**
 * Which state the icon shows when several hold: the microphone being live comes first,
 * then something that needs the user, then a pause, then the saving of dictations.
 */
export function trayIconState(facts: {
  live: boolean
  attention: boolean
  paused: boolean
  saving: boolean
}): TrayIconState {
  if (facts.live) return 'live'
  if (facts.attention) return 'attention'
  if (facts.paused) return 'paused'
  if (facts.saving) return 'saving'
  return 'ready'
}

// --- The app icon ---------------------------------------------------------------------

export const APP_ICON_SIZE = 1024

const GREEN = colour('#3ddc84')
const SQUARE = colour('#1c1c1e')
/** White at 14 % over the square: the hairline that lifts its edge off a dark desktop. */
const EDGE = colour('#3c3c3d')
const PILL = colour('#34343a')

/** The rounded square every macOS icon sits on, with an edge of this width. */
function square(edge: number): Shape[] {
  return [
    { x: 100, y: 100, w: 824, h: 824, rx: 185, colour: EDGE },
    {
      x: 100 + edge,
      y: 100 + edge,
      w: 824 - 2 * edge,
      h: 824 - 2 * edge,
      rx: 185 - edge,
      colour: SQUARE,
    },
  ]
}

/**
 * The app icon: the pill as an object, its bars at the heights they have while
 * listening. `small` is the drawing for 16 px, where the pill fills the width and
 * keeps three bars; at 32 px the edge is drawn twice as wide so that it survives.
 */
export function appIcon(pixels: number): Shape[] {
  if (pixels <= 16) {
    return [
      { x: 100, y: 100, w: 824, h: 824, rx: 185, colour: SQUARE },
      { x: 170, y: 372, w: 684, h: 280, rx: 140, colour: PILL },
      ...bars([382, 512, 642], 96, [120, 200, 120], 512, GREEN),
    ]
  }
  return [
    ...square(pixels <= 32 ? 8 : 4),
    { x: 232, y: 392, w: 560, h: 240, rx: 120, colour: PILL },
    ...bars([360, 436, 512, 588, 664], 44, [64, 128, 184, 112, 56], 512, GREEN),
  ]
}
