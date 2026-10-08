import { describe, expect, it, vi } from 'vitest'
import {
  chipOf,
  dayName,
  detailLine,
  diffMarks,
  fellBackToRules,
  glyphOf,
  groupByDay,
  keepNotice,
  modeWords,
  outcomeWords,
  reasonFor,
  rowView,
  timingRows,
} from '../../src/renderer/hub/history-view'
import { entry, row } from './status-fixture'

/** Noon on 4 October 2026: the dictations of the fixture are from that morning. */
const NOW = new Date(2026, 9, 4, 12, 0)
const at = (day: number, hour = 10): number => new Date(2026, 9, day, hour, 0).getTime()

describe('a dictation as a row', () => {
  it('shows the time, the app and the text, and nothing more when it was simply pasted', () => {
    expect(rowView(row(), 'verbatim')).toEqual({
      id: 'a-1',
      time: '10:42',
      app: 'Slack',
      text: 'Can we move the review to Thursday?',
      said: true,
      muted: false,
      chip: null,
      glyph: null,
    })
  })

  it('has a chip, with its own icon, only when it did not end in a paste', () => {
    const chip = (change: Parameters<typeof row>[0]) => chipOf(row(change))

    expect(chip({ outcome: 'pasted' })).toBeNull()
    expect(chip({ outcome: 'focusMoved' })).toEqual({
      text: 'Not pasted: focus moved',
      icon: 'shield',
    })
    expect(chip({ outcome: 'passwordField' })?.icon).toBe('shield')
    expect(chip({ outcome: 'secureInput' })?.text).toBe('Not pasted: Secure Input')
    expect(chip({ outcome: 'notPasted' })).toEqual({ text: 'Not pasted', icon: 'minus' })
    expect(chip({ outcome: 'cancelled' })).toEqual({ text: 'Cancelled', icon: 'minus' })
    expect(chip({ outcome: 'noSpeech' })).toEqual({ text: 'No speech', icon: 'mute' })
  })

  it('says Copied once a text that was not pasted has been fetched, and nothing once it was pasted after all', () => {
    expect(chipOf(row({ outcome: 'focusMoved', fetched: 'copied' }))).toEqual({
      text: 'Copied',
      icon: 'copy',
    })
    expect(chipOf(row({ outcome: 'focusMoved', fetched: 'pasted' }))).toBeNull()
  })

  it('says in the app’s own words why there is no text, and draws such a row quietly', () => {
    const silent = rowView(row({ outcome: 'noSpeech', text: '' }), 'verbatim')
    expect(silent).toMatchObject({ text: 'No words were recognized', said: false, muted: true })

    expect(rowView(row({ outcome: 'cancelled', text: '' }), 'verbatim').text).toBe(
      'Cancelled before any words were written',
    )
    expect(
      rowView(
        row({ outcome: 'failed', text: '', failure: 'The recognizer took too long' }),
        'verbatim',
      ).text,
    ).toBe('The recognizer took too long')
    expect(rowView(row({ outcome: 'failed', text: '' }), 'verbatim').text).toBe(
      'The dictation did not finish',
    )
  })

  it('draws a cancelled dictation quietly even when words had been written', () => {
    expect(rowView(row({ outcome: 'cancelled' }), 'verbatim')).toMatchObject({
      said: true,
      muted: true,
    })
  })
})

