import type {
  DictationMode,
  HistoryEntry,
  HistoryKeep,
  HistoryOutcome,
  HistoryRow,
  HistorySummary,
} from '@shared/ipc'
import { alignWords } from '@shared/wer'
import { clockLength, counted, seconds, timeOfDay } from './format'

/**
 * What the History page and Home's "Recent" say about a dictation. Kept apart from the
 * window so that the rules can be tested: a chip only when the dictation was not simply
 * pasted, a mode glyph only when the mode was not the usual one, and a reason in plain
 * words whenever there is something to explain.
 */

export type ChipIcon = 'shield' | 'minus' | 'copy' | 'mute'
export type ModeGlyph = 'verbatim' | 'rules' | 'cleaned'

export interface RowView {
  id: string
  time: string
  app: string | null
  /** What the row says: the start of the text, or why there is none. */
  text: string
  /** True when the text is what was said. False for the app's own words about a dictation without text. */
  said: boolean
  /** Drawn more quietly: nothing came of this dictation. */
  muted: boolean
  chip: { text: string; icon: ChipIcon } | null
  glyph: ModeGlyph | null
}

const CHIPS: Record<HistoryOutcome, { text: string; icon: ChipIcon } | null> = {
  pasted: null,
  // Refused on purpose, and the text is safe.
  focusMoved: { text: 'Not pasted: focus moved', icon: 'shield' },
  passwordField: { text: 'Not pasted: password field', icon: 'shield' },
  secureInput: { text: 'Not pasted: Secure Input', icon: 'shield' },
  notPasted: { text: 'Not pasted', icon: 'minus' },
  interrupted: { text: 'Not pasted: interrupted', icon: 'minus' },
  cancelled: { text: 'Cancelled', icon: 'minus' },
  noSpeech: { text: 'No speech', icon: 'mute' },
  failed: { text: 'Failed', icon: 'minus' },
}

/** What a row says when the dictation left no text. */
const WITHOUT_TEXT: Partial<Record<HistoryOutcome, string>> = {
  noSpeech: 'No words were recognized',
  cancelled: 'Cancelled before any words were written',
  interrupted: 'Interrupted before any words were written',
  failed: 'The dictation did not finish',
}

/** The chip of a dictation, or none for one that was pasted, at once or afterwards. */
export function chipOf(
  row: Pick<HistoryRow, 'outcome' | 'fetched'>,
): { text: string; icon: ChipIcon } | null {
  if (row.outcome === 'pasted' || row.fetched === 'pasted') return null
  if (row.fetched === 'copied') return { text: 'Copied', icon: 'copy' }
  return CHIPS[row.outcome]
}

/**
 * True when Cleaned mode fell back to the rules although a model was meant to be
 * used. A short dictation is never sent to the model, and "no model" is a choice:
 * neither is worth a mark.
 */
export function fellBackToRules(note: string | null): boolean {
  return note !== null && !['cleaned', 'short', 'noModel', 'cancelled'].includes(note)
}

export function glyphOf(
  row: Pick<HistoryRow, 'mode' | 'note' | 'text'>,
  usual: DictationMode,
): ModeGlyph | null {
  if (row.text.length === 0) return null
  if (row.mode === 'verbatim') return usual === 'cleaned' ? 'verbatim' : null
  if (fellBackToRules(row.note)) return 'rules'
  return usual === 'verbatim' ? 'cleaned' : null
}

export const GLYPH_TITLES: Record<ModeGlyph, string> = {
  verbatim: 'Verbatim',
  rules: 'Cleaned with rules only',
  cleaned: 'Cleaned',
}

/** A dictation as one row of the list. `usual` is the mode in use now. */
export function rowView(row: HistoryRow, usual: DictationMode): RowView {
  const said = row.text.length > 0
  return {
    id: row.id,
    time: timeOfDay(row.endedAt),
    app: row.app,
    text: said
      ? row.text
      : ((row.outcome === 'failed' ? row.failure : null) ??
        WITHOUT_TEXT[row.outcome] ??
        'Nothing was written'),
    said,
    muted: !said || row.outcome === 'cancelled',
    chip: chipOf(row),
    glyph: glyphOf(row, usual),
  }
}

// --- Days ----------------------------------------------------------------------------

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

// Made once: a format made for each row cost the list about 20 ms at every drawing.
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long' })
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long' })

