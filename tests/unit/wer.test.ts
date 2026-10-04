import { describe, expect, it } from 'vitest'
import {
  alignWords,
  comparableWords,
  correctionRate,
  surfaceTokens,
  wordEditDistance,
  wordErrorRate,
} from '@shared/wer'

describe('comparableWords', () => {
  it('ignores case and punctuation', () => {
    expect(comparableWords('Hello, World! How are you?')).toEqual([
      'hello',
      'world',
      'how',
      'are',
      'you',
    ])
  })

  it('keeps apostrophes inside words and treats curly ones the same', () => {
    expect(comparableWords("Don't stop — it’s fine.")).toEqual(["don't", 'stop', "it's", 'fine'])
  })

  it('keeps digits and non-Latin letters', () => {
    expect(comparableWords('Call 911, s’il vous plaît; 你好')).toEqual([
      'call',
      '911',
      "s'il",
      'vous',
      'plaît',
      '你好',
    ])
  })

  it('returns nothing for empty or punctuation-only text', () => {
    expect(comparableWords('  ...  ')).toEqual([])
  })
})

describe('wordEditDistance', () => {
  it.each([
    ['identical', ['a', 'b', 'c'], ['a', 'b', 'c'], 0],
    ['one substitution', ['a', 'b', 'c'], ['a', 'x', 'c'], 1],
    ['one deletion', ['a', 'b', 'c'], ['a', 'c'], 1],
    ['one insertion', ['a', 'c'], ['a', 'b', 'c'], 1],
    ['everything different', ['a', 'b'], ['x', 'y', 'z'], 3],
    ['empty hypothesis', ['a', 'b'], [], 2],
    ['empty reference', [], ['a'], 1],
  ])('%s', (_label, reference, hypothesis, expected) => {
    expect(wordEditDistance(reference, hypothesis)).toBe(expected)
  })
})

describe('wordErrorRate', () => {
  it('is zero when only case and punctuation differ', () => {
    expect(
      wordErrorRate('Send me the report before Friday.', 'send me the report before friday'),
    ).toBe(0)
  })

  it('is the share of reference words that need an edit', () => {
    expect(
      wordErrorRate('send me the report before friday', 'send me a report friday'),
    ).toBeCloseTo(2 / 6)
  })

  it('can exceed one when the hypothesis is much longer', () => {
    expect(wordErrorRate('yes', 'yes of course I will do that')).toBe(6)
  })

  it('handles an empty reference', () => {
    expect(wordErrorRate('', '')).toBe(0)
    expect(wordErrorRate('', 'something')).toBe(1)
  })
})

describe('numbers in comparableWords', () => {
  it('treats a grouped and an ungrouped number as the same word', () => {
    expect(comparableWords('The total is $4,350.')).toEqual(['the', 'total', 'is', '4350'])
    expect(wordErrorRate('It costs $1,250,000 today', 'it costs $1250000 today')).toBe(0)
  })

  it('still separates numbers in a list', () => {
    expect(comparableWords('rooms 12, 14 and 300')).toEqual(['rooms', '12', '14', 'and', '300'])
    expect(comparableWords('1,2,3')).toEqual(['1', '2', '3'])
  })
})

describe('surfaceTokens', () => {
  it('keeps capitals and makes each punctuation mark its own piece', () => {
    expect(surfaceTokens('Hello, World! Is it 3 PM?')).toEqual([
      'Hello',
      ',',
      'World',
      '!',
      'Is',
      'it',
      '3',
      'PM',
      '?',
    ])
  })

  it('keeps numbers, contractions and addresses whole', () => {
    expect(surfaceTokens("It's $4,350.50 at 10:30, see example.com/pricing")).toEqual([
      "It's",
      '$',
      '4,350.50',
      'at',
      '10:30',
      ',',
      'see',
      'example.com/pricing',
    ])
  })

  it('returns nothing for empty text', () => {
    expect(surfaceTokens('   ')).toEqual([])
  })
})

describe('correctionRate', () => {
  it('counts a missing comma and a lost capital, which the word error rate forgives', () => {
    const meant = 'Ask Priya, then call me.'
    const heard = 'ask Priya then call me.'

    expect(wordErrorRate(meant, heard)).toBe(0)
    // Seven pieces were meant; "Ask" and the comma need fixing.
    expect(correctionRate(meant, heard)).toBeCloseTo(2 / 7)
  })

  it('is zero only for text that needs no fixing at all', () => {
    expect(correctionRate('Done.', 'Done.')).toBe(0)
    expect(correctionRate('Done.', 'Done')).toBeGreaterThan(0)
  })
})

describe('alignWords', () => {
  const words = (text: string): string[] => text.split(' ')

  it('marks every word as the same when nothing differs', () => {
    expect(alignWords(words('send the report'), words('send the report'))).toEqual([
      { kind: 'same', word: 'send' },
      { kind: 'same', word: 'the' },
      { kind: 'same', word: 'report' },
    ])
  })

  it('finds a substituted, a missing and an extra word', () => {
    expect(alignWords(words('send me the report'), words('send me a report'))).toContainEqual({
      kind: 'substituted',
      expected: 'the',
      heard: 'a',
    })
    expect(alignWords(words('send me the report'), words('send the report'))).toContainEqual({
      kind: 'missing',
      expected: 'me',
    })
    expect(alignWords(words('send the report'), words('send the the report'))).toContainEqual({
      kind: 'extra',
      heard: 'the',
    })
  })

  it('uses exactly as many edits as the edit distance', () => {
    const meant = words('the invoice total is 4350 and it is due on the 21st of march')
    const heard = words('the invoice total is 350 it is due the 21st of of march')
    const edits = alignWords(meant, heard).filter((edit) => edit.kind !== 'same')

    expect(edits).toHaveLength(wordEditDistance(meant, heard))
  })

  it('handles an empty side', () => {
    expect(alignWords([], words('a b'))).toEqual([
      { kind: 'extra', heard: 'a' },
      { kind: 'extra', heard: 'b' },
    ])
    expect(alignWords(words('a'), [])).toEqual([{ kind: 'missing', expected: 'a' }])
  })
})
