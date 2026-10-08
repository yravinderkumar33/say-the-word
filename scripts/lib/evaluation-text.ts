// The `.txt` of a saved dictation, as its owner corrects it: what they meant, after
// optional lines of tags at the top (docs/03-implementation-phases.md, "How to record it").
//
//     #names #technical
//     Ask Priyanka whether the Kubernetes upgrade is done.

const TAG_LINE = /^\s*(#[\p{L}\p{N}-]+\s*)+$/u

/**
 * The tags of a corrected text, in lower case, and what it says. Only lines of tags at the
 * top are tags: a line further down that looks like one is part of what was meant.
 */
export function readCorrected(raw: string): { tags: string[]; text: string } {
  const lines = raw.replace(/\r/g, '').split('\n')
  const tags: string[] = []
  while (lines.length > 0 && TAG_LINE.test(lines[0] ?? '')) {
    tags.push(...((lines.shift() ?? '').toLowerCase().match(/#[\p{L}\p{N}-]+/gu) ?? []))
  }
  return { tags, text: lines.join('\n').trim() }
}