describe('the mode glyph', () => {
  it('appears only when the mode was not the usual one', () => {
    expect(glyphOf(row({ mode: 'verbatim' }), 'verbatim')).toBeNull()
    expect(glyphOf(row({ mode: 'verbatim' }), 'cleaned')).toBe('verbatim')
    expect(glyphOf(row({ mode: 'cleaned', note: 'cleaned' }), 'cleaned')).toBeNull()
    expect(glyphOf(row({ mode: 'cleaned', note: 'cleaned' }), 'verbatim')).toBe('cleaned')
  })

  it('marks a dictation that fell back to the rules, whatever the usual mode', () => {
    for (const note of ['unreachable', 'timeout', 'tooLong', 'guard:invented', 'notLocal:remote']) {
      expect(glyphOf(row({ mode: 'cleaned', note }), 'cleaned'), note).toBe('rules')
      expect(fellBackToRules(note), note).toBe(true)
    }
  })

  it('does not mark what was never meant for the model: a short dictation, or no model chosen', () => {
    for (const note of ['short', 'noModel', 'cleaned']) {
      expect(glyphOf(row({ mode: 'cleaned', note }), 'cleaned'), note).toBeNull()
    }
    expect(fellBackToRules(null)).toBe(false)
  })

  it('is not drawn for a row without text', () => {
    expect(glyphOf(row({ mode: 'verbatim', text: '' }), 'cleaned')).toBeNull()
  })
})

describe('the days of the list', () => {
  it('names today and yesterday, and gives the date of anything older', () => {
    expect(dayName(at(4), NOW)).toBe('Today')
    expect(dayName(at(3, 23), NOW)).toBe('Yesterday')
    expect(dayName(at(2), NOW)).toBe('Friday 2 October')
    expect(dayName(new Date(2025, 11, 31, 10).getTime(), NOW)).toBe('Wednesday 31 December 2025')
  })

  it('puts the rows under their days, in the order given', () => {
    const rows = [
      row({ id: 'a', endedAt: at(4, 11) }),
      row({ id: 'b', endedAt: at(4, 9) }),
      row({ id: 'c', endedAt: at(3, 17) }),
    ]

    expect(
      groupByDay(rows, NOW).map((group) => [group.day, group.rows.map((item) => item.id)]),
    ).toEqual([
      ['Today', ['a', 'b']],
      ['Yesterday', ['c']],
    ])
  })

  it('names the days of a long list without making a date format for each row', () => {
    // The page asks for up to 500 rows, and a format made afresh costs about a twentieth of
    // a millisecond: a month of them took 20 ms, at every drawing.
    const rows = Array.from({ length: 500 }, (_, index) =>
      row({ id: String(index), endedAt: at(4) - index * 5_000_000 }),
    )
    const made = vi.spyOn(Date.prototype, 'toLocaleDateString')
    try {
      const groups = groupByDay(rows, NOW)
      expect(groups.length).toBeGreaterThan(20)
      expect(made).not.toHaveBeenCalled()
    } finally {
      made.mockRestore()
    }
  })
})

describe('where the list lives', () => {
  it('says that it is in memory and gone on quit, by default', () => {
    expect(keepNotice('session', 'Whisper Flow')).toEqual({
      lead: 'Held in memory only.',
      rest: 'This list is gone when Whisper Flow quits. Nothing is written to disk.',
    })
  })

  it('says that it is on disk, for how long, and that it goes nowhere', () => {
    expect(keepNotice('week', 'Whisper Flow')).toEqual({
      lead: 'Saved on this Mac for 7 days.',
      rest: 'Each dictation is written to disk and deleted after 7 days. Never sent anywhere.',
    })
    expect(keepNotice('forever', 'Whisper Flow').lead).toBe(
      'Saved on this Mac until you delete it.',
    )
  })
})

