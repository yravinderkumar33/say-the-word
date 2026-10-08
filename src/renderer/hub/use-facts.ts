import { useCallback, useEffect, useRef, useState } from 'react'
import { InOrder } from './answers'

/** How soon a question that could not be answered is put again, on a page that does not ask by itself. */
const AGAIN_AFTER_MS = 3_000

/**
 * Asks the main process for something now and again, and holds the latest answer. An
 * answer is dropped when a later one is already shown, so that old news never replaces
 * new; one that is merely slow is shown when it comes (`InOrder`).
 *
 * `key` is anything the question depends on: when it changes, the question is put again
 * at once, and answers to the question as it was are dropped.
 *
 * `failed` is true while the latest asking could not be answered. What was shown before
 * stays, and the question is put again until it is answered, also on a page that does
 * not ask by itself: the storage process restarting must not leave a page empty for good.
 */
export function useFacts<Facts>(
  ask: () => Promise<Facts>,
  everyMs: number | null,
  key: unknown = null,
): { facts: Facts | null; failed: boolean; refresh: () => void; set: (facts: Facts) => void } {
  const [facts, setFacts] = useState<Facts | null>(null)
  /** How many askings in a row could not be answered. */
  const [failures, setFailures] = useState(0)
  const [asking, setAsking] = useState(0)
  const refresh = useCallback(() => setAsking((count) => count + 1), [])
  // The latest `ask`, without making the effect below depend on a function that is new each time.
  const question = useRef(ask)
  useEffect(() => {
    question.current = ask
  })

  useEffect(() => {
    if (everyMs === null) return
    const timer = setInterval(refresh, everyMs)
    return () => clearInterval(timer)
  }, [everyMs, refresh])

  useEffect(() => {
    if (failures === 0 || everyMs !== null) return
    const timer = setTimeout(refresh, AGAIN_AFTER_MS)
    return () => clearTimeout(timer)
  }, [failures, everyMs, refresh])

  const [answers] = useState(() => new InOrder())
  /** What the question depends on now, and whether anyone is still there to be told. */
  const standing = useRef<{ key: unknown; shown: boolean }>({ key, shown: true })
  useEffect(() => {
    standing.current.shown = true
    return () => {
      standing.current.shown = false
    }
  }, [])

  useEffect(() => {
    standing.current.key = key
    const isNews = answers.ask()
    // An answer to the question as it was (another dictation, another page) is no answer.
    const current = (): boolean => {
      const { key: now, shown } = standing.current
      return shown && Object.is(now, key) && isNews()
    }
    question.current().then(
      (next) => {
        if (!current()) return
        setFacts(next)
        setFailures(0)
      },
      () => {
        // What could not be read is left as it was, and said; the next asking may fare better.
        if (current()) setFailures((count) => count + 1)
      },
    )
  }, [asking, key, answers])

  const set = useCallback((next: Facts) => {
    setFacts(next)
    setFailures(0)
  }, [])
  return { facts, failed: failures > 0, refresh, set }
}