/** A day as the list names it: Today, Yesterday, or the date. */
export function dayName(time: number, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(time))) / 86_400_000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const date = new Date(time)
  // Put together here, so that it reads the same whatever the system would make of it.
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`
  return `${WEEKDAY.format(date)} ${date.getDate()} ${MONTH.format(date)}${year}`
}

/** The rows under their days, in the order given (newest first). */
export function groupByDay<Row extends { endedAt: number }>(
  rows: readonly Row[],
  now: Date,
): Array<{ day: string; rows: Row[] }> {
  const groups: Array<{ day: string; rows: Row[] }> = []
  for (const row of rows) {
    const day = dayName(row.endedAt, now)
    const last = groups.at(-1)
    if (last?.day === day) last.rows.push(row)
    else groups.push({ day, rows: [row] })
  }
  return groups
}

/** Said when the list could not be read. It is asked for again by itself. */
export const LIST_UNREAD = 'The history could not be read.'
/** Said when an opened dictation could not be read. It is asked for again by itself. */
export const ENTRY_UNREAD = 'This dictation could not be read.'
/** Said when an opened dictation could not be deleted. It stays open. */
export const NOT_DELETED = 'This dictation could not be deleted.'

// --- How long dictations are kept ----------------------------------------------------

export const KEEP_LABELS: Record<HistoryKeep, string> = {
  session: 'Only until I quit',
  week: '7 days',
  month: '30 days',
  forever: 'Until I delete it',
}

/** The line under the header that says where the list lives. Amber when it is on disk. */
export function keepNotice(keep: HistoryKeep, name: string): { lead: string; rest: string } {
  if (keep === 'session') {
    return {
      lead: 'Held in memory only.',
      rest: `This list is gone when ${name} quits. Nothing is written to disk.`,
    }
  }
  if (keep === 'forever') {
    return {
      lead: 'Saved on this Mac until you delete it.',
      rest: 'Each dictation is written to disk. Never sent anywhere.',
    }
  }
  const time = KEEP_LABELS[keep]
  return {
    lead: `Saved on this Mac for ${time}.`,
    rest: `Each dictation is written to disk and deleted after ${time}. Never sent anywhere.`,
  }
}

/** A notice the History page shows about keeping the list, when something has gone wrong. */
export interface HistoryProblem {
  name: string
  title: string
  body: string
}

/**
 * What has gone wrong with keeping the history, in the words the page shows. Each is
 * said for as long as it is so: a dictation that is not where the list says it is, or one
 * that is gone, is never left to be found out.
 */
export function historyProblems(history: HistorySummary): HistoryProblem[] {
  const problems: HistoryProblem[] = []
  const lost = history.lost ?? 0
  if (lost > 0) {
    problems.push({
      name: 'history-lost',
      title: `${counted(lost, 'dictation')} ${lost === 1 ? 'was' : 'were'} lost from the list`,
      body:
        'The history is held in memory, and the part of the app that held it stopped ' +
        'unexpectedly. New dictations are listed again, and ⌘⌃V still pastes the last one.',
    })
  }
  if (history.overflowed) {
    problems.push({
      name: 'history-overflow',
      title: 'Some dictations were not added to the history',
      body:
        'They arrived while too many others were still waiting to be written, and were not ' +
        'kept. The log says when.',
    })
  } else if (history.diskProblem) {
    problems.push(
      history.keep === 'session'
        ? {
            name: 'history-disk',
            title: 'The history could not be changed',
            body: 'A dictation could not be added to the list, or deleted from it. The log says why.',
          }
        : {
            name: 'history-disk',
            title: 'The history on disk could not be changed',
            body:
              'A dictation could not be written to it, or deleted from it. Until that works ' +
              'again, this list and the files may differ. The log says why.',
          },
    )
  }
  return problems
}

// --- An opened row -------------------------------------------------------------------

/** One word of a text, and what the cleanup did to it. */
export interface Mark {
  word: string
  /** `removed`: struck through, in what was heard. `changed`: underlined, in what was written. */
  kind: 'plain' | 'removed' | 'changed'
  /** What VoiceOver is told in place of the mark, which it would not report. */
  spoken: string | null
}

/** A word without its capitals and its punctuation: what is compared. */
function bare(word: string): string {
  const stripped = word
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '')
  return stripped || word
}

const PUNCTUATION: Record<string, string> = {
  ',': 'a comma',
  '.': 'a full stop',
  '?': 'a question mark',
  '!': 'an exclamation mark',
  ';': 'a semicolon',
  ':': 'a colon',
}

/** What changed between a word as it was heard and as it was written, in words. */
function changeSpoken(heard: string | null, written: string): string {
  const stem = written.replace(/[.,;:!?]+$/, '')
  if (heard === null) return `added: ${stem}`
  const parts: string[] = []
  const first = written.charAt(0)
  if (first !== first.toLowerCase() && heard.charAt(0) === heard.charAt(0).toLowerCase()) {
    parts.push('a capital')
  }
  for (const sign of written.slice(stem.length)) {
    const name = PUNCTUATION[sign]
    if (name && !heard.endsWith(sign)) parts.push(name)
  }
  return parts.length > 0 ? `changed: ${stem}, with ${parts.join(' and ')}` : `changed: ${stem}`
}

/**
 * What was heard beside what was written, word by word: the words the cleanup took
 * out, and the ones whose capitals or punctuation it changed. The marks never rely on
 * colour, and each carries the words a screen reader says for it.
 */
export function diffMarks(heard: string, written: string): { heard: Mark[]; written: Mark[] } {
  const heardWords = heard.split(/\s+/).filter(Boolean)
  const writtenWords = written.split(/\s+/).filter(Boolean)
  const edits = alignWords(heardWords.map(bare), writtenWords.map(bare))
  const left: Mark[] = []
  const right: Mark[] = []
  let h = 0
  let w = 0
  const removed = (word: string): Mark => ({ word, kind: 'removed', spoken: `removed: ${word}` })
  const changed = (was: string | null, word: string): Mark => ({
    word,
    kind: 'changed',
    spoken: changeSpoken(was, word),
  })
  for (const edit of edits) {
    const was = heardWords[h] ?? ''
    const now = writtenWords[w] ?? ''
    switch (edit.kind) {
      case 'same':
        left.push({ word: was, kind: 'plain', spoken: null })
        right.push(was === now ? { word: now, kind: 'plain', spoken: null } : changed(was, now))
        h += 1
        w += 1
        break
      case 'substituted':
        left.push(removed(was))
        right.push(changed(null, now))
        h += 1
        w += 1
        break
      case 'missing':
        left.push(removed(was))
        h += 1
        break
      case 'extra':
        right.push(changed(null, now))
        w += 1
        break
    }
  }
  return { heard: left, written: right }
}

export type ReasonFix = 'copy' | 'startOllama' | 'getOllama' | 'cleanup'

/** Why a dictation went as it did, in plain words, with the one thing that can be done about it. */
export interface Reason {
  text: string
  fix: ReasonFix | null
}

/** What is known now about Ollama, for the button a reason may offer. */
export interface ReasonContext {
  /** The menu's line about Cleaned mode; it says so when Ollama is not running. */
  cleanupLine: string
  ollamaInstalled: boolean
}

const RULES_SUFFIX =
  ' The rules remove hesitations and repeated words; the model also fixes false starts.'

function notPastedReason(entry: HistoryEntry): string | null {
  const kept = entry.written.length > 0
  switch (entry.outcome) {
    case 'pasted':
      return null
    case 'focusMoved':
      return 'Focus moved before the text arrived, so nothing was pasted.'
    case 'passwordField':
      return 'A password field had the keyboard, so nothing was pasted.'
    case 'secureInput':
      return (
        `Secure Input was on${entry.app ? ` in ${entry.app}` : ''}, which is how macOS ` +
        'protects a password while it is typed, so nothing was pasted.'
      )
    case 'notPasted':
      return 'The paste could not be made.'
    case 'interrupted':
      return kept
        ? 'The dictation was interrupted (the Mac was locked or went to sleep, or the shortcut helper stopped), so nothing was pasted.'
        : 'The dictation was interrupted before any words were written.'
    case 'cancelled':
      return kept
        ? 'Cancelled, so nothing was pasted. The words written by then were kept.'
        : 'Cancelled before any words were written.'
    case 'noSpeech':
      return 'No words were recognized in the recording.'
    case 'failed':
      return entry.failure ? `${entry.failure}.` : 'The dictation did not finish.'
  }
}

function rulesReason(note: string, context: ReasonContext): Reason {
  if (note === 'unreachable' || note === 'notLocal:unreachable') {
    const stillDown = context.cleanupLine.includes('Ollama is not running')
    return {
      text: `Ollama was not running, so the text was tidied with rules only.${RULES_SUFFIX}`,
      fix: stillDown ? (context.ollamaInstalled ? 'startOllama' : 'getOllama') : 'cleanup',
    }
  }
  if (note === 'timeout') {
    return {
      text: `The model took too long, so the text was tidied with rules only.${RULES_SUFFIX}`,
      fix: 'cleanup',
    }
  }
  if (note === 'tooLong') {
    return {
      text: `The dictation was too long for the model to tidy in time, so it was tidied with rules only.${RULES_SUFFIX}`,
      fix: null,
    }
  }
  if (note.startsWith('guard:')) {
    return {
      text: 'The model changed more than Cleaned allows, so its text was not used. The text was tidied with rules only.',
      fix: null,
    }
  }
  if (note.startsWith('notLocal:')) {
    return {
      text: 'The chosen model could not be used on this Mac, so the text was tidied with rules only.',
      fix: 'cleanup',
    }
  }
  return {
    text: `The model did not answer, so the text was tidied with rules only.${RULES_SUFFIX}`,
    fix: 'cleanup',
  }
}

/** The one thing to explain about a dictation: why it was not pasted, or else why only the rules tidied it. */
export function reasonFor(entry: HistoryEntry, context: ReasonContext): Reason | null {
  const notPasted = notPastedReason(entry)
  if (notPasted) {
    if (entry.fetched === 'pasted') {
      return { text: `${notPasted} It was pasted afterwards, with ⌘⌃V.`, fix: null }
    }
    if (entry.fetched === 'copied') {
      return { text: `${notPasted} It was copied afterwards.`, fix: null }
    }
    return { text: notPasted, fix: entry.written.length > 0 ? 'copy' : null }
  }
  if (entry.mode === 'cleaned' && fellBackToRules(entry.note)) {
    return rulesReason(entry.note ?? '', context)
  }
  return null
}

/** How the dictation ended, spelled out. */
export function outcomeWords(entry: HistoryEntry): string {
  if (entry.outcome === 'pasted') return entry.app ? `Pasted into ${entry.app}` : 'Pasted'
  const chip = CHIPS[entry.outcome]?.text ?? 'Not pasted'
  if (entry.fetched === 'pasted') return `${chip}, then pasted with ⌘⌃V`
  if (entry.fetched === 'copied') return `${chip}, then copied`
  return chip
}

/** The mode the dictation ran in, spelled out. */
export function modeWords(entry: Pick<HistoryEntry, 'mode' | 'note'>): string {
  if (entry.mode === 'verbatim') return 'Verbatim'
  return entry.note === 'cleaned' ? 'Cleaned' : 'Cleaned, with rules only'
}

/** The line under the app's name: when, how long the recording was, how many words. */
export function detailLine(entry: HistoryEntry, now: Date): string {
  const words = entry.written.split(/\s+/).filter(Boolean).length
  const day = dayName(entry.endedAt, now)
  const when = day === 'Today' || day === 'Yesterday' ? `${day} at` : `${day},`
  return [
    `${when} ${timeOfDay(entry.endedAt)}`,
    ...(entry.audioMs !== null ? [clockLength(entry.audioMs)] : []),
    ...(words > 0 ? [counted(words, 'word')] : []),
  ].join(' · ')
}

export interface TimingRow {
  label: string
  value: string
  /** The first row is the sum of the others, and is drawn more strongly. */
  total: boolean
}

/** Where the time went, from releasing the key to the text being there. Empty when it was not timed. */
export function timingRows(entry: HistoryEntry): TimingRow[] {
  const { releaseToTextMs, tidyMs, pasteMs } = entry.timings
  if (releaseToTextMs === null) return []
  const rows: TimingRow[] = [
    {
      label: 'From release to text',
      value: seconds(releaseToTextMs + (pasteMs ?? 0)),
      total: true,
    },
    {
      label: 'Recognizing speech',
      value: seconds(Math.max(0, releaseToTextMs - (tidyMs ?? 0))),
      total: false,
    },
  ]
  if (entry.mode === 'cleaned' && tidyMs !== null) {
    rows.push({
      label: entry.note === 'cleaned' ? 'Tidying' : 'Tidying, rules only',
      value: seconds(tidyMs),
      total: false,
    })
  }
  if (pasteMs !== null) rows.push({ label: 'Pasting', value: seconds(pasteMs), total: false })
  return rows
}
