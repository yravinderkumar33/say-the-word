// Scores the recognizer on your own dictations.
//
// Switch on "Save every dictation" in the app's tray menu (Evaluation), dictate as you
// normally would, then open the folder ("Show saved dictations"). Each dictation has a
// recording and a `.txt` holding what the recognizer heard. Correct each `.txt` until
// it says what you meant, and run this.
//
// A `.txt` may start with tags, to see where the errors are:
//
//     #names #technical
//     Ask Priyanka whether the Kubernetes upgrade is done.
//
// Recordings with a number in the intended text are tagged #numbers automatically.
//
//   npm run eval:stt                     every dictation in the evaluation folder
//   npm run eval:stt -- --dir <folder>   another folder
//   npm run eval:stt -- --show 10        list the ten with the most errors, word by word
//   npm run eval:stt -- --quiet          numbers only: nothing that was said is printed
//
// Each `.wav` is run through the same path the app uses: voice detection, cutting at
// pauses, the recognizer.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FRAME_SAMPLES, SAMPLE_RATE } from '../src/shared/audio-format'
import { decodeWav } from '../src/shared/wav'
import {
  alignWords,
  comparableWords,
  surfaceTokens,
  wordEditDistance,
  type WordEdit,
} from '../src/shared/wer'
import { loadParakeet } from '../src/main/stt/engines/sherpa-parakeet'
import { DEFAULT_MODEL } from '../src/main/stt/model-catalog'
import { adoptModel, modelDir } from '../src/main/stt/model-store'
import { modelsRoot } from '../src/main/stt/models-dir'
import { Transcriber, type TranscriberEvent } from '../src/main/stt/transcriber'
import { VoiceDetector } from '../src/main/stt/vad'

const args = process.argv.slice(2)
const option = (name: string): string | null => {
  const index = args.indexOf(name)
  return index === -1 ? null : (args[index + 1] ?? '')
}
const dir =
  option('--dir') ??
  process.env['WHISPER_FLOW_EVAL_DIR'] ??
  join(homedir(), 'Library', 'Application Support', 'Whisper Flow', 'evaluation')
const show = Number(option('--show') ?? 5)
const quiet = args.includes('--quiet')

interface Item {
  name: string
  tags: string[]
  /** What the user meant. */
  intended: string
  /** True when the `.txt` is still exactly what the recognizer wrote at the time. */
  untouched: boolean
  samples: Float32Array
}

interface Score {
  item: Item
  heard: string
  words: number
  wordEdits: number
  pieces: number
  pieceEdits: number
  decodeMs: number
}

