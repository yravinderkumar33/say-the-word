// Draws the app icon and writes `build/icon.icns`, which electron-builder puts in the
// app bundle. The icon is rounded rectangles and nothing else, so it is drawn in code
// from the same shapes the About page and the menu-bar icon use: no artwork is borrowed.
//
//   npm run icon
//
// The result is checked in. Run this again only when the drawing in
// `src/shared/icon-shapes.ts` changes.
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { APP_ICON_SIZE, appIcon } from '../src/shared/icon-shapes'
import { rasterise } from '../src/shared/raster'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A PNG file from RGBA pixels with straight alpha. */
function png(pixels: Uint8Array, side: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(side, 0)
  header.writeUInt32BE(side, 4)
  // Eight bits a channel, red green blue and alpha, no interlacing.
  header.set([8, 6, 0, 0, 0], 8)
  // Each row starts with the filter it uses: none.
  const rows = Buffer.alloc(side * (side * 4 + 1))
  for (let row = 0; row < side; row++) {
    const from = row * side * 4
    rows.set(pixels.subarray(from, from + side * 4), row * (side * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** The sizes macOS asks for, each at both screen densities. */
const SIZES = [16, 32, 128, 256, 512]

const iconset = join(mkdtempSync(join(tmpdir(), 'flow-icon-')), 'icon.iconset')
mkdirSync(iconset)
const draw = (pixels: number): Buffer =>
  png(rasterise(appIcon(pixels), APP_ICON_SIZE, pixels), pixels)
for (const size of SIZES) {
  writeFileSync(join(iconset, `icon_${size}x${size}.png`), draw(size))
  writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), draw(size * 2))
}

mkdirSync(join(root, 'build'), { recursive: true })
const made = spawnSync(
  '/usr/bin/iconutil',
  ['-c', 'icns', iconset, '-o', join(root, 'build', 'icon.icns')],
  { stdio: 'inherit' },
)
rmSync(dirname(iconset), { recursive: true, force: true })
if (made.status !== 0) process.exit(made.status ?? 1)
console.log('Wrote build/icon.icns')
