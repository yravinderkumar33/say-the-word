// How the storage process performs with a large saved history: synthetic entries, a
// folder of its own, and the storage worker as built, in Electron's own Node. No window,
// key, microphone, clipboard, history or evaluation folder of the person at the Mac is
// touched. Build first (`npm run build`), while no app under test runs from `out/`.
//
// What it measures is the storage process alone, answering main's requests over the same
// `birpc` channel the app uses: how long it takes to start, to list the newest rows, to
// search and to take a write, and what main is handed with each answer. It does not
// measure main's queue of writes that wait: here every write is taken at once.
import { createBirpc } from 'birpc'
import { fork } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { take } from './lib/build-output.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The storage worker is run from the build in out/: nobody builds over it meanwhile.
const inUse = take('bench:storage')
if (inUse) {
  console.error(inUse)
  process.exit(1)
}
const electron = createRequire(import.meta.url)('electron')
const built = readdirSync(join(root, 'out/main')).find((name) =>
  /^storage-worker.*\.js$/.test(name),
)
if (!built) throw new Error('No storage worker in out/main: run `npm run build` first')
const worker = join(root, 'out/main', built)
const scratch = mkdtempSync(join(tmpdir(), 'flow-storage-bench-'))
// Electron's `process.parentPort`, stood in for by Node's IPC channel. A message that asks
// for the process's memory is answered here, beside the channel the worker uses.
const bootstrap = join(scratch, 'worker.cjs')
writeFileSync(
  bootstrap,
  `process.parentPort = {
     on: (_name, fn) => process.on('message', (data) => { if (!data || !data.memory) fn({ data }) }),
     postMessage: (data) => process.send(data),
   }
   process.on('message', (data) => {
     if (data && data.memory) process.send({ memory: { ...process.memoryUsage(), node: process.versions.node, sqlite: process.versions.sqlite } })
   })
   require(${JSON.stringify(worker)})`,
)

const row = {
  id: 'bench',
  endedAt: Date.now(),
  app: 'Synthetic',
  outcome: 'pasted',
  fetched: null,
  mode: 'verbatim',
  note: null,
  heard: 'synthetic '.repeat(100),
  written: 'benchmark ' + 'synthetic '.repeat(100),
  failure: null,
  audioMs: 4000,
  timings: { releaseToTextMs: 400, tidyMs: null, pasteMs: 30 },
}
const options = {
  history: { dir: join(scratch, 'history'), keep: 'forever', keepIsKnown: true, paused: false },
  usageFile: join(scratch, 'usage.json'),
  weekStartsOn: 1,
}

let child = null
let rpc = null
/** The snapshot handed over with the last answer: what main keeps of the storage. */
let snapshot = null
let memoryReply = null

async function request(op, args = []) {
  const answer = await rpc.request(op, args)
  if (answer.snapshot) snapshot = answer.snapshot
  if (answer.failed) throw new Error(`The storage process refused ${op}`)
  return answer.value
}
async function start() {
  const began = performance.now()
  child = fork(bootstrap, [], {
    execPath: electron,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  child.stderr.on('data', () => {})
  const forBirpc = new Set()
  child.on('message', (data) => {
    if (data && data.memory) memoryReply?.(data.memory)
    else for (const fn of forBirpc) fn(data)
  })
  rpc = createBirpc(
    {},
    {
      post: (data) => child.send(data),
      on: (fn) => void forBirpc.add(fn),
      timeout: 120_000,
    },
  )
  await request('init', [options])
  return performance.now() - began
}
function memory() {
  return new Promise((resolve) => {
    memoryReply = resolve
    child.send({ memory: true })
  })
}
async function stop() {
  const exited = new Promise((resolve) => child.once('exit', resolve))
  await request('close').catch(() => {})
  await exited
  rpc.$close()
  child = null
  rpc = null
}
function seed(count) {
  const db = new DatabaseSync(join(options.history.dir, 'history.sqlite'))
  db.exec(
    'PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA temp_store=MEMORY;PRAGMA secure_delete=ON;BEGIN IMMEDIATE',
  )
  const put = db.prepare(
    'INSERT OR IGNORE INTO history(id,ended_at,app,outcome,fetched,mode,note,heard,written,failure,audio_ms,release_ms,tidy_ms,paste_ms,preview,search_text,has_text) VALUES (?,?,?, ?,NULL,?,NULL,?,?,NULL,?,?,?,?,?,?,1)',
  )
  for (let i = 0; i < count; i++) {
    const text = `benchmark ${i} synthetic ${i % 100} ` + 'synthetic '.repeat(100)
    put.run(
      `seed-${String(i).padStart(7, '0')}`,
      row.endedAt - i,
      'Synthetic',
      'pasted',
      'verbatim',
      text,
      text,
      4000,
      400,
      null,
      30,
      text.slice(0, 240),
      (text + '\n' + text + '\nSynthetic').toLowerCase(),
    )
  }
  db.exec('COMMIT')
  db.close()
}
function summary(values) {
  const sorted = values.toSorted((a, b) => a - b)
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]
  const round = (value) => Math.round(value * 100) / 100
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), max: round(sorted.at(-1)) }
}
async function samples(op, args, n = 100) {
  const values = []
  for (let i = 0; i < n; i++) {
    const began = performance.now()
    await request(op, typeof args === 'function' ? args(i) : args)
    values.push(performance.now() - began)
  }
  return summary(values)
}

try {
  // The first start makes the database and its tables; then it is filled, and timed.
  await start()
  await stop()
  for (const count of [10_000, 100_000]) {
    seed(count)
    const startup = await start()
    const recent = await samples('history.page', [{ search: '', limit: 50 }])
    const search = await samples('history.page', [{ search: 'benchmark 73', limit: 50 }], 30)
    const writes = await samples('history.put', (i) => [
      { ...row, id: `write-${count}-${i}`, endedAt: Date.now() },
      false,
    ])
    const used = await memory()
    console.log(
      JSON.stringify({
        entries: count,
        startupMs: Math.round(startup),
        recentMs: recent,
        searchMs: search,
        writeAckMs: writes,
        snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
        storageProcessRssBytes: used.rss,
        databaseBytes: statSync(join(options.history.dir, 'history.sqlite')).size,
        node: used.node,
        sqlite: used.sqlite,
      }),
    )
    await stop()
  }
} finally {
  child?.kill()
  rmSync(scratch, { recursive: true, force: true })
}
