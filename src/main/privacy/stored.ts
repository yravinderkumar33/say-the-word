import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What the app keeps on this Mac besides the history, measured when it is asked for:
 * the recordings of evaluation mode, the log and the word counts.
 */

/** The files evaluation mode writes for one dictation: `20261003-214512-7.wav`, `.txt`, `.heard.txt`. */
const RECORDING_FILE = /^(\d{8}-\d{6}-\d+)\.(?:wav|txt|heard\.txt)$/

export interface RecordingFacts {
  /** How many dictations have files in the folder. */
  count: number
  bytes: number
  /** The folder is there and could not be looked into: what it holds is not known. */
  scanFailed: boolean
}

/** The saved dictations in the evaluation folder. Files of any other name are not counted, or touched. */
export function recordingFacts(dir: string): RecordingFacts {
  const { files, scanFailed } = recordingFiles(dir)
  const names = new Set<string>()
  let bytes = 0
  for (const file of files) {
    names.add(file.dictation)
    bytes += sizeOf(join(dir, file.name))
  }
  return { count: names.size, bytes, scanFailed }
}

/**
 * Deletes the saved dictations. A dictation counts as deleted when none of its files
 * is left; one whose file could not be removed (it is open elsewhere, or protected)
 * is counted as failed, and its other files are left with it. A folder that could not
 * be looked into is said as such: what is in it was not deleted.
 */
export function deleteRecordings(dir: string): {
  deleted: number
  failed: number
  scanFailed: boolean
} {
  const { files, scanFailed } = recordingFiles(dir)
  const byDictation = new Map<string, string[]>()
  for (const file of files) {
    byDictation.set(file.dictation, [...(byDictation.get(file.dictation) ?? []), file.name])
  }
  let deleted = 0
  let failed = 0
  for (const [dictation, names] of byDictation) {
    try {
      // The recording first: if that cannot go, the text stays with it.
      const recordingFirst = [...names].sort(
        (a, b) => Number(b.endsWith('.wav')) - Number(a.endsWith('.wav')),
      )
      for (const name of recordingFirst) rmSync(join(dir, name))
      deleted += 1
    } catch (error) {
      failed += 1
      console.error(
        `[privacy] could not delete the saved dictation ${dictation}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
    }
  }
  return { deleted, failed, scanFailed }
}

/** The saved dictations' files. No folder means none; a folder that cannot be read does not. */
function recordingFiles(dir: string): {
  files: Array<{ name: string; dictation: string }>
  scanFailed: boolean
} {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (error) {
    // Not logged: the Privacy page asks for these facts every second and a half.
    return { files: [], scanFailed: (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  }
  const files = names.flatMap((name) => {
    const dictation = RECORDING_FILE.exec(name)?.[1]
    return dictation ? [{ name, dictation }] : []
  })
  return { files, scanFailed: false }
}

/** The size of a file in bytes; zero when there is none. */
export function sizeOf(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
