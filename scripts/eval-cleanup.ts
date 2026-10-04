// Compares the three texts Cleaned mode can produce (what was heard, the rules-only
// text, and the final text after the local model and the guard) against what was meant.
//
//   npm run eval:cleanup                      your saved dictations (tray → Evaluation)
//   npm run eval:cleanup -- --samples         the written samples in tests/fixtures/cleanup
//   npm run eval:cleanup -- --model <name>    another Ollama model (default: qwen3.5:4b)
//   npm run eval:cleanup -- --dir <folder>    another folder of dictations
//   npm run eval:cleanup -- --quiet           numbers only: nothing that was said is printed
//
// It talks to the Ollama on this machine and nothing else, through the same code the
// app uses: a model that does not run locally is refused before any text is sent.
//
// It also checks what must always hold, and exits with an error if it does not:
// there is always a final text, cleanup never takes longer than its ceiling, and text
// the guard refused is never used.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { FRAME_SAMPLES, SAMPLE_RATE } from '../src/shared/audio-format'
import { decodeWav } from '../src/shared/wav'
import { alignWords, comparableWords, correctionRate, type WordEdit } from '../src/shared/wer'
import { LocalOnlyGate } from '../src/main/cleanup/local-only'
import { OllamaClient } from '../src/main/cleanup/ollama-client'
import { CLEANUP_CEILING_MS, Refiner, type Refined } from '../src/main/cleanup/refiner'
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
const useSamples = args.includes('--samples')
const quiet = args.includes('--quiet')
const model = option('--model') ?? 'qwen3.5:4b'
const dir =
  option('--dir') ??
  process.env['WHISPER_FLOW_EVAL_DIR'] ??
  join(homedir(), 'Library', 'Application Support', 'Whisper Flow', 'evaluation')

interface Item {
  name: string
  /** What the recognizer heard (or, for a written sample, what was "spoken"). */
  heard: string
  intended: string
}

function loadSamples(): Item[] {
  const path = join(import.meta.dirname, '..', 'tests', 'fixtures', 'cleanup', 'samples.json')
  const samples = JSON.parse(readFileSync(path, 'utf8')) as Array<{
    spoken: string
    intended: string
  }>
  return samples.map((sample, index) => ({
    name: `sample ${index + 1}`,
    heard: sample.spoken,
    intended: sample.intended,
  }))
}

