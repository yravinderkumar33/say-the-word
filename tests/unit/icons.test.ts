import { describe, expect, it } from 'vitest'
import {
  APP_ICON_SIZE,
  TRAY_ICONS,
  TRAY_ICON_SIZE,
  appIcon,
  trayIconState,
  type TrayIconState,
} from '@shared/icon-shapes'
import { bars, colour, rasterise } from '@shared/raster'

/** The opacity of one pixel of a drawing, from 0 to 255. */
function alphaAt(pixels: Uint8Array, side: number, x: number, y: number): number {
  return pixels[(y * side + x) * 4 + 3] ?? -1
}
/** How many pixels of a drawing are painted at all. */
const painted = (pixels: Uint8Array): number =>
  pixels.filter((value, index) => index % 4 === 3 && value > 0).length

const draw = (state: TrayIconState, scale = 2): Uint8Array =>
  rasterise(TRAY_ICONS[state], TRAY_ICON_SIZE, TRAY_ICON_SIZE * scale)

describe('drawing rounded rectangles', () => {
  it('fills a square, and leaves the rest clear', () => {
    const pixels = rasterise([{ x: 1, y: 1, w: 2, h: 2, rx: 0 }], 4, 4)

    expect(alphaAt(pixels, 4, 1, 1)).toBe(255)
    expect(alphaAt(pixels, 4, 2, 2)).toBe(255)
    expect(alphaAt(pixels, 4, 0, 0)).toBe(0)
    expect(alphaAt(pixels, 4, 3, 3)).toBe(0)
  })

  it('draws an edge that falls inside a pixel as partly there', () => {
    const pixels = rasterise([{ x: 0, y: 0, w: 1.5, h: 4, rx: 0 }], 4, 4)

    expect(alphaAt(pixels, 4, 0, 1)).toBe(255)
    expect(alphaAt(pixels, 4, 1, 1)).toBeGreaterThan(100)
    expect(alphaAt(pixels, 4, 1, 1)).toBeLessThan(160)
    expect(alphaAt(pixels, 4, 2, 1)).toBe(0)
  })

  it('rounds the corners of a capsule', () => {
    const pixels = rasterise([{ x: 0, y: 0, w: 16, h: 8, rx: 4 }], 16, 16)

    expect(alphaAt(pixels, 16, 0, 0)).toBeLessThan(80)
    expect(alphaAt(pixels, 16, 8, 4)).toBe(255)
  })

  it('cuts a hole where a shape says so, and paints in colour', () => {
    const red = colour('#ff0000')
    const pixels = rasterise(
      [
        { x: 0, y: 0, w: 4, h: 4, rx: 0, colour: red },
        { x: 1, y: 1, w: 2, h: 2, rx: 0, cut: true },
      ],
      4,
      4,
    )

    expect([...pixels.slice(0, 4)]).toEqual([255, 0, 0, 255])
    expect(alphaAt(pixels, 4, 1, 1)).toBe(0)
  })

  it('centres bars on a line', () => {
    expect(bars([4, 8], 2, [4, 8], 9)).toEqual([
      { x: 3, y: 7, w: 2, h: 4, rx: 1 },
      { x: 7, y: 5, w: 2, h: 8, rx: 1 },
    ])
  })
})

describe('the menu-bar icon', () => {
  it('has a different shape for each state, since it has only one colour', () => {
    const states: TrayIconState[] = ['ready', 'live', 'attention', 'paused', 'saving']
    const drawings = states.map((state) => Buffer.from(draw(state)).toString('base64'))

    expect(new Set(drawings).size).toBe(states.length)
  })

  it('is five bars when ready, tallest in the middle', () => {
    const pixels = draw('ready', 1)

    // The middle bar runs from 3 to 15; the outer ones from 7 to 11.
    expect(alphaAt(pixels, 18, 8, 4)).toBe(255)
    expect(alphaAt(pixels, 18, 2, 4)).toBe(0)
    expect(alphaAt(pixels, 18, 2, 9)).toBe(255)
    // Between two bars there is nothing.
    expect(alphaAt(pixels, 18, 4, 9)).toBe(0)
  })

  it('is a filled capsule with the bars cut out of it while the microphone is live', () => {
    const pixels = draw('live', 1)

    expect(alphaAt(pixels, 18, 2, 9)).toBe(255)
    // Inside a cut-out bar, which runs from 6.5 to 8.5.
    expect(alphaAt(pixels, 18, 7, 9)).toBe(0)
    expect(painted(pixels)).toBeGreaterThan(painted(draw('ready', 1)) * 2)
  })

  it('flattens to dots when paused, and stands on a line while dictations are saved', () => {
    const paused = draw('paused', 1)
    expect(alphaAt(paused, 18, 8, 4)).toBe(0)
    // A dot two pixels across: round, so its pixels are mostly but not wholly covered.
    expect(alphaAt(paused, 18, 8, 8)).toBeGreaterThan(150)
    expect(alphaAt(paused, 18, 8, 11)).toBe(0)

    const saving = draw('saving', 1)
    // The line under the bars, across the width.
    expect(alphaAt(saving, 18, 4, 14)).toBe(255)
    expect(alphaAt(saving, 18, 13, 15)).toBe(255)
  })

  it('shows one state when several hold: live, then attention, then paused, then saving', () => {
    const all = { live: true, attention: true, paused: true, saving: true }

    expect(trayIconState(all)).toBe('live')
    expect(trayIconState({ ...all, live: false })).toBe('attention')
    expect(trayIconState({ ...all, live: false, attention: false })).toBe('paused')
    expect(trayIconState({ live: false, attention: false, paused: false, saving: true })).toBe(
      'saving',
    )
    expect(trayIconState({ live: false, attention: false, paused: false, saving: false })).toBe(
      'ready',
    )
  })
})

describe('the app icon', () => {
  const green = (pixels: number): number =>
    appIcon(pixels).filter((shape) => shape.colour?.[1] === 0xdc).length

  it('is the pill with five bars, and with three where there is room for no more', () => {
    expect(green(1024)).toBe(5)
    expect(green(32)).toBe(5)
    expect(green(16)).toBe(3)
  })

  it('leaves the corners of its square clear, and paints its middle green', () => {
    const side = 64
    const pixels = rasterise(appIcon(side), APP_ICON_SIZE, side)

    expect(alphaAt(pixels, side, 0, 0)).toBe(0)
    expect(alphaAt(pixels, side, 7, 7)).toBe(0)
    const centre = (side / 2) * side * 4 + (side / 2) * 4
    expect([...pixels.slice(centre, centre + 4)]).toEqual([0x3d, 0xdc, 0x84, 255])
  })
})
