/** What quitting needs of Electron's `app`: its last chance to wait, and the quit itself. */
export interface Quittable {
  on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/**
 * Holds the app back from quitting until `finish` is over, and starts that only once. A
 * Quit that comes while it is under way (⌘Q pressed again, the system asking at logout)
 * waits for the same: let through, it would end the app in the middle of it. Whatever
 * `finish` comes to, the app then quits.
 */
export function quitAfter(app: Quittable, finish: () => Promise<unknown>): void {
  let finishing: Promise<void> | null = null
  let finished = false
  app.on('before-quit', (event) => {
    if (finished) return
    event.preventDefault()
    finishing ??= Promise.resolve()
      .then(finish)
      .catch(() => {})
      .then(() => {
        finished = true
        app.quit()
      })
  })
}

/** Over when the process has left, or after `withinMs` if it has not: it is not waited for longer. */
export function goneWithin(
  child: { readonly running: boolean; once(event: 'exit', listener: () => void): unknown },
  withinMs: number,
): Promise<void> {
  if (!child.running) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, withinMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}
