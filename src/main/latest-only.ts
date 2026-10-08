/**
 * Puts a question that takes time to answer, as often as it is asked, and acts only on
 * the answer to the most recent asking.
 *
 * The question here is "what will Cleaned mode do right now?", which means asking
 * Ollama, and Ollama can be slow. An answer that arrives after the question was put
 * again is about a state that may no longer hold (another mode, another model, another
 * server). Shown, it would put old news beside the new setting, and stay there.
 *
 * Returns the function that asks.
 */
export function latestOnly<Answer>(
  ask: () => Promise<Answer>,
  act: (answer: Answer) => void,
): () => void {
  let askings = 0
  return () => {
    const asking = ++askings
    void ask()
      .then(
        (answer) => {
          if (asking === askings) act(answer)
        },
        (error: unknown) => {
          // A question that could not be answered changes nothing; the next one may be.
          if (asking === askings) {
            console.error('[app] a status could not be read:', describe(error))
          }
        },
      )
      // An answer that could not be acted on is said too, and left for the next one.
      .catch((error: unknown) =>
        console.error('[app] a status could not be shown:', describe(error)),
      )
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