describe('what was heard beside what was written', () => {
  const heard =
    'um call the dentist about uh moving thursday and buy coffee filters oat milk and and batteries'
  const written =
    'Call the dentist about moving Thursday, and buy coffee filters, oat milk and batteries.'

  it('strikes through the words the cleanup took out', () => {
    const marks = diffMarks(heard, written)

    expect(marks.heard.filter((mark) => mark.kind === 'removed').map((mark) => mark.word)).toEqual([
      'um',
      'uh',
      'and',
    ])
    expect(marks.heard.map((mark) => mark.word).join(' ')).toBe(heard)
  })

  it('underlines the words that gained a capital or punctuation, and leaves the rest alone', () => {
    const marks = diffMarks(heard, written)

    expect(
      marks.written.filter((mark) => mark.kind === 'changed').map((mark) => mark.word),
    ).toEqual(['Call', 'Thursday,', 'filters,', 'batteries.'])
    expect(marks.written.map((mark) => mark.word).join(' ')).toBe(written)
  })

  it('says each mark in words, because a screen reader reports neither a strike nor an underline', () => {
    const marks = diffMarks(heard, written)
    const spoken = (word: string) =>
      [...marks.heard, ...marks.written].find((mark) => mark.word === word)?.spoken

    expect(spoken('um')).toBe('removed: um')
    expect(spoken('Call')).toBe('changed: Call, with a capital')
    expect(spoken('Thursday,')).toBe('changed: Thursday, with a capital and a comma')
    expect(spoken('filters,')).toBe('changed: filters, with a comma')
    expect(spoken('batteries.')).toBe('changed: batteries, with a full stop')
    expect(spoken('dentist')).toBeNull()
  })

  it('marks a word that was put in the place of another, and one that was added', () => {
    const marks = diffMarks('meet thursday friday at 3', 'Meet Friday at 3 PM.')

    expect(marks.heard.find((mark) => mark.word === 'thursday')?.kind).toBe('removed')
    expect(marks.written.at(-1)).toEqual({ word: 'PM.', kind: 'changed', spoken: 'added: PM' })
  })

  it('has no marks when nothing was changed', () => {
    const marks = diffMarks('Exactly this.', 'Exactly this.')

    expect([...marks.heard, ...marks.written].every((mark) => mark.kind === 'plain')).toBe(true)
  })
})

describe('why a dictation went as it did', () => {
  const context = { cleanupLine: '', ollamaInstalled: true }

  it('has nothing to explain about a dictation that was pasted as usual', () => {
    expect(reasonFor(entry(), context)).toBeNull()
    expect(reasonFor(entry({ mode: 'cleaned', note: 'cleaned' }), context)).toBeNull()
    expect(reasonFor(entry({ mode: 'cleaned', note: 'short' }), context)).toBeNull()
  })

  it('says why it was not pasted, and offers Copy while the text has not been fetched', () => {
    expect(reasonFor(entry({ outcome: 'focusMoved' }), context)).toEqual({
      text: 'Focus moved before the text arrived, so nothing was pasted.',
      fix: 'copy',
    })
    expect(reasonFor(entry({ outcome: 'secureInput', app: 'Brave' }), context)?.text).toContain(
      'Secure Input was on in Brave',
    )
    expect(reasonFor(entry({ outcome: 'passwordField' }), context)?.fix).toBe('copy')
  })

  it('says so when the text was fetched afterwards, and offers nothing more', () => {
    expect(reasonFor(entry({ outcome: 'focusMoved', fetched: 'copied' }), context)).toEqual({
      text: 'Focus moved before the text arrived, so nothing was pasted. It was copied afterwards.',
      fix: null,
    })
    expect(reasonFor(entry({ outcome: 'focusMoved', fetched: 'pasted' }), context)?.text).toContain(
      'pasted afterwards, with ⌘⌃V',
    )
  })

  it('has nothing to copy when there is no text', () => {
    expect(reasonFor(entry({ outcome: 'noSpeech', written: '', heard: '' }), context)).toEqual({
      text: 'No words were recognized in the recording.',
      fix: null,
    })
    expect(
      reasonFor(
        entry({
          outcome: 'failed',
          written: '',
          heard: '',
          failure: 'The recognizer took too long',
        }),
        context,
      )?.text,
    ).toBe('The recognizer took too long.')
  })

  it('says why only the rules tidied it, and offers to start Ollama while it is still not running', () => {
    const rulesOnly = entry({ mode: 'cleaned', note: 'unreachable' })
    const down = {
      cleanupLine: 'Cleaned: rules only (Ollama is not running)',
      ollamaInstalled: true,
    }

    expect(reasonFor(rulesOnly, down)).toEqual({
      text:
        'Ollama was not running, so the text was tidied with rules only. The rules remove ' +
        'hesitations and repeated words; the model also fixes false starts.',
      fix: 'startOllama',
    })
    expect(reasonFor(rulesOnly, { ...down, ollamaInstalled: false })?.fix).toBe('getOllama')
    // It is running again by now: the page about Cleanup is where to look.
    expect(reasonFor(rulesOnly, context)?.fix).toBe('cleanup')
  })

  it('explains the other reasons for the rules in plain words', () => {
    const why = (note: string) => reasonFor(entry({ mode: 'cleaned', note }), context)

    expect(why('timeout')?.text).toContain('The model took too long')
    expect(why('tooLong')).toMatchObject({ fix: null })
    expect(why('guard:invented')?.text).toContain('changed more than Cleaned allows')
    expect(why('notLocal:remote')).toMatchObject({ fix: 'cleanup' })
  })

  it('explains the paste before the tidying when both went otherwise', () => {
    const both = entry({ outcome: 'focusMoved', mode: 'cleaned', note: 'unreachable' })

    expect(reasonFor(both, context)?.text).toContain('Focus moved')
  })
})

