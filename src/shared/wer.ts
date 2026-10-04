/**
 * Word error rate: how many word edits (substitute, insert, delete) turn the
 * hypothesis into the reference, divided by the reference length.
 *
 * Both sides are normalized first, so case and punctuation do not count as errors.
 */

/**
 * Lower-cases, drops punctuation and splits into words. Apostrophes inside words stay,
 * and a number keeps its digits together however it is grouped: "4,350" and "4350"
 * are the same word.
 */
export function comparableWords(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^'+|'+$/g, ''))
    .filter((word) => word.length > 0)
}

/** The number of word edits between two word lists (Levenshtein distance). */
export function wordEditDistance(reference: string[], hypothesis: string[]): number {
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index)
  for (let row = 1; row <= reference.length; row++) {
    const current = [row]
    for (let column = 1; column <= hypothesis.length; column++) {
      const substitution = reference[row - 1] === hypothesis[column - 1] ? 0 : 1
      current[column] = Math.min(
        (previous[column] ?? 0) + 1,
        (current[column - 1] ?? 0) + 1,
        (previous[column - 1] ?? 0) + substitution,
      )
    }
    previous = current
  }
  return previous[hypothesis.length] ?? 0
}

/** 0 is a perfect match. It can exceed 1 when the hypothesis is much longer. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const referenceWords = comparableWords(reference)
  const hypothesisWords = comparableWords(hypothesis)
  if (referenceWords.length === 0) return hypothesisWords.length === 0 ? 0 : 1
  return wordEditDistance(referenceWords, hypothesisWords) / referenceWords.length
}

/**
 * Splits text into the pieces a person would have to fix by hand: words with their
 * capitals intact, and each punctuation mark as its own piece. Comparing these counts
 * a missing comma or a lower-case name as an error, which `comparableWords` forgives.
 */
export function surfaceTokens(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .replace(/[’‘]/g, "'")
      .match(/[\p{L}\p{N}]+(?:['.,:/-][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu) ?? []
  )
}

/** Edits per reference piece, counting capitals and punctuation. 0 means nothing to fix. */
export function correctionRate(reference: string, hypothesis: string): number {
  const referenceTokens = surfaceTokens(reference)
  const hypothesisTokens = surfaceTokens(hypothesis)
  if (referenceTokens.length === 0) return hypothesisTokens.length === 0 ? 0 : 1
  return wordEditDistance(referenceTokens, hypothesisTokens) / referenceTokens.length
}

export type WordEdit =
  | { kind: 'same'; word: string }
  | { kind: 'substituted'; expected: string; heard: string }
  | { kind: 'missing'; expected: string }
  | { kind: 'extra'; heard: string }

/**
 * Lines the two word lists up and says what happened to each word: the shortest list
 * of edits that turns what was heard into what was expected.
 */
export function alignWords(reference: string[], hypothesis: string[]): WordEdit[] {
  const rows = reference.length + 1
  const columns = hypothesis.length + 1
  const cost: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  )
  const at = (row: number, column: number): number => cost[row]?.[column] ?? 0
  for (let row = 1; row < rows; row++) {
    for (let column = 1; column < columns; column++) {
      const substitution = reference[row - 1] === hypothesis[column - 1] ? 0 : 1
      cost[row]![column] = Math.min(
        at(row - 1, column) + 1,
        at(row, column - 1) + 1,
        at(row - 1, column - 1) + substitution,
      )
    }
  }

  const edits: WordEdit[] = []
  let row = reference.length
  let column = hypothesis.length
  while (row > 0 || column > 0) {
    const expected = reference[row - 1]
    const heard = hypothesis[column - 1]
    if (row > 0 && column > 0 && expected !== undefined && heard !== undefined) {
      const substitution = expected === heard ? 0 : 1
      if (at(row, column) === at(row - 1, column - 1) + substitution) {
        edits.push(
          substitution
            ? { kind: 'substituted', expected, heard }
            : { kind: 'same', word: expected },
        )
        row -= 1
        column -= 1
        continue
      }
    }
    if (row > 0 && expected !== undefined && at(row, column) === at(row - 1, column) + 1) {
      edits.push({ kind: 'missing', expected })
      row -= 1
    } else if (heard !== undefined) {
      edits.push({ kind: 'extra', heard })
      column -= 1
    } else {
      break
    }
  }
  return edits.reverse()
}
