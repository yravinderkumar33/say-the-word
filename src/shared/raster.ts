/**
 * Draws rounded rectangles into a bitmap. The menu-bar icon and the app icon are both
 * made of nothing else, so they are drawn in code and the app ships no borrowed artwork.
 */

/** Red, green, blue and opacity, each from 0 to 255. */
export type Colour = readonly [number, number, number, number]

export interface Shape {
  x: number
  y: number
  w: number
  h: number
  /** Corner radius. Half the shorter side makes a capsule. */
  rx: number
  /** Opaque black where not given, which is all a template image needs. */
  colour?: Colour
  /** Cuts a hole in what was drawn before it, instead of painting. */
  cut?: boolean
}

const BLACK: Colour = [0, 0, 0, 255]
/** Each pixel is sampled this many times across and down, so that curved edges come out smooth. */
const SAMPLES = 4

function covers(shape: Shape, x: number, y: number): boolean {
  const radius = Math.min(shape.rx, shape.w / 2, shape.h / 2)
  // The nearest point of the rectangle that is left when the corners' radius is taken off.
  const nearX = Math.min(Math.max(x, shape.x + radius), shape.x + shape.w - radius)
  const nearY = Math.min(Math.max(y, shape.y + radius), shape.y + shape.h - radius)
  return (x - nearX) ** 2 + (y - nearY) ** 2 <= radius * radius
}

/**
 * The drawing as RGBA pixels with straight (not premultiplied) alpha, row by row.
 *
 * `size` is the side of the drawing in its own units (18 for the menu-bar icon, 1024
 * for the app icon); `pixels` is the side of the bitmap. Shapes are painted in order.
 */
export function rasterise(shapes: readonly Shape[], size: number, pixels: number): Uint8Array {
  const out = new Uint8Array(pixels * pixels * 4)
  const unit = size / pixels
  for (let row = 0; row < pixels; row++) {
    for (let column = 0; column < pixels; column++) {
      // Summed premultiplied, so that a half-covered edge does not darken.
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (column + (sx + 0.5) / SAMPLES) * unit
          const y = (row + (sy + 0.5) / SAMPLES) * unit
          let sample: Colour | null = null
          for (const shape of shapes) {
            if (!covers(shape, x, y)) continue
            sample = shape.cut ? null : over(shape.colour ?? BLACK, sample)
          }
          if (!sample) continue
          const opacity = sample[3] / 255
          red += sample[0] * opacity
          green += sample[1] * opacity
          blue += sample[2] * opacity
          alpha += opacity
        }
      }
      const at = (row * pixels + column) * 4
      if (alpha === 0) continue
      out[at] = Math.round(red / alpha)
      out[at + 1] = Math.round(green / alpha)
      out[at + 2] = Math.round(blue / alpha)
      out[at + 3] = Math.round((alpha / (SAMPLES * SAMPLES)) * 255)
    }
  }
  return out
}

/** One colour painted over another. */
function over(top: Colour, under: Colour | null): Colour {
  if (!under || top[3] === 255) return top
  const a = top[3] / 255
  const b = (under[3] / 255) * (1 - a)
  const alpha = a + b
  if (alpha === 0) return [0, 0, 0, 0]
  return [
    (top[0] * a + under[0] * b) / alpha,
    (top[1] * a + under[1] * b) / alpha,
    (top[2] * a + under[2] * b) / alpha,
    alpha * 255,
  ]
}

/** A colour written as `#rrggbb`, with an opacity from 0 to 1. */
export function colour(hex: string, opacity = 1): Colour {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, Math.round(opacity * 255)]
}

/** Bars standing side by side, centred on a line: the mark the icons are built from. */
export function bars(
  centres: readonly number[],
  width: number,
  heights: readonly number[],
  middle: number,
  fill?: Colour,
): Shape[] {
  return centres.map((centre, index) => {
    const height = heights[index] ?? 0
    return {
      x: centre - width / 2,
      y: middle - height / 2,
      w: width,
      h: height,
      rx: width / 2,
      ...(fill ? { colour: fill } : {}),
    }
  })
}