describe('an opened row', () => {
  it('spells out how it ended and in which mode', () => {
    expect(outcomeWords(entry({ app: 'Notes' }))).toBe('Pasted into Notes')
    expect(outcomeWords(entry({ app: null }))).toBe('Pasted')
    expect(outcomeWords(entry({ outcome: 'focusMoved' }))).toBe('Not pasted: focus moved')
    expect(outcomeWords(entry({ outcome: 'focusMoved', fetched: 'copied' }))).toBe(
      'Not pasted: focus moved, then copied',
    )
    expect(modeWords({ mode: 'verbatim', note: null })).toBe('Verbatim')
    expect(modeWords({ mode: 'cleaned', note: 'cleaned' })).toBe('Cleaned')
    expect(modeWords({ mode: 'cleaned', note: 'unreachable' })).toBe('Cleaned, with rules only')
    expect(modeWords({ mode: 'cleaned', note: 'noModel' })).toBe('Cleaned, with rules only')
  })

  it('says when it was, how long the recording was and how many words', () => {
    expect(detailLine(entry(), NOW)).toBe('Today at 10:42 · 0:06 · 7 words')
    expect(detailLine(entry({ endedAt: at(3, 17), audioMs: null }), NOW)).toBe(
      'Yesterday at 17:00 · 7 words',
    )
    expect(detailLine(entry({ endedAt: at(2, 9), written: '' }), NOW)).toBe(
      'Friday 2 October, 09:00 · 0:06',
    )
  })

  it('shows where the time went, with the parts adding up to the whole', () => {
    const cleaned = entry({
      mode: 'cleaned',
      note: 'unreachable',
      timings: { releaseToTextMs: 390, tidyMs: 10, pasteMs: 40 },
    })

    expect(timingRows(cleaned)).toEqual([
      { label: 'From release to text', value: '0.43 s', total: true },
      { label: 'Recognizing speech', value: '0.38 s', total: false },
      { label: 'Tidying, rules only', value: '0.01 s', total: false },
      { label: 'Pasting', value: '0.04 s', total: false },
    ])
  })

  it('leaves out the parts that did not happen, and all of it when nothing was timed', () => {
    const refused = entry({
      outcome: 'focusMoved',
      timings: { releaseToTextMs: 390, tidyMs: null, pasteMs: null },
    })

    expect(timingRows(refused).map((item) => item.label)).toEqual([
      'From release to text',
      'Recognizing speech',
    ])
    expect(
      timingRows(entry({ timings: { releaseToTextMs: null, tidyMs: null, pasteMs: null } })),
    ).toEqual([])
  })
})
