import {
  LIST_CUES,
  findRetractions,
  findSpokenCommands,
  isHesitationIn,
  isProtected,
  looksEnglish,
  protectedKind,
  retractableIndexes,
  splitWords,
  type Word,
} from '../text/words'

/**
 * Decides whether the model's output may replace the rules-only text.
 *
 * It is a heuristic. It catches the common failures of small models: answering the
 * dictated question, dropping content, inventing text, translating. It cannot prove
 * that meaning was preserved, which is why the raw transcript is always kept.
 *
 * It is written against the edits Cleaned mode allows: removing hesitations and
 * stutters, fixing punctuation and capitals, applying a self-correction, and fixing
 * the odd mis-recognized word. Anything beyond that is a reason to fall back.
 */

export type GuardReason =
  /** The model did not finish by itself (cut off, or stopped for another reason). */
  | 'incomplete'
  | 'empty'
  /** The output is wrapped in a preamble, tags or a code fence. */
  | 'wrapped'
  | 'invented'
  | 'dropped'
  /** A number, address, negation or dictionary term was lost, added or repeated. */
  | 'protected'
  | 'reordered'
  /** A question lost its question mark, the script changed, or a list appeared. */
  | 'form'
  | 'tooLong'

export type GuardVerdict = { ok: true } | { ok: false; reason: GuardReason }

export interface GuardInput {
  /** What the model was given: the rules-only text. */
  input: string
  output: string
  /** How the stream ended; `stop` means the model finished by itself. */
  doneReason: string | null
  /** The user's dictionary terms. They are protected like numbers are. */
  vocabulary?: readonly string[]
}

/** Up to a tenth of the words may differ, to allow for corrected mis-recognitions. */
const allowance = (words: number): number => Math.floor(words * 0.1)

