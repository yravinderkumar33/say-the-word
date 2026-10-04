import { isHesitationIn, looksEnglish } from '../text/words'

/** "When you hear this, write that": a name or term the recognizer gets wrong. */
export interface DictionaryEntry {
  from: string
  to: string
}

/**
 * The rules-only text: what Cleaned mode produces without a model, and what it falls
 * back to whenever the model is skipped, late or wrong.
 *
 * The rules are deliberately few. They remove sounds that are never words, collapse a
 * stuttered function word, and apply the user's dictionary. Words that are only
 * sometimes fillers ("like", "you know", "I mean") are left alone: telling the two
 * uses apart needs the sentence, and that is the model's job.
 *
 * A rule must never cost a word that was meant. A sound that is also a word somewhere
 * ("um" and "er" in German, the unit "mm") is removed only where it is plainly a
 * hesitation: see `isHesitationIn`.
 */
export function applyRules(text: string, dictionary: readonly DictionaryEntry[] = []): string {
  let result = removeHesitations(text)
  result = collapseStutters(result)
  result = applyDictionary(result, dictionary)
  return tidy(result)
}

/** The shapes a hesitation sound takes; `isHesitationIn` has the last word (it spares "ER"). */
const SOUND = String.raw`(?:u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+)`
const NOT_IN_WORD = String.raw`(?![\p{L}\p{N}'’-])`

function removeHesitations(text: string): string {
  const english = looksEnglish(text)
  // At the start of a sentence: "Um, so we…" becomes "So we…".
  let result = text.replace(
    new RegExp(String.raw`(^|[.!?]\s+)(${SOUND})${NOT_IN_WORD}(,?)\s+(\p{L})`, 'giu'),
    (whole, lead: string, word: string, comma: string, next: string) =>
      isHesitationIn(word, { setOff: comma === ',', english })
        ? `${lead}${next.toUpperCase()}`
        : whole,
  )
  // Anywhere else, with the commas the recognizer put around it: "meet, uh, Friday".
  result = result.replace(
    new RegExp(String.raw`(,?)\s+(${SOUND})${NOT_IN_WORD}(,?)(?=\s|[.!?]|$)`, 'giu'),
    (whole, before: string, word: string, after: string) =>
      isHesitationIn(word, { setOff: before === ',' || after === ',', english }) ? '' : whole,
  )
  // A text that is nothing but the sound.
  return result.replace(
    new RegExp(String.raw`^\s*(${SOUND})[.,!?]*\s*$`, 'iu'),
    (whole, word: string) => (isHesitationIn(word, { setOff: true, english }) ? '' : whole),
  )
}

/**
 * Function words that people stutter and that never stand twice in a row on purpose.
 * Left out are the ones that do: "that" and "had" ("I know that that is true", "she had
 * had enough"), "is" and "was" ("what it is is a mistake"), "you" ("I told you you were
 * right"), "in" and "on" ("log in in the morning", "turn it on on Monday"), "will" and
 * "can" ("Will will be late", "can can"), and "so" ("it was so so").
 */
const STUTTERED =
  'the|a|an|i|we|he|she|it|they|to|of|at|for|and|but|or|my|our|your|this|with|if|would|should|could|were|are'

function collapseStutters(text: string): string {
  return text.replace(
    new RegExp(
      String.raw`(?<![\p{L}\p{N}'’-])(${STUTTERED})(?:,?\s+\1)+(?![\p{L}\p{N}'’-])`,
      'giu',
    ),
    (_whole, word: string) => word,
  )
}

/** The dictionary on its own: the one edit Verbatim mode makes. */
export function applyDictionary(text: string, dictionary: readonly DictionaryEntry[]): string {
  const key = (phrase: string): string => phrase.trim().toLowerCase().replace(/\s+/g, ' ')
  const replacements = new Map<string, string>()
  for (const entry of dictionary) {
    if (key(entry.from).length > 0) replacements.set(key(entry.from), entry.to)
  }
  if (replacements.size === 0) return text

  // One pass over the text with the longest phrases tried first, so "new york city"
  // wins over "new york", and a replacement is never itself replaced.
  const patterns = [...replacements.keys()]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
  return text.replace(
    new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${patterns.join('|')})(?![\p{L}\p{N}])`, 'giu'),
    (match) => replacements.get(key(match)) ?? match,
  )
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/^[,;:\s]+/, '')
    .trim()
}
