import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EvaluationRecorder, evaluationDir } from '../../src/main/dictation/evaluation-recorder'

let root: string
let dir: string
const at = (iso: string) => () => new Date(iso)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evaluation-'))
  // A folder that does not exist yet: the recorder creates it when it first writes.
  dir = join(root, 'evaluation')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('EvaluationRecorder', () => {
  it('names a dictation by the time it was made and its session', () => {
    const recorder = new EvaluationRecorder(dir, at('2026-10-03T21:45:12'))

    expect(basename(recorder.audioPath(7))).toBe('20261003-214512-7.wav')
  })

  it('gives a session the same name every time it is asked', () => {
    let now = new Date('2026-10-03T21:45:12')
    const recorder = new EvaluationRecorder(dir, () => now)
    const first = recorder.audioPath(7)
    now = new Date('2026-10-03T21:45:59')

    expect(recorder.audioPath(7)).toBe(first)
    expect(recorder.audioPath(8)).not.toBe(first)
  })

  it('saves what was heard twice: once to correct, once to keep', () => {
    const recorder = new EvaluationRecorder(dir, at('2026-10-03T21:45:12'))
    recorder.audioPath(7)

    recorder.saveText(7, 'Send me the report.')

    expect(readdirSync(dir).sort()).toEqual([
      '20261003-214512-7.heard.txt',
      '20261003-214512-7.txt',
    ])
    expect(readFileSync(join(dir, '20261003-214512-7.txt'), 'utf8')).toBe('Send me the report.\n')
    expect(readFileSync(join(dir, '20261003-214512-7.heard.txt'), 'utf8')).toBe(
      'Send me the report.\n',
    )
  })

  it('writes nothing until there is text to save', () => {
    const recorder = new EvaluationRecorder(dir, at('2026-10-03T21:45:12'))

    recorder.audioPath(7)

    expect(() => readdirSync(dir)).toThrow()
  })
})

describe('evaluationDir', () => {
  it('can be moved with an environment variable, which tests use', () => {
    const before = process.env['WHISPER_FLOW_EVAL_DIR']
    process.env['WHISPER_FLOW_EVAL_DIR'] = '/tmp/somewhere-else'
    try {
      expect(evaluationDir()).toBe('/tmp/somewhere-else')
    } finally {
      if (before === undefined) delete process.env['WHISPER_FLOW_EVAL_DIR']
      else process.env['WHISPER_FLOW_EVAL_DIR'] = before
    }
  })

  it('is outside the repository by default', () => {
    const before = process.env['WHISPER_FLOW_EVAL_DIR']
    delete process.env['WHISPER_FLOW_EVAL_DIR']
    try {
      expect(evaluationDir()).toMatch(/Library\/Application Support\/Whisper Flow\/evaluation$/)
    } finally {
      if (before !== undefined) process.env['WHISPER_FLOW_EVAL_DIR'] = before
    }
  })
})