const PREAMBLE =
  /^(?:sure|certainly|of course|okay|ok|here(?:'s| is| are)|the (?:cleaned|corrected)|cleaned|corrected|output|result)\b/i

const fail = (reason: GuardReason): GuardVerdict => ({ ok: false, reason })

export function checkCleanup({
  input,
  output,
  doneReason,
  vocabulary = [],
}: GuardInput): GuardVerdict {
  const given = splitWords(input)
  const got = splitWords(output)

  // 1. Completed.
  if (doneReason !== 'stop') return fail('incomplete')
  if (got.length === 0) return fail('empty')
  if (isWrapped(input, output, given, got)) return fail('wrapped')

  // 2. Nothing invented: every output word is matched to its own input word.
  const available = counts(given.map((word) => word.norm))
  let unmatched = 0
  for (const word of got) {
    if (!take(available, word.norm)) unmatched += 1
  }
  if (unmatched > allowance(got.length)) return fail('invented')

  // 3. Nothing dropped, apart from what Cleaned mode is allowed to remove.
  const removable = removableIndexes(given, looksEnglish(input))
  const present = counts(got.map((word) => word.norm))
  let missing = 0
  for (const word of given) {
    if (removable.has(word.index)) continue
    if (!take(present, word.norm)) missing += 1
  }
  if (missing > allowance(given.length)) return fail('dropped')

  // 4. Protected tokens: they survive unless a correction replaced them, none is added,
  // and none appears more often than it was said.
  const terms = new Set(vocabulary.flatMap((term) => splitWords(term).map((word) => word.norm)))
  const replaceable = replaceableIndexes(given, terms)
  const said = counts(protectedNorms(given, terms))
  const mustSurvive = counts(
    protectedNorms(
      given.filter((word) => !replaceable.has(word.index)),
      terms,
    ),
  )
  const kept = counts(protectedNorms(got, terms))
  for (const [token, count] of mustSurvive) {
    if ((kept.get(token) ?? 0) < count) return fail('protected')
  }
  for (const [token, count] of kept) {
    if (count > (said.get(token) ?? 0)) return fail('protected')
  }

  // Quantity punctuation has meaning that the shared word tokenizer deliberately omits.
  const quantities = quantityTokens(input, given)
  const requiredQuantities = counts(
    quantities.filter((item) => !replaceable.has(item.index)).map((item) => item.token),
  )
  const allQuantities = counts(quantities.map((item) => item.token))
  const keptQuantities = counts(quantityTokens(output, got).map((item) => item.token))
  for (const [token, count] of requiredQuantities)
    if ((keptQuantities.get(token) ?? 0) < count) return fail('protected')
  for (const [token, count] of keptQuantities)
    if (count > (allQuantities.get(token) ?? 0)) return fail('protected')

  // 5. Order: what is left of the output after removing a few words reads in the
  // input's order. The few words that may be out of place never include a protected
  // one: "not" moved to another verb is the same words and the opposite meaning.
  const order = inOrder(got, given, terms)
  const protectedCount = got.filter((word) => isProtected(word, terms)).length
  if (order.protectedWords < protectedCount) return fail('reordered')
  if (got.length - order.words > allowance(got.length)) return fail('reordered')

  // 6. Form.
  if (/\?["')\]]*\s*$/.test(input) && !/\?["')\]]*\s*$/.test(output)) return fail('form')
  if (dominantScript(input) !== dominantScript(output)) return fail('form')
  if (hasListFormatting(output) && !hasListFormatting(input)) {
    if (!given.some((word) => LIST_CUES.has(word.norm))) return fail('form')
  }

  // 7. Length. There is no lower bound: check 3 accounts for what may be removed.
  if (output.trim().length > input.trim().length * 1.15 + 4) return fail('tooLong')

  return { ok: true }
}

/**
 * While the output is still streaming: true when it has already left the transcript
 * behind (more than half of its first six words are not in the input), so the request
 * can be abandoned without waiting for the rest.
 */
export function hasLeftTheTranscript(input: string, partialOutput: string): boolean {
  const first = splitWords(partialOutput).slice(0, 6)
  if (first.length < 6) return false
  const available = counts(splitWords(input).map((word) => word.norm))
  const unmatched = first.filter((word) => !take(available, word.norm)).length
  return unmatched > 3
}

function isWrapped(input: string, output: string, given: Word[], got: Word[]): boolean {
  const trimmed = output.trim()
  if (/<\/?transcript>/i.test(trimmed)) return true
  if (trimmed.includes('```') && !input.includes('```')) return true
  // "Here is the cleaned text:" and the like, unless the speaker began that way too.
  return PREAMBLE.test(trimmed) && got[0]?.norm !== given[0]?.norm
}

/** Hesitations, immediate repeats, retraction cues and the phrases they take back, spoken commands. */
function removableIndexes(words: Word[], english: boolean): Set<number> {
  const removable = retractableIndexes(words)
  for (const word of words) {
    // "um" and "er" are words in other languages: the same test the rules use.
    const setOff = word.followedByPause || Boolean(words[word.index - 1]?.followedByPause)
    if (isHesitationIn(word.text, { setOff, english })) removable.add(word.index)
    if (word.index > 0 && words[word.index - 1]?.norm === word.norm) removable.add(word.index)
  }
  for (const command of findSpokenCommands(words)) {
    for (let index = command.start; index < command.end; index++) removable.add(index)
  }
  return removable
}

/**
 * The protected tokens a correction may take out. The words of a cue itself always
 * may ("no wait"). A token before the cue may only if one of its own kind follows the
 * cue: "at 2, actually 3" replaces a number with a number. Where nothing of the kind
 * follows, nothing was corrected, and the token was simply dropped: "we do not
 * actually need 5" must keep its "not".
 */
function replaceableIndexes(words: Word[], vocabulary: ReadonlySet<string>): Set<number> {
  const replaceable = new Set<number>()
  for (const { cue, taken } of findRetractions(words)) {
    for (let index = cue.start; index < cue.end; index++) replaceable.add(index)
    const after = words.slice(cue.end, cue.end + REPLACEMENT_REACH)
    const kindsAfter = new Set(after.map((word) => protectedKind(word, vocabulary)))
    for (const index of taken) {
      const word = words[index]
      const kind = word ? protectedKind(word, vocabulary) : null
      if (kind !== null && kindsAfter.has(kind)) replaceable.add(index)
    }
  }
  return replaceable
}

/** How far after a cue its replacement is looked for. */
const REPLACEMENT_REACH = 8

function protectedNorms(words: Word[], vocabulary: ReadonlySet<string>): string[] {
  return words.filter((word) => isProtected(word, vocabulary)).map((word) => word.norm)
}

function counts(items: string[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1)
  return map
}

/** Uses up one occurrence. False when none is left. */
function take(available: Map<string, number>, item: string): boolean {
  const left = available.get(item) ?? 0
  if (left === 0) return false
  available.set(item, left - 1)
  return true
}

/**
 * The best match of output words to input words that keeps both in order: as many
 * protected words as can be matched, and then as many words as can be. One table
 * gives both counts: a protected match scores `scale + 1` and any other match 1, and
 * `scale` is more than any number of words that can match, so no number of ordinary
 * words outweighs one protected word. Comparing protected words with their neighbours
 * instead is fooled by repeated words: in "we will not ship on Monday and we will ship
 * on Friday", a "not" moved to Friday still stands between a "will" and a "ship".
 */
function inOrder(
  got: Word[],
  given: Word[],
  vocabulary: ReadonlySet<string>,
): { words: number; protectedWords: number } {
  const scale = given.length + 1
  let previous = new Array<number>(given.length + 1).fill(0)
  for (const word of got) {
    const score = isProtected(word, vocabulary) ? scale + 1 : 1
    const current = [0]
    for (let column = 1; column <= given.length; column++) {
      const matched =
        word.norm === given[column - 1]?.norm ? (previous[column - 1] ?? 0) + score : 0
      current[column] = Math.max(previous[column] ?? 0, current[column - 1] ?? 0, matched)
    }
    previous = current
  }
  const best = previous[given.length] ?? 0
  return { protectedWords: Math.floor(best / scale), words: best % scale }
}

const SCRIPTS: Array<[string, RegExp]> = [
  ['latin', /\p{Script=Latin}/gu],
  ['cyrillic', /\p{Script=Cyrillic}/gu],
  ['greek', /\p{Script=Greek}/gu],
  ['devanagari', /\p{Script=Devanagari}/gu],
  ['arabic', /\p{Script=Arabic}/gu],
  ['han', /\p{Script=Han}/gu],
]

/** The writing system most of the letters belong to. */
function dominantScript(text: string): string {
  let best = 'none'
  let most = 0
  for (const [name, pattern] of SCRIPTS) {
    const found = text.match(pattern)?.length ?? 0
    if (found > most) {
      most = found
      best = name
    }
  }
  return best
}

function hasListFormatting(text: string): boolean {
  return /^\s*(?:[-*•]|\d+[.)])\s+\S/m.test(text)
}

/**
 * Cleanup-only view: preserve signs, currency, percentages and separators without
 * changing word counts. `words` are `text` split by `splitWords`, whose positions say
 * what lies between one word and the next.
 */
function quantityTokens(text: string, words: Word[]): Array<{ index: number; token: string }> {
  return words.flatMap((word, index) => {
    if (!/\d/.test(word.norm)) return []
    const before = text.slice(words[index - 1]?.end ?? 0, word.start)
    const after = text.slice(word.end, words[index + 1]?.start ?? text.length)
    const prefix = before.match(/([+\-−\p{Sc}\s]*)$/u)?.[1] ?? ''
    // A unit written as a mark: per cent, per mille, a currency, degrees, feet or minutes, inches or seconds.
    const suffix = after.match(/^\s*([%‰°º′″\p{Sc}])/u)?.[1] ?? ''
    const sign =
      prefix.includes('-') || prefix.includes('−') ? '-' : prefix.includes('+') ? '+' : ''
    const currency = prefix.match(/\p{Sc}/u)?.[0] ?? ''
    // A range must remain a range. "5–10" may become "5—10"; written with a hyphen it is
    // refused, which errs the safe way: "5-10" is one word that was never said, and in
    // "5 - 10" the hyphen reads as a minus sign.
    const range = text.slice(word.end).match(/^\s*[-–—]\s*(?=\d)/u) ? 'range' : ''
    return [{ index: word.index, token: `${word.norm}|${sign}|${currency}|${suffix}|${range}` }]
  })
}
