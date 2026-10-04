import { describe, expect, it } from 'vitest'
import { applyRules } from '../../src/main/cleanup/rules'

describe('hesitation sounds', () => {
  it.each([
    ['Um, so let us meet on Friday.', 'So let us meet on Friday.'],
    ['Let us meet, uh, on Friday.', 'Let us meet on Friday.'],
    ['and uh bring the report', 'and bring the report'],
    ['I think, um, that works. Uh, send it over.', 'I think that works. Send it over.'],
    ['Bring the report, um.', 'Bring the report.'],
    ['Umm I guess erm we could hmm try', 'I guess we could try'],
    ['uh', ''],
  ])('%s', (spoken, expected) => {
    expect(applyRules(spoken)).toBe(expected)
  })

  it('keeps words that only look like the sounds', () => {
    const kept = 'The umbrella is in the ER, and her name is Uma.'
    expect(applyRules(kept)).toBe(kept)
  })

  it.each([
    // German: "um" is "at", "er" is "he".
    'Wir treffen uns um 5 Uhr.',
    'Er ist schon da.',
    'Um 5 Uhr treffen wir uns.',
    // Portuguese: "um" is "a".
    'Eu quero um café.',
    // A unit and a verb, in English.
    'The gap is 5 mm wide.',
    'To err is human.',
  ])('keeps a word that is only a hesitation in another language or sense: %s', (spoken) => {
    expect(applyRules(spoken)).toBe(spoken)
  })

  it('still takes "um" and "er" out of English, with or without commas', () => {
    expect(applyRules('so um we should er meet on Friday')).toBe('so we should meet on Friday')
    expect(applyRules('The gap is, mm, about 5 mm wide.')).toBe('The gap is about 5 mm wide.')
  })

  it('leaves the sometimes-fillers for the model', () => {
    const kept = 'I mean, it is like, you know, fine.'
    expect(applyRules(kept)).toBe(kept)
  })
})

describe('stuttered words', () => {
  it.each([
    ['Bring the the report', 'Bring the report'],
    ['I I think we we should go', 'I think we should go'],
    ['Send it to, to the team', 'Send it to the team'],
    ['The the the answer', 'The answer'],
  ])('%s', (spoken, expected) => {
    expect(applyRules(spoken)).toBe(expected)
  })

  it.each([
    'I know that that is true.',
    'She had had enough.',
    'What it is is a mistake.',
    'What it was was a mistake.',
    'I told you you were right.',
    'Will will be late.',
    'Log in in the morning and turn it on on Monday.',
    'It was so so.',
    'It was very very good.',
    'Go to Walla Walla.',
    'the theme',
  ])('keeps "%s"', (spoken) => {
    expect(applyRules(spoken)).toBe(spoken)
  })
})

describe('dictionary', () => {
  const dictionary = [
    { from: 'kubernetes', to: 'Kubernetes' },
    { from: 'new york', to: 'NYC' },
    { from: 'new york city', to: 'New York City' },
    { from: 'priya', to: 'Priyanka' },
  ]

  it('replaces whole words, whatever their case', () => {
    expect(applyRules('deploy KUBERNETES for priya', dictionary)).toBe(
      'deploy Kubernetes for Priyanka',
    )
  })

  it('prefers the longest match', () => {
    expect(applyRules('fly to new york city then new york', dictionary)).toBe(
      'fly to New York City then NYC',
    )
  })

  it('does not replace inside another word', () => {
    expect(applyRules('priyanka and supriya', dictionary)).toBe('priyanka and supriya')
  })

  it('takes the replacement literally', () => {
    expect(applyRules('pay cash', [{ from: 'cash', to: '$1 & $&' }])).toBe('pay $1 & $&')
  })

  it('ignores an empty entry', () => {
    expect(applyRules('nothing changes', [{ from: '  ', to: 'x' }])).toBe('nothing changes')
  })
})

describe('applyRules', () => {
  it('leaves clean text exactly as it was', () => {
    const clean = 'Can you send me the quarterly report before Friday? It is due at 3 PM.'
    expect(applyRules(clean)).toBe(clean)
  })

  it('never touches numbers, negations or corrections', () => {
    const spoken = 'Do not ship at 2, actually 3, no, 4.'
    expect(applyRules(spoken)).toBe(spoken)
  })
})
