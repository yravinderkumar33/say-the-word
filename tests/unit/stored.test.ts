import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogFile } from '../../src/main/log-file'
import { deleteRecordings, recordingFacts, sizeOf } from '../../src/main/privacy/stored'
import { UsageStore } from '../../src/main/store/usage'

let dir: string

/** The three files evaluation mode writes for a dictation. */
function saveDictation(name: string): void {
  writeFileSync(join(dir, `${name}.wav`), Buffer.alloc(1_000))
  writeFileSync(join(dir, `${name}.txt`), 'what was meant\n')
  writeFileSync(join(dir, `${name}.heard.txt`), 'what was heard\n')
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'flow-stored-'))
})

afterEach(() => {
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('the saved dictations of evaluation mode', () => {
  it('are counted by dictation, with the size of all their files', () => {
    saveDictation('20261003-214512-7')
    saveDictation('20261004-090000-1')

    expect(recordingFacts(dir)).toEqual({
      count: 2,
      bytes: 2 * (1_000 + 15 + 15),
      scanFailed: false,
    })
  })

  it('are none when the folder does not exist', () => {
    expect(recordingFacts(join(dir, 'nowhere'))).toEqual({ count: 0, bytes: 0, scanFailed: false })
    expect(deleteRecordings(join(dir, 'nowhere'))).toEqual({
      deleted: 0,
      failed: 0,
      scanFailed: false,
    })
  })

  it('are deleted, and nothing else in the folder is touched', () => {
    saveDictation('20261003-214512-7')
    writeFileSync(join(dir, 'notes.txt'), 'my own notes')
    mkdirSync(join(dir, 'scores'))

    expect(deleteRecordings(dir)).toEqual({ deleted: 1, failed: 0, scanFailed: false })
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'scores'])
    expect(recordingFacts(dir)).toEqual({ count: 0, bytes: 0, scanFailed: false })
  })

  it('says how many could not be deleted, and leaves those whole', () => {
    saveDictation('20261003-214512-7')
    saveDictation('20261004-090000-1')
    // A folder that cannot be written to: nothing in it can be removed.
    chmodSync(dir, 0o500)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(deleteRecordings(dir)).toEqual({ deleted: 0, failed: 2, scanFailed: false })
    expect(recordingFacts(dir).count).toBe(2)
  })

  it('are not taken for none when the folder cannot be looked into', () => {
    saveDictation('20261003-214512-7')
    chmodSync(dir, 0o000)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(recordingFacts(dir)).toEqual({ count: 0, bytes: 0, scanFailed: true })
    // Not deleted is not done: the recording may still be there, and it is.
    expect(deleteRecordings(dir)).toEqual({ deleted: 0, failed: 0, scanFailed: true })
    chmodSync(dir, 0o700)
    expect(recordingFacts(dir)).toMatchObject({ count: 1, scanFailed: false })
  })
})

describe('the log and the counts', () => {
  it('measures the log with the one before it, and deletes both', () => {
    const log = new LogFile(join(dir, 'main.log'), 60)
    log.write('a first line that fills the file')
    log.write('a second line that starts a new one')

    expect(log.bytesOnDisk).toBe(sizeOf(log.path) + sizeOf(log.previousPath))
    expect(sizeOf(log.previousPath)).toBeGreaterThan(0)

    expect(log.clear()).toBe(true)
    expect(log.bytesOnDisk).toBe(0)

    // The next line starts a new file.
    log.write('after')
    expect(sizeOf(log.path)).toBeGreaterThan(0)
    expect(sizeOf(log.previousPath)).toBe(0)
  })

  it('forgets the counts and removes their file', () => {
    const file = join(dir, 'usage.json')
    const usage = new UsageStore(file)
    usage.add({ words: 12, mode: 'verbatim', releaseToPasteMs: 400 })
    expect(usage.bytesOnDisk).toBeGreaterThan(0)

    expect(usage.clear()).toBe(true)

    expect(usage.bytesOnDisk).toBe(0)
    expect(usage.snapshot()).toEqual({
      version: 1,
      words: {},
      timings: { verbatim: [], cleaned: [] },
    })
    expect(new UsageStore(file).snapshot().words).toEqual({})
  })
})
