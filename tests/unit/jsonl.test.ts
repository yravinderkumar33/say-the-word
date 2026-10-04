import { describe, expect, it } from 'vitest'
import { createLineSplitter } from '@shared/jsonl'

function collect(chunks: string[]): string[] {
  const lines: string[] = []
  const push = createLineSplitter((line) => lines.push(line))
  for (const chunk of chunks) push(chunk)
  return lines
}

describe('createLineSplitter', () => {
  it('emits one line per newline-terminated message', () => {
    expect(collect(['{"a":1}\n{"b":2}\n'])).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('joins a line that arrives split across chunks', () => {
    expect(collect(['{"type":"re', 'ady","proto', 'col":1}\n'])).toEqual([
      '{"type":"ready","protocol":1}',
    ])
  })

  it('holds an unterminated line until its newline arrives', () => {
    const lines: string[] = []
    const push = createLineSplitter((line) => lines.push(line))

    push('{"id":1}')
    expect(lines).toEqual([])

    push('\n')
    expect(lines).toEqual(['{"id":1}'])
  })

  it('handles several lines and a partial tail in one chunk', () => {
    expect(collect(['one\ntwo\nthr', 'ee\n'])).toEqual(['one', 'two', 'three'])
  })

  it('skips blank lines and strips carriage returns', () => {
    expect(collect(['first\r\n\n\r\nsecond\n'])).toEqual(['first', 'second'])
  })
})
