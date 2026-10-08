/**
 * The vocabulary Cleaned mode is defined in: what a word is, which words are
 * hesitations, which phrases take something back, and which tokens must never change.
 * The rules, the decision to skip the model, and the guard all use these, so they
 * cannot drift apart.
 */

export interface Word {
  /** As written in the text. */
  text: string
  /** Lower-cased, with number formatting and number words flattened: for comparing. */
  norm: string
  /** Position in the word list. */
  index: number
  /** Where it is in the text: `text.slice(start, end)` is the word. */
  start: number
  end: number
  /** True when punctuation that ends a clause follows the word. */
  endsClause: boolean
  /** True when a full stop, question mark or exclamation mark follows the word. */
  endsSentence: boolean
  /** True when a comma, or any clause-ending mark, follows the word. */
  followedByPause: boolean
}

/**
 * A word is letters and digits, with the marks that hold a number, address or name
 * together. A combining mark belongs to the letter before it: an accent typed as a
 * character of its own, or a vowel sign in Devanagari.
 */
const WORD = /[\p{L}\p{M}\p{N}]+(?:['’.,:/@_-][\p{L}\p{M}\p{N}]+)*/gu

// A Map, not an object: looked up with what was said, an object would answer
// "constructor" or "toString" from its prototype.
const NUMBER_WORDS = new Map(Object.entries({
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7',
  eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13',
  fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18',
  nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60',
  seventy: '70', eighty: '80', ninety: '90', hundred: '100', thousand: '1000',
  million: '1000000', billion: '1000000000',
})) // prettier-ignore

/** "4,350" and "4350" are one number; "Three" and "3" are one number. */
function normalizeWord(text: string): string {
  const lower = text.normalize('NFKC').toLowerCase().replace(/’/g, "'")
  const ungrouped = lower.replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
  return NUMBER_WORDS.get(ungrouped) ?? ungrouped
}

export function splitWords(text: string): Word[] {
  const words: Word[] = []
  for (const match of text.matchAll(WORD)) {
    const end = match.index + match[0].length
    const after = text.slice(end).match(/^[^\p{L}\p{M}\p{N}\s]*/u)?.[0] ?? ''
    words.push({
      text: match[0],
      norm: normalizeWord(match[0]),
      index: words.length,
      start: match.index,
      end,
      endsClause: /[.!?;:—]/.test(after),
      endsSentence: /[.!?]/.test(after),
      followedByPause: /[,.!?;:—]/.test(after),
    })
  }
  return words
}

/** How many words a text has. Where only a count may be kept of what was said, this is it. */
export function countWords(text: string): number {
  return splitWords(text).length
}

/** The shapes of the sounds people make while thinking, for building patterns from. */
export const HESITATION_SOUND = String.raw`(?:u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+)`

/** Sounds people make while thinking. They carry no meaning and are always removable. */
const HESITATION = new RegExp(`^${HESITATION_SOUND}$`)

function isHesitation(word: string): boolean {
  // ER, AH and UM in capitals are more likely an abbreviation than a sound.
  if (word.length > 1 && word === word.toUpperCase() && /\p{L}/u.test(word)) return false
  return HESITATION.test(word.toLowerCase())
}

/**
 * Some of those sounds are also words. "mm" is a unit and "err" a verb, in English.
 * "um" and "er" are everyday words in German, Dutch, Danish and Portuguese ("um 5 Uhr",
 * "er ist da"), and the recognizer writes all of those languages.
 *
 * Such a sound is taken for a hesitation only when the recognizer set it off with a
 * comma, which it does for a hesitation and not for a word in a sentence. "um" and
 * "er" are also taken for one, comma or not, in a text that is clearly English.
 */
const ALSO_A_WORD = new Set(['mm', 'err'])
const A_WORD_ELSEWHERE = new Set(['um', 'er'])

export function isHesitationIn(
  word: string,
  context: { setOff: boolean; english: boolean },
): boolean {
  if (!isHesitation(word)) return false
  const lower = word.toLowerCase()
  if (ALSO_A_WORD.has(lower)) return context.setOff
  if (A_WORD_ELSEWHERE.has(lower)) return context.setOff || context.english
  return true
}

const ENGLISH_COMMON = new Set([
  'the', 'and', 'to', 'of', 'a', 'in', 'is', 'it', 'that', 'you', 'i', 'we', 'for', 'on',
  'with', 'this', 'be', 'are', 'was', 'have', 'not', 'at', 'but', 'so', 'me', 'my', 'can',
  'will', 'do', 'if', 'they', 'he', 'she', 'or', 'as', 'from', 'what', 'there', 'would',
  'should', 'could', 'about', 'just', 'let', 'us', 'our', 'your', 'has', 'had', 'an',
]) // prettier-ignore

/** True when enough of the words are everyday English ones to say the text is English. */
export function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{M}']+/gu) ?? []
  const common = words.filter((word) => ENGLISH_COMMON.has(word)).length
  return common >= 2 && common >= words.length * 0.15
}

/**
 * Phrases that take back what was just said. Longest first, so "no wait" is found
 * before "no". "no" on its own is a cue only when a pause follows it: "Thursday, no,
 * Friday" takes Thursday back, but "we have no time" is a negation and must survive.
 */
const RETRACTION_CUES: string[][] = [
  ['no', 'wait'],
  ['scratch', 'that'],
  ['never', 'mind'],
  ['make', 'that'],
  ['i', 'mean'],
  ['actually'],
  ['sorry'],
  ['no'],
]

const SPOKEN_COMMANDS: string[][] = [
  ['new', 'line'],
  ['new', 'paragraph'],
]

/** How far back a correction can reach: the words it takes back start no earlier than this. */
const RETRACTABLE_REACH = 8

export interface Phrase {
  /** Index of the first word. */
  start: number
  /** Index after the last word. */
  end: number
}

function phraseAt(words: Word[], index: number, phrases: string[][]): Phrase | null {
  for (const phrase of phrases) {
    if (phrase.every((part, offset) => words[index + offset]?.norm === part)) {
      return { start: index, end: index + phrase.length }
    }
  }
  return null
}

/** The retraction cues in a text. */
export function findRetractionCues(words: Word[]): Phrase[] {
  const cues: Phrase[] = []
  for (let index = 0; index < words.length; index++) {
    const cue = phraseAt(words, index, RETRACTION_CUES)
    if (!cue) continue
    const last = words[cue.end - 1]
    const isBareNo = cue.end - cue.start === 1 && words[index]?.norm === 'no'
    if (isBareNo && !last?.followedByPause) continue
    cues.push(cue)
    index = cue.end - 1
  }
  return cues
}

export function findSpokenCommands(words: Word[]): Phrase[] {
  const commands: Phrase[] = []
  for (let index = 0; index < words.length; index++) {
    const command = phraseAt(words, index, SPOKEN_COMMANDS)
    if (command) {
      commands.push(command)
      index = command.end - 1
    }
  }
  return commands
}

export interface Retraction {
  /** The words of the cue itself ("no wait", "actually"). */
  cue: Phrase
  /** Indexes of the words before the cue that it may take back. */
  taken: number[]
}

/**
 * The corrections in a text: each cue, and the words before it that it may take back.
 * The reach goes back to the previous clause boundary, at most eight words, and never
 * into the sentence before: a cue that opens a new sentence ("…order 4471. Actually,
 * call me first.") starts something new, and what was said before it stands.
 */
export function findRetractions(words: Word[]): Retraction[] {
  return findRetractionCues(words).map((cue) => {
    const taken: number[] = []
    for (let back = 1; back <= RETRACTABLE_REACH; back++) {
      const word = words[cue.start - back]
      if (!word) break
      if (back === 1 ? word.endsSentence : word.endsClause) break
      taken.push(word.index)
    }
    return { cue, taken }
  })
}

/** Indexes of the words a correction may remove: each cue, and the words it may take back. */
export function retractableIndexes(words: Word[]): Set<number> {
  const retractable = new Set<number>()
  for (const { cue, taken } of findRetractions(words)) {
    for (let index = cue.start; index < cue.end; index++) retractable.add(index)
    for (const index of taken) retractable.add(index)
  }
  return retractable
}

const NEGATIONS = new Set(['not', 'never', 'without', 'none', 'neither', 'nor', 'cannot'])

export type ProtectedKind = 'number' | 'address' | 'negation' | 'term'

/** Which kind of protected token a word is, or null when it is an ordinary word. */
export function protectedKind(word: Word, vocabulary: ReadonlySet<string>): ProtectedKind | null {
  const norm = word.norm
  if (/\d/.test(norm)) return 'number'
  if (/@/.test(norm) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(norm)) return 'address'
  if (NEGATIONS.has(norm) || norm.endsWith("n't") || norm === 'no') return 'negation'
  return vocabulary.has(norm) ? 'term' : null
}

/** Tokens whose loss or invention changes what was said: numbers, addresses, negations. */
export function isProtected(word: Word, vocabulary: ReadonlySet<string>): boolean {
  return protectedKind(word, vocabulary) !== null
}

/** Words that announce a list, without which list formatting has no business appearing. */
export const LIST_CUES = new Set([
  'first', 'second', 'third', 'firstly', 'secondly', 'thirdly', 'next', 'then', 'finally',
  'lastly', 'list', 'bullet', 'bullets', 'points', 'steps', 'items',
]) // prettier-ignore
