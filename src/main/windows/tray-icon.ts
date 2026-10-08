import { nativeImage } from 'electron'
import { TRAY_ICONS, TRAY_ICON_SIZE, type TrayIconState } from '@shared/icon-shapes'
import { rasterise } from '@shared/raster'

const images = new Map<TrayIconState, Electron.NativeImage>()

/**
 * The menu-bar icon for a state, drawn once at both screen densities. It is a template
 * image, so macOS tints it to suit a light or dark menu bar.
 */
export function trayImage(state: TrayIconState): Electron.NativeImage {
  const known = images.get(state)
  if (known) return known
  const image = nativeImage.createFromBitmap(bitmap(state, 2), {
    width: TRAY_ICON_SIZE * 2,
    height: TRAY_ICON_SIZE * 2,
    scaleFactor: 2,
  })
  image.addRepresentation({
    scaleFactor: 1,
    width: TRAY_ICON_SIZE,
    height: TRAY_ICON_SIZE,
    buffer: bitmap(state, 1),
  })
  image.setTemplateImage(true)
  images.set(state, image)
  return image
}

/** Black, with the drawing as its opacity: only the opacity matters in a template image. */
function bitmap(state: TrayIconState, scale: number): Buffer {
  const pixels = TRAY_ICON_SIZE * scale
  const drawn = rasterise(TRAY_ICONS[state], TRAY_ICON_SIZE, pixels)
  const out = Buffer.alloc(pixels * pixels * 4)
  for (let at = 3; at < out.length; at += 4) out[at] = drawn[at] ?? 0
  return out
}
