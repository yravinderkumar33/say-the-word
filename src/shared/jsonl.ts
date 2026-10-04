/**
 * Turns a stream of text chunks into complete lines. Chunks may end mid-line;
 * the remainder is held until its newline arrives. Blank lines are skipped.
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = ''
  return (chunk) => {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '')
      pending = pending.slice(newline + 1)
      if (line.length > 0) onLine(line)
      newline = pending.indexOf('\n')
    }
  }
}
