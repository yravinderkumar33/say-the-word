// One at a time. `npm run test:app`, `npm run pictures`, `npm run smoke` and `npm run pack`
// each build into `out/`, and a build empties that folder first. Started while an app
// under test is running from it, a build takes the files from under the app, which reads
// them as it goes: a window opened later, or a speech worker started again, finds
// another build's files or none. The failures that follow look like faults in the app.
//
// So whoever builds, or runs the app from `out/`, says so in a file, and whoever comes
// next looks at it first. A holder that is no longer running holds nothing.
import { spawnSync } from 'node:child_process'
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Not ours to signal, and there all the same.
    return error.code === 'EPERM'
  }
}

/**
 * When the process with this number started, as `ps` prints it, or null when `ps` cannot
 * say. A number is handed out again once its process has ended: with the time it started
 * as well, a note names one process, however long that process runs.
 */
const startedAt = (pid) => {
  const listed = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  return listed.status === 0 ? listed.stdout.trim() || null : null
}

/**
 * Whether the process a note names still has the build output: it is running, and it is
 * the one that wrote the note, not a later one given its number. One whose start cannot
 * be read is taken to be the one.
 */
function stillHolds(held, { isRunning = running, started = startedAt }) {
  if (typeof held?.pid !== 'number' || !isRunning(held.pid)) return false
  const now = typeof held.started === 'string' ? started(held.pid) : null
  return now === null || now === held.started
}

/** True when the holder is this process, or the command line this process is a step of. */
const ours = (held) => held.pid === process.pid || held.pid === process.ppid

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The lock on the build output, kept in the file `note`. `facts` stand in for `ps` in tests. */
export function outputLock(note, facts = {}) {
  /** `text` in a file of this process's own beside the note, whose path it returns. */
  const draft = (text) => {
    const path = `${note}.${process.pid}`
    writeFileSync(path, text)
    return path
  }
  /** Puts `text` where the note goes, unless a note is there: true when it did. */
  const create = (text) => {
    const path = draft(text)
    try {
      // A link appears whole or not at all, and never over a note that is there: of two
      // that start at once, one makes it, and nobody reads half a note.
      linkSync(path, note)
      return true
    } catch (error) {
      if (error.code === 'EEXIST') return false
      throw error
    } finally {
      rmSync(path, { force: true })
    }
  }
  /** Takes the note away if it still reads `text`. One that another has made since stays. */
  const remove = (text) => {
    const aside = `${note}.${process.pid}.old`
    try {
      renameSync(note, aside)
    } catch {
      return
    }
    if (read(aside) !== text) {
      try {
        linkSync(aside, note)
      } catch {
        // A third has made one in the meantime: that one stands.
      }
    }
    rmSync(aside, { force: true })
  }

  /**
   * Takes the build output for `pid` (this process unless another is named), for as long
   * as that process runs. Returns null once it has it, or why it cannot have it now, in
   * words. A script that takes it for itself gives it back when it ends.
   */
  function take(what, pid = process.pid) {
    mkdirSync(dirname(note), { recursive: true })
    const mine = JSON.stringify({ pid, what, started: (facts.started ?? startedAt)(pid) })
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!create(mine)) {
        const found = read(note)
        if (found === null) continue
        const held = parse(found)
        if (!stillHolds(held, facts)) {
          // Left by a process that has ended.
          remove(found)
          continue
        }
        if (!ours(held)) {
          return (
            `"${held.what}" is running (process ${held.pid}) and uses the build in out/. ` +
            'A build now would take the files from under it. Wait for it to end.'
          )
        }
        renameSync(draft(mine), note)
      }
      if (pid === process.pid) process.once('exit', () => remove(mine))
      return null
    }
    return 'The note in out/ on who is using the build kept changing. Try again.'
  }

  return { take }
}

/** `take` of the lock on `out/`. */
export const { take } = outputLock(join(root, 'out', '.in-use.json'))
