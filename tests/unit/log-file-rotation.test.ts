import type * as FsRuntime from 'node:fs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogFile } from '../../src/main/log-file'

// As some file systems do: a file is not moved over one that is already there.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof FsRuntime>()
  return {
    ...real,
    renameSync: (from: string, to: string): void => {
      if (real.existsSync(to)) {
        throw Object.assign(new Error(`EEXIST: file already exists, rename '${from}'`), {
          code: 'EEXIST',
        })
      }
      real.renameSync(from, to)
    },
  }
})

let dir: string
const at = new Date(2026, 9, 5, 12, 0, 0, 0)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whisper-flow-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('LogFile, where the file before cannot be moved over', () => {
  it('removes the old one and keeps the full one in its place', () => {
    const file = new LogFile(join(dir, 'main.log'), 120, () => at)
    writeFileSync(file.previousPath, 'from an earlier run')

    file.write('a'.repeat(60))
    file.write('b'.repeat(60))

    expect(readFileSync(file.previousPath, 'utf8')).toContain('a'.repeat(60))
    expect(readFileSync(file.path, 'utf8')).toContain('b'.repeat(60))
    expect(readFileSync(file.path, 'utf8')).not.toContain('a'.repeat(60))
  })
})
