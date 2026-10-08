import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { kindAndPlace, LogFile, mirrorConsoleTo } from '../../src/main/log-file'

let dir: string
const at = new Date(2026, 9, 3, 22, 7, 5, 142)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'whisper-flow-log-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('LogFile', () => {
  it('writes each line with the local time, to the millisecond', () => {
    const file = new LogFile(join(dir, 'main.log'), 1_000, () => at)

    file.write('[paste] session 3: pasted')

    expect(readFileSync(file.path, 'utf8')).toBe(
      '2026-10-03 22:07:05.142 [paste] session 3: pasted\n',
    )
  })

  it('creates the folder it is given', () => {
    const file = new LogFile(join(dir, 'logs', 'deep', 'main.log'), 1_000, () => at)

    file.write('first')

    expect(readFileSync(file.path, 'utf8')).toContain('first')
  })

  it('stamps every line of an entry that spans several', () => {
    const file = new LogFile(join(dir, 'main.log'), 1_000, () => at)

    file.write('error: it broke\n    at somewhere')

    expect(readFileSync(file.path, 'utf8').split('\n').filter(Boolean)).toEqual([
      '2026-10-03 22:07:05.142 error: it broke',
      '2026-10-03 22:07:05.142     at somewhere',
    ])
  })

  it('starts a new file when the size limit is reached, and keeps the one before', () => {
    const file = new LogFile(join(dir, 'main.log'), 120, () => at)

    file.write('a'.repeat(60))
    file.write('b'.repeat(60))

    expect(readFileSync(file.previousPath, 'utf8')).toContain('a'.repeat(60))
    expect(readFileSync(file.path, 'utf8')).toContain('b'.repeat(60))
    expect(readFileSync(file.path, 'utf8')).not.toContain('a'.repeat(60))
  })

  it('counts what an earlier run left in the file', () => {
    const path = join(dir, 'main.log')
    writeFileSync(path, 'x'.repeat(110))
    const file = new LogFile(path, 120, () => at)

    file.write('next')

    expect(readFileSync(file.previousPath, 'utf8')).toBe('x'.repeat(110))
    expect(readFileSync(path, 'utf8')).toContain('next')
  })

  it('carries on in a new file when the log is deleted while the app runs', () => {
    const file = new LogFile(join(dir, 'main.log'), 150, () => at)
    file.write('a'.repeat(60))
    rmSync(file.path)

    // Due for rotation, with nothing left to rotate.
    file.write('b'.repeat(60))
    file.write('c'.repeat(20))

    expect(existsSync(file.previousPath)).toBe(false)
    expect(readFileSync(file.path, 'utf8')).toContain('b'.repeat(60))
    expect(readFileSync(file.path, 'utf8')).toContain('c'.repeat(20))
  })

  it('stays within its size when the file before it cannot be replaced', () => {
    // A folder where the old log goes: the full file cannot be moved there.
    mkdirSync(join(dir, 'main.old.log'))
    writeFileSync(join(dir, 'main.old.log', 'kept'), 'x')
    const file = new LogFile(join(dir, 'main.log'), 200, () => at)

    for (let line = 0; line < 40; line++) file.write(`[probe] line ${line} ${'.'.repeat(20)}`)

    expect(statSync(file.path).size).toBeLessThanOrEqual(200)
    expect(readFileSync(file.path, 'utf8')).toContain('[probe] line 39')
    // What is in the way is not the log's to delete.
    expect(readFileSync(join(dir, 'main.old.log', 'kept'), 'utf8')).toBe('x')
  })

  it('writes again once the cause of a failed write has passed', () => {
    // A file where the folder should be, then the folder itself.
    writeFileSync(join(dir, 'logs'), '')
    const file = new LogFile(join(dir, 'logs', 'main.log'), 1_000, () => at)
    file.write('lost')
    rmSync(join(dir, 'logs'))

    file.write('kept')

    expect(readFileSync(file.path, 'utf8')).toBe('2026-10-03 22:07:05.142 kept\n')
  })

  it('gives up quietly when the file cannot be written', () => {
    // A file where the folder should be.
    writeFileSync(join(dir, 'blocked'), '')
    const file = new LogFile(join(dir, 'blocked', 'main.log'), 1_000, () => at)

    expect(() => {
      file.write('one')
      file.write('two')
    }).not.toThrow()
  })
})

describe('kindAndPlace', () => {
  it('says what kind of error it was and where, and nothing of what it quotes', () => {
    let thrown: unknown
    try {
      JSON.parse('the words someone said')
    } catch (error) {
      thrown = error
    }

    const described = kindAndPlace(thrown)

    expect(described.startsWith('SyntaxError\n    at ')).toBe(true)
    expect(described).toContain('log-file.test.ts')
    expect(described).not.toContain('someone said')
  })

  it('names something thrown that is not an error by its type only', () => {
    expect(kindAndPlace('the words someone said')).toBe('something that is not an error (string)')
  })
})

describe('mirrorConsoleTo', () => {
  it('keeps printing, and writes the same text to the file', () => {
    const file = new LogFile(join(dir, 'main.log'), 10_000, () => at)
    const printed: unknown[][] = []
    const realLog = console.log
    const realError = console.error
    console.log = (...args: unknown[]) => printed.push(args)
    console.error = (...args: unknown[]) => printed.push(args)
    const restore = mirrorConsoleTo(file)
    try {
      console.log('[state] %s (session %d)', 'holding', 4)
      console.error('[flow-helper] exited')
    } finally {
      restore()
      console.log = realLog
      console.error = realError
    }

    expect(printed).toEqual([['[state] %s (session %d)', 'holding', 4], ['[flow-helper] exited']])
    expect(readFileSync(file.path, 'utf8')).toBe(
      '2026-10-03 22:07:05.142 [state] holding (session 4)\n' +
        '2026-10-03 22:07:05.142 error: [flow-helper] exited\n',
    )
  })

  it('stops when undone', () => {
    const file = new LogFile(join(dir, 'main.log'), 10_000, () => at)
    const realLog = console.log
    console.log = () => {}
    const restore = mirrorConsoleTo(file)
    restore()
    console.log('after')
    console.log = realLog

    expect(() => readFileSync(file.path, 'utf8')).toThrow()
  })
})
