// Generates speech recordings for tests with the macOS text-to-speech voices.
// They exercise the plumbing: capture, the recognizer, chunking, timing.
// They say nothing about accuracy on a real voice; that is what the personal
// evaluation set is for.
//
//   npm run fixtures
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'tests', 'fixtures', 'audio')

// Numbers are written as digits because that is how the recognizer writes them; the
// voices read them aloud naturally, and the reference then matches what comes back.
const TEXTS = {
  short: 'Can you send me the quarterly report before Friday?',
  medium:
    'I was thinking we should move the meeting to Thursday at 3 in the afternoon. ' +
    'That gives the design team enough time to finish the drawings and send them over for review.',
  technical:
    'Deploy the Kubernetes cluster with Terraform, then update the database connection string ' +
    'in the config file and restart the API server.',
  numbers: 'The invoice total is $4,350, and it is due on the 21st of March.',
  long:
    'Thanks for the update on the release. I looked at the latency numbers this morning and the ' +
    'spike around 3 in the afternoon lines up with the new caching layer going live. ' +
    'I would like us to do three things. First, roll back the cache configuration today. ' +
    'Second, add an alert that fires when the 95th percentile goes above 200 milliseconds. ' +
    'Third, write a short report so the whole team understands what happened and what we changed.',
  'very-long':
    'Here are my notes from the planning meeting. We agreed that the first milestone is a small, ' +
    'dependable version of the product, and that nothing else matters until that works every day. ' +
    'The team will focus on three areas. The first is accuracy, because people stop using a tool ' +
    'that gets their words wrong. The second is speed, because waiting several seconds after every ' +
    'sentence breaks concentration. The third is trust, which means the text must only ever appear ' +
    'in the place where the person was typing. After that, we will look at the features people ask ' +
    'for most often. Several people mentioned a custom dictionary for names and technical terms. ' +
    'Others asked for a way to keep talking for a long time without holding a key. ' +
    'We will collect real recordings from daily use, measure how often the text needs a correction, ' +
    'and let those numbers decide what we build next. I will send a written summary to everyone ' +
    'tomorrow morning, and we can discuss the open questions on Thursday.',
}

/** British, American and Indian English; a voice that is not installed is skipped. */
const VOICES = ['Daniel', 'Samantha', 'Aman']

if (process.platform !== 'darwin') {
  console.log('fixtures: skipped (needs the macOS `say` command)')
  process.exit(0)
}

const installed = execFileSync('say', ['-v', '?'], { encoding: 'utf8' })
const voices = VOICES.filter((voice) => new RegExp(`^${voice}\\s`, 'm').test(installed))
mkdirSync(outDir, { recursive: true })

let made = 0
for (const [id, text] of Object.entries(TEXTS)) {
  writeFileSync(join(outDir, `${id}.txt`), `${text}\n`)
  for (const voice of voices) {
    const file = join(outDir, `${id}.${voice.toLowerCase()}.wav`)
    if (existsSync(file)) continue
    const result = spawnSync(
      'say',
      ['-v', voice, '-o', file, '--file-format=WAVE', '--data-format=LEI16@16000', text],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) {
      console.error(`fixtures: say failed for ${id} (${voice}): ${result.stderr.trim()}`)
      process.exit(1)
    }
    made += 1
  }
}
console.log(
  `fixtures: ${Object.keys(TEXTS).length} texts × ${voices.length} voices (${voices.join(', ')}) in ${outDir}; ${made} new`,
)
