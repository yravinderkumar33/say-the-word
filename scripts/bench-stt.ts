// Measures the speech recognizer on this machine: load time, decode time, memory,
// and word error rate on the generated fixtures. Prints a Markdown table.
//
//   npm run bench:stt -- --threads 4
//
// Run it once per thread count: each run is a fresh process, so memory figures are
// not inflated by an earlier recognizer.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SAMPLE_RATE } from '../src/shared/audio-format'
import { decodeWav } from '../src/shared/wav'
import { wordErrorRate } from '../src/shared/wer'
import { loadParakeet } from '../src/main/stt/engines/sherpa-parakeet'
import { DEFAULT_MODEL } from '../src/main/stt/model-catalog'
import { isModelReady, modelDir } from '../src/main/stt/model-store'
import { modelsRoot } from '../src/main/stt/models-dir'

const megabytes = (bytes: number): string => (bytes / 1_048_576).toFixed(0)
/** Peak resident memory of this process. Node reports it in kilobytes on every platform. */
const peakRss = (): number => process.resourceUsage().maxRSS * 1_024

async function main(): Promise<void> {
  const threadsFlag = process.argv.indexOf('--threads')
  const threads = threadsFlag === -1 ? 4 : Number(process.argv[threadsFlag + 1])
  const root = modelsRoot()
  if (!(await isModelReady(root, DEFAULT_MODEL))) {
    throw new Error('The speech model is not downloaded. Run: npm run models:download')
  }

  const audioDir = join(__dirname, '..', 'tests', 'fixtures', 'audio')
  const filterFlag = process.argv.indexOf('--filter')
  const filter = filterFlag === -1 ? '' : (process.argv[filterFlag + 1] ?? '')
  const files = readdirSync(audioDir)
    .filter((name) => name.endsWith('.wav') && name.includes(filter))
    .sort()
  if (files.length === 0) throw new Error('No fixtures. Run: npm run fixtures')

  const rssBefore = process.memoryUsage().rss
  const { engine, loadMs } = await loadParakeet(modelDir(root, DEFAULT_MODEL), threads)
  const rssLoaded = process.memoryUsage().rss

  console.log(`\n### ${engine.id}, ${threads} threads\n`)
  console.log(`- Load: ${loadMs.toFixed(0)} ms`)
  console.log(
    `- Memory after load: ${megabytes(rssLoaded)} MB (process started at ${megabytes(rssBefore)} MB)\n`,
  )
  console.log('| Fixture | Audio (s) | Decode (ms) | Times real time | Word error rate |')
  console.log('|---|---|---|---|---|')

  // The first decode pays one-off costs, so it is done once and not reported.
  const firstFile = files[0]
  if (firstFile) {
    await engine.transcribe(decodeWav(readFileSync(join(audioDir, firstFile))).samples)
  }

  for (const name of files) {
    const audio = decodeWav(readFileSync(join(audioDir, name)))
    if (audio.sampleRate !== SAMPLE_RATE) throw new Error(`${name} is not ${SAMPLE_RATE} Hz`)
    const reference = readFileSync(join(audioDir, `${name.split('.')[0]}.txt`), 'utf8')
    const seconds = audio.samples.length / SAMPLE_RATE

    let best = Infinity
    let text = ''
    for (let run = 0; run < 3; run++) {
      const result = await engine.transcribe(audio.samples)
      best = Math.min(best, result.decodeMs)
      text = result.text
    }
    const wer = wordErrorRate(reference, text)
    console.log(
      `| ${name.replace('.wav', '')} | ${seconds.toFixed(1)} | ${best.toFixed(0)} | ${(
        (seconds * 1_000) /
        best
      ).toFixed(0)}× | ${(wer * 100).toFixed(1)}% |`,
    )
    if (process.argv.includes('--show-text')) console.log(`\n> ${text}\n`)
  }

  console.log(`\n- Peak memory during the run: ${megabytes(peakRss())} MB`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
