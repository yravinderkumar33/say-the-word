/** Product Hunt launch artwork. Screenshot content is embedded unchanged. */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appIcon } from '../../src/shared/icon-shapes'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const require = createRequire(import.meta.url)
const sharp = require(process.env.SHARP_PACKAGE_PATH || 'sharp')
mkdirSync(join(here, 'source'), { recursive: true })
const screenshots = ['cleanup-light.png', 'privacy-dark.png', 'first-run-ready-light.png']
for (const name of screenshots) {
  if (!existsSync(join(here, 'source', name))) {
    copyFileSync(join(root, 'dist/.pictures-say-the-word', name), join(here, 'source', name))
  }
}

const C = {
  paper: '#F5F4EE',
  ink: '#171C1A',
  mute: '#5A6A60',
  green: '#3DDC84',
  dark: '#101A15',
  pale: '#DDF5E6',
}
const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
const txt = (
  x: number,
  y: number,
  s: number,
  text: string,
  fill = C.ink,
  weight = 400,
  extra = '',
) =>
  `<text x="${x}" y="${y}" font-size="${s}" fill="${fill}" font-weight="${weight}" ${extra}>${escape(text)}</text>`
const lines = (
  x: number,
  y: number,
  s: number,
  texts: string[],
  fill = C.ink,
  weight = 400,
  gap = s * 1.2,
) =>
  texts
    .map((t, i) =>
      txt(x, y + gap * i, s, t, fill, weight, weight >= 600 ? 'letter-spacing="-1.7"' : ''),
    )
    .join('')
const rect = (x: number, y: number, w: number, h: number, r: number, fill: string, extra = '') =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" ${extra}/>`
const wave = (x: number, y: number, scale: number, fill = C.green) =>
  `<g transform="translate(${x} ${y}) scale(${scale})">${[14, 28, 40, 27, 13].map((h, i) => rect(i * 12, 24 - h / 2, 7, h, 3.5, fill)).join('')}</g>`
const originalIcon = appIcon(512)
  .map((s) =>
    rect(s.x, s.y, s.w, s.h, s.rx, s.colour ? `rgb(${s.colour.slice(0, 3).join(',')})` : '#000'),
  )
  .join('')
const icon = (x: number, y: number, size: number) =>
  `<g transform="translate(${x} ${y}) scale(${size / 1024})">${originalIcon}</g>`