/** Leading lines of `#tags` are labels; the rest is the intended text. */
function parseText(raw: string): { tags: string[]; text: string } {
  const lines = raw.replace(/\r/g, '').split('\n')
  const tags: string[] = []
  while (lines.length > 0 && /^\s*(#[\p{L}\p{N}-]+\s*)+$/u.test(lines[0] ?? '')) {
    tags.push(...(lines.shift() ?? '').toLowerCase().match(/#[\p{L}\p{N}-]+/gu)!)
  }
  return { tags, text: lines.join('\n').trim() }
}

function loadItems(): { items: Item[]; withoutText: number } {
  if (!existsSync(dir)) return { items: [], withoutText: 0 }
  const items: Item[] = []
  let withoutText = 0
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.wav')) continue
    const name = file.slice(0, -'.wav'.length)
    const textPath = join(dir, `${name}.txt`)
    if (!existsSync(textPath)) {
      withoutText += 1
      continue
    }
    const { tags, text } = parseText(readFileSync(textPath, 'utf8'))
    if (text.length === 0) {
      withoutText += 1
      continue
    }
    const heardPath = join(dir, `${name}.heard.txt`)
    const untouched =
      existsSync(heardPath) && readFileSync(heardPath, 'utf8').trim() === text && tags.length === 0
    const audio = decodeWav(readFileSync(join(dir, file)))
    if (audio.sampleRate !== SAMPLE_RATE) {
      console.error(`${file}: expected ${SAMPLE_RATE} Hz audio, skipped`)
      continue
    }
    if (/\d/.test(text) && !tags.includes('#numbers')) tags.push('#numbers')
    items.push({ name, tags, intended: text, untouched, samples: audio.samples })
  }
  return { items, withoutText }
}

const percent = (edits: number, total: number): string =>
  total === 0 ? 'n/a' : `${((edits / total) * 100).toFixed(1)}%`

function describeEdits(edits: WordEdit[]): string {
  return edits
    .map((edit) => {
      if (edit.kind === 'same') return edit.word
      if (edit.kind === 'substituted') return `[${edit.heard} → ${edit.expected}]`
      if (edit.kind === 'missing') return `[+${edit.expected}]`
      return `[-${edit.heard}]`
    })
    .join(' ')
}

async function main(): Promise<void> {
  const { items, withoutText } = loadItems()
  if (items.length === 0) {
    console.log(`No dictations with text in ${dir}`)
    console.log('Switch on Evaluation → "Save every dictation" in the tray menu, then dictate.')
    return
  }

  const root = modelsRoot()
  if (!(await adoptModel(root, DEFAULT_MODEL)).ready) {
    throw new Error('The speech model is not downloaded. Run: npm run models:download')
  }
  const model = modelDir(root, DEFAULT_MODEL)
  const { engine } = await loadParakeet(model, 4)
  const detector = new VoiceDetector(join(model, 'silero_vad.onnx'))

  const scores: Score[] = []
  let session = 0
  for (const item of items) {
    session += 1
    const events: TranscriberEvent[] = []
    const transcriber = new Transcriber(engine, detector, (event) => events.push(event))
    transcriber.begin(session)
    let frames = 0
    for (let offset = 0; offset < item.samples.length; offset += FRAME_SAMPLES) {
      transcriber.acceptFrame(session, frames++, item.samples.slice(offset, offset + FRAME_SAMPLES))
    }
    await transcriber.end(session, frames)
    const result = events.find((event) => event.t === 'final')
    const heard = result?.t === 'final' ? result.text : ''
    const expectedWords = comparableWords(item.intended)
    const expectedPieces = surfaceTokens(item.intended)
    scores.push({
      item,
      heard,
      words: expectedWords.length,
      wordEdits: wordEditDistance(expectedWords, comparableWords(heard)),
      pieces: expectedPieces.length,
      pieceEdits: wordEditDistance(expectedPieces, surfaceTokens(heard)),
      decodeMs: result?.t === 'final' ? result.decodeMs : 0,
    })
  }

  const sum = (list: Score[], pick: (score: Score) => number): number =>
    list.reduce((total, score) => total + pick(score), 0)
  const row = (label: string, list: Score[]): string => {
    const clean = list.filter((score) => score.pieceEdits === 0).length
    return (
      `| ${label} | ${list.length} | ${sum(list, (score) => score.words)} | ` +
      `${percent(
        sum(list, (score) => score.wordEdits),
        sum(list, (score) => score.words),
      )} | ` +
      `${percent(
        sum(list, (score) => score.pieceEdits),
        sum(list, (score) => score.pieces),
      )} | ` +
      `${clean} of ${list.length} |`
    )
  }

  const audioSeconds = sum(scores, (score) => score.item.samples.length) / SAMPLE_RATE
  console.log(`Recognizer: ${engine.id}. Folder: ${dir}`)
  console.log(
    `${scores.length} dictations, ${(audioSeconds / 60).toFixed(1)} minutes of audio, ` +
      `decoded in ${(sum(scores, (score) => score.decodeMs) / 1000).toFixed(1)} s.\n`,
  )
  console.log('| Set | Dictations | Words | Word errors | Corrections needed | Needing none |')
  console.log('|---|---|---|---|---|---|')
  console.log(row('All', scores))
  const tags = [...new Set(scores.flatMap((score) => score.item.tags))].sort()
  for (const tag of tags) {
    console.log(
      row(
        tag,
        scores.filter((score) => score.item.tags.includes(tag)),
      ),
    )
  }
  console.log(
    '\nWord errors ignore capitals and punctuation. Corrections needed counts them: it is ' +
      'the share of words and punctuation marks you would have to fix by hand.',
  )

  const untouched = scores.filter((score) => score.item.untouched).length
  if (untouched > 0) {
    console.log(
      `\n${untouched} of ${scores.length} still hold exactly what the recognizer wrote. ` +
        'If they have not been checked yet, the numbers above are too good.',
    )
  }
  if (withoutText > 0) {
    console.log(
      withoutText === 1
        ? '1 recording has no text and was left out.'
        : `${withoutText} recordings have no text and were left out.`,
    )
  }

  if (!quiet && show > 0) {
    const worst = scores
      .filter((score) => score.wordEdits > 0)
      .sort((a, b) => b.wordEdits / Math.max(1, b.words) - a.wordEdits / Math.max(1, a.words))
      .slice(0, show)
    if (worst.length > 0) console.log(`\nMost errors ([heard → meant], [+missing], [-extra]):`)
    for (const score of worst) {
      const edits = alignWords(comparableWords(score.item.intended), comparableWords(score.heard))
      console.log(`\n${score.item.name}  ${score.wordEdits} of ${score.words} words`)
      console.log(`  ${describeEdits(edits)}`)
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
