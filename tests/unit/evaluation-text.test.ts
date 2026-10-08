import { describe, expect, it } from 'vitest'
import { readCorrected } from '../../scripts/lib/evaluation-text'

describe('a corrected text of a saved dictation', () => {
  it('reads tags from the lines at the top, in lower case', () => {
    const raw = '#Names #technical\n#corrections\nAsk Priyanka whether the upgrade is done.\n'
    expect(readCorrected(raw)).toEqual({
      tags: ['#names', '#technical', '#corrections'],
      text: 'Ask Priyanka whether the upgrade is done.',
    })
  })

  it('reads a text without tags as it is', () => {
    expect(readCorrected('Send it before Friday.\n')).toEqual({
      tags: [],
      text: 'Send it before Friday.',
    })
  })

  it('keeps a line further down that looks like tags, as part of what was meant', () => {
    expect(readCorrected('First line.\n#hashtag\nLast line.')).toEqual({
      tags: [],
      text: 'First line.\n#hashtag\nLast line.',
    })
  })

  it('reads a file saved with Windows line ends', () => {
    expect(readCorrected('#numbers\r\nThe total is 4,350.\r\n')).toEqual({
      tags: ['#numbers'],
      text: 'The total is 4,350.',
    })
  })
})