const base = (content: string, dark = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1270" height="760" viewBox="0 0 1270 760"><defs><filter id="shadow" x="-30%" y="-30%" width="170%" height="180%"><feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#09150E" flood-opacity="0.14"/></filter><clipPath id="screen"><rect x="438" y="108" width="776" height="620.8" rx="14"/></clipPath></defs><g font-family="Helvetica Neue, Helvetica, Arial, sans-serif">${rect(0, 0, 1270, 760, 0, dark ? C.dark : C.paper)}${content}</g></svg>`
const brand = (dark = false) =>
  `${icon(53, 34, 56)}${txt(116, 73, 27, 'Say the Word', dark ? C.paper : C.ink, 600, 'letter-spacing="-0.8"')}${txt(1210, 68, 14, 'PRIVATE DICTATION FOR MAC', dark ? '#A7BDAE' : C.mute, 500, 'text-anchor="end" letter-spacing="1.6"')}`
const footer = (n: string, dark = false, counterX = 390) =>
  `${txt(62, 710, 15, 'FREE · OPEN SOURCE', dark ? '#A7BDAE' : C.mute, 500, 'letter-spacing="1.5"')}${txt(counterX, 710, 15, n, dark ? '#A7BDAE' : C.mute, 500, 'text-anchor="end" letter-spacing="1.5"')}`
const screenshot = (file: string) =>
  `${rect(438, 108, 776, 620.8, 14, '#FFF', 'filter="url(#shadow)"')}<image x="438" y="108" width="776" height="620.8" clip-path="url(#screen)" xlink:href="data:image/png;base64,${readFileSync(join(here, 'source', file)).toString('base64')}"/>${rect(438, 108, 776, 620.8, 14, 'none', 'stroke="#FFFFFF" stroke-opacity="0.18"')}`
const key = (x: number, y: number, label = 'Fn', size = 74) =>
  `${rect(x, y + 4, size, size, 16, '#C9D3C9')}${rect(x, y, size, size, 16, '#FFFFFF', 'stroke="#D1DBD1" stroke-width="1.5"')}${txt(x + size / 2, y + size * 0.62, size * 0.35, label, C.ink, 500, 'text-anchor="middle"')}`

const hero = base(`${brand()}
  ${rect(610, 123, 622, 500, 44, '#E7EEE2')}
  ${lines(62, 215, 68, ['Speak naturally.', 'Type anywhere.'], C.ink, 600, 76)}
  ${lines(65, 359, 27, ['Private dictation for macOS.', 'Your voice stays on your Mac.'], C.mute, 400, 39)}
  ${key(65, 457)}${lines(159, 483, 23, ['Hold to speak.', 'Release to paste.'], C.ink, 500, 33)}
  ${txt(65, 607, 19, 'macOS 14+ · Apple Silicon', C.mute)}
  <g filter="url(#shadow)">${rect(646, 191, 547, 305, 20, '#FFFFFF')}</g>
  ${rect(646, 191, 547, 51, 20, '#E1E7DE')}${rect(646, 219, 547, 24, 0, '#E1E7DE')}
  <circle cx="669" cy="217" r="5" fill="#FF6057"/><circle cx="686" cy="217" r="5" fill="#FFBD2E"/><circle cx="703" cy="217" r="5" fill="#28C840"/>
  ${txt(723, 223, 17, 'New message', C.mute)}
  ${txt(674, 282, 18, 'To: The team', C.mute)}<path d="M646 303H1193" stroke="#EDF0E9"/>
  ${lines(674, 354, 33, ['Let’s move the meeting', 'to Friday at 3.'], C.ink, 400, 45)}
  <path d="M903 370v35" stroke="#268C50" stroke-width="2"/>
  ${rect(864, 533, 112, 52, 26, '#1C1C1E', 'stroke="#3C3C3D" stroke-width="2"')}${wave(893, 545, 0.86)}
  ${txt(920, 616, 12, 'ILLUSTRATED WORKFLOW', C.mute, 500, 'text-anchor="middle" letter-spacing="1.5"')}
  ${footer('01 / 04', false, 1210)}`)

const cleanup = base(
  `${brand(true)}${screenshot('cleanup-light.png')}
  ${txt(62, 173, 14, 'OPTIONAL CLEANED MODE', C.green, 500, 'letter-spacing="1.6"')}
  ${lines(62, 247, 47, ['A little polish.', 'Still your words.'], C.paper, 600, 56)}
  ${lines(64, 384, 22, ['Local Ollama cleanup removes', 'fillers and false starts.'], '#B3C5B9', 400, 33)}
  ${lines(64, 488, 21, ['Prefer the original transcript?', 'Choose Verbatim.'], '#B3C5B9', 400, 32)}
  ${rect(63, 565, 240, 38, 19, '#233A2C')}${txt(183, 590, 15, 'No cloud model required', '#D9EADF', 500, 'text-anchor="middle"')}
  ${lines(64, 637, 18, ['Review original and cleaned', 'text in History.'], '#B3C5B9', 400, 26)}
  ${footer('02 / 04', true)}`,
  true,
)

const privacy = base(`${brand()}${screenshot('privacy-dark.png')}
  ${txt(62, 173, 14, 'LOCAL BY DESIGN', C.mute, 500, 'letter-spacing="1.6"')}
  ${lines(62, 247, 49, ['Privacy you', 'can inspect.'], C.ink, 600, 58)}
  ${lines(64, 382, 22, ['See what is stored and every', 'address the app has contacted.'], C.mute, 400, 33)}
  ${lines(64, 492, 22, ['No account.', 'No cloud. No telemetry.'], C.ink, 500, 33)}
  ${lines(64, 590, 17, ['Works offline after the', 'one-time speech model download.'], C.mute, 400, 26)}
  ${footer('03 / 04')}`)

const handsfree = base(
  `${brand(true)}${screenshot('first-run-ready-light.png')}
  ${txt(62, 173, 14, 'ONE KEY. YOUR FLOW.', C.green, 500, 'letter-spacing="1.6"')}
  ${lines(62, 247, 48, ['Hold to talk.', 'Or go', 'hands-free.'], C.paper, 600, 56)}
  ${lines(64, 452, 22, ['Tap Fn twice to start.', 'Tap again when you’re done.'], '#B3C5B9', 400, 33)}
  ${lines(64, 561, 19, ['A guided setup gets you ready.', 'Copy or paste your last dictation', 'with a keyboard shortcut.'], '#B3C5B9', 400, 29)}
  ${footer('04 / 04', true)}`,
  true,
)

for (const [name, svg] of Object.entries({
  '01-speak-naturally': hero,
  '02-local-cleanup': cleanup,
  '03-private-by-design': privacy,
  '04-hands-free': handsfree,
})) {
  writeFileSync(join(here, `${name}.svg`), svg)
  await sharp(Buffer.from(svg))
    .png()
    .toFile(join(here, `${name}.png`))
}
const thumb = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="${C.paper}"/>${originalIcon}</svg>`
writeFileSync(join(here, 'thumbnail.svg'), thumb)
for (const size of [240, 512])
  await sharp(Buffer.from(thumb))
    .resize(size, size)
    .png()
    .toFile(join(here, `thumbnail-${size}.png`))
console.log('Rendered four gallery images at 1270×760 and thumbnails at 240×240 / 512×512.')