/** Runs each saved recording through the recognizer, the way the app would. */
async function loadDictations(): Promise<Item[]> {
  if (!existsSync(dir)) return []
  const names = readdirSync(dir)
    .filter((file) => file.endsWith('.wav') && existsSync(join(dir, file.replace(/wav$/, 'txt'))))
    .map((file) => file.slice(0, -'.wav'.length))
    .sort()
  if (names.length === 0) return []

  const root = modelsRoot()
  if (!(await adoptModel(root, DEFAULT_MODEL)).ready) {
    throw new Error('The speech model is not downloaded. Run: npm run models:download')
  }
  const speech = modelDir(root, DEFAULT_MODEL)
  const { engine } = await loadParakeet(speech, 4)
  const detector = new VoiceDetector(join(speech, 'silero_vad.onnx'))

  const items: Item[] = []
  let session = 0
  for (const name of names) {
    const audio = decodeWav(readFileSync(join(dir, `${name}.wav`)))
    if (audio.sampleRate !== SAMPLE_RATE) continue
    session += 1
    const events: TranscriberEvent[] = []
    const transcriber = new Transcriber(engine, detector, (event) => events.push(event))
    transcriber.begin(session)
    let frames = 0
    for (let offset = 0; offset < audio.samples.length; offset += FRAME_SAMPLES) {
      transcriber.acceptFrame(
        session,
        frames++,
        audio.samples.slice(offset, offset + FRAME_SAMPLES),
      )
    }
    await transcriber.end(session, frames)
    const result = events.find((event) => event.t === 'final')
    const intended = readFileSync(join(dir, `${name}.txt`), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(#[\p{L}\p{N}-]+\s*)+$/u.test(line))
      .join('\n')
      .trim()
    if (result?.t === 'final' && intended) items.push({ name, heard: result.text, intended })
  }
  return items
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
const percentile = (values: number[], share: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)] ?? 0
}

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
  const client = new OllamaClient()
  const version = await client.version(1_000)
  if (version === null) throw new Error('Ollama is not running on this machine.')
  const gate = new LocalOnlyGate(client)
  const verdict = await gate.check(model)
  if (!verdict.local) throw new Error(`${model} cannot be used: ${verdict.reason}.`)

  const items = useSamples ? loadSamples() : await loadDictations()
  if (items.length === 0) {
    console.log(`No dictations with text in ${dir}. Try --samples, or record some first.`)
    return
  }

  const refiner = new Refiner({ client, gate, model: () => model, dictionary: () => [] })
  // The first request pays for loading the model; the app does this at key-down.
  const warmStarted = performance.now()
  await client.warm(model, [{ role: 'user', content: 'ready' }])
  const warmMs = performance.now() - warmStarted

  const results: Array<{ item: Item; refined: Refined }> = []
  const violations: string[] = []
  for (const item of items) {
    const refined = await refiner.refine(item.heard, new AbortController().signal)
    results.push({ item, refined })
    if (refined.final.length === 0) violations.push(`${item.name}: no final text`)
    if (refined.cleanupMs > CLEANUP_CEILING_MS + 500) {
      violations.push(`${item.name}: cleanup took ${refined.cleanupMs} ms`)
    }
    if (refined.note !== 'cleaned' && refined.final !== refined.rules) {
      violations.push(`${item.name}: text was used although the note is ${refined.note}`)
    }
  }

  const mean = (pick: (entry: (typeof results)[number]) => number): number =>
    results.reduce((total, entry) => total + pick(entry), 0) / results.length
  const asked = results.filter(
    ({ refined }) => !['short', 'tooLong', 'noModel'].includes(refined.note),
  )
  const cleaned = results.filter(({ refined }) => refined.note === 'cleaned')
  const times = asked.map(({ refined }) => refined.cleanupMs)

  console.log(
    `Ollama ${version}, model ${model}, ${results.length} ${useSamples ? 'written samples' : 'dictations'}.`,
  )
  console.log(
    `Loading the model took ${(warmMs / 1000).toFixed(1)} s (the app does this while you speak).\n`,
  )
  console.log('| Text | Corrections needed, on average |')
  console.log('|---|---|')
  console.log(
    `| As heard | ${percent(mean(({ item }) => correctionRate(item.intended, item.heard)))} |`,
  )
  console.log(
    `| Rules only | ${percent(mean(({ item, refined }) => correctionRate(item.intended, refined.rules)))} |`,
  )
  console.log(
    `| Final (model when accepted, else rules) | ${percent(mean(({ item, refined }) => correctionRate(item.intended, refined.final)))} |`,
  )

  console.log(
    `\nThe model was asked ${asked.length} times; its text was used ${cleaned.length} times.`,
  )
  const notes = new Map<string, number>()
  for (const { refined } of results) notes.set(refined.note, (notes.get(refined.note) ?? 0) + 1)
  for (const [note, count] of [...notes].sort((a, b) => b[1] - a[1]))
    console.log(`  ${note}: ${count}`)
  if (times.length > 0) {
    console.log(
      `Cleanup time when the model was asked: median ${percentile(times, 0.5)} ms, ` +
        `95th percentile ${percentile(times, 0.95)} ms, slowest ${Math.max(...times)} ms ` +
        `(ceiling ${CLEANUP_CEILING_MS} ms).`,
    )
  }

  if (!quiet) {
    console.log(
      '\nEach one, final text against what was meant ([final → meant], [+missing], [-extra]):',
    )
    for (const { item, refined } of results) {
      const edits = alignWords(comparableWords(item.intended), comparableWords(refined.final))
      const changed = edits.some((edit) => edit.kind !== 'same')
      console.log(`\n${item.name}  ${refined.note}, ${refined.cleanupMs} ms`)
      console.log(`  final: ${refined.final}`)
      if (changed) console.log(`  words: ${describeEdits(edits)}`)
    }
    console.log(
      '\nRead the ones marked "cleaned" and ask of each: does it still say what was meant? ' +
        'A cleanup that changes meaning is worse than none.',
    )
  }

  if (violations.length > 0) {
    console.error(`\nBroken guarantees:\n${violations.map((line) => `  ${line}`).join('\n')}`)
    process.exit(1)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
