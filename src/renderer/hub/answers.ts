/**
 * Which answers to show when a question is put again and again, and its answers can
 * arrive late or in another order.
 *
 * An answer is dropped when the answer to a later asking is already shown: old news
 * never replaces new. It is not dropped merely because the question has been put again
 * since. A page that asks every second and a half would otherwise show nothing new for
 * as long as each answer took longer than that to come, which is when the helper or
 * Ollama is slow, and when the page most needs to say so.
 */
export class InOrder {
  private asked = 0
  private shown = 0

  /** Notes that the question is put. Returns what to ask when its answer arrives: is it still news? */
  ask(): () => boolean {
    const mine = ++this.asked
    return () => {
      if (mine < this.shown) return false
      this.shown = mine
      return true
    }
  }
}

/**
 * Asks the main process for a change, then does `then` once it is settled, made or not.
 * A page that reads the status again learns from it whether the change was made.
 */
export function whenSettled(asked: Promise<unknown>, then: () => void): void {
  void asked.then(then, then)
}
