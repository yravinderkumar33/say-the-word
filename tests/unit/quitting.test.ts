import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { goneWithin, quitAfter } from '../../src/main/quitting'

/** Electron's `app` as far as quitting goes: `before-quit` can be prevented, and then nothing ends. */
class FakeApp extends EventEmitter {
  exits = 0
  quit(): void {
    let prevented = false
    this.emit('before-quit', { preventDefault: () => (prevented = true) })
    if (!prevented) this.exits += 1
  }
}

/** A promise and the means to settle it from outside. */
function settledLater(): { promise: Promise<void>; resolve(): void; reject(error: Error): void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('quitting', () => {
  it('waits for what is being finished, however often Quit is pressed meanwhile', async () => {
    const app = new FakeApp()
    const draining = settledLater()
    // As `StorageHost.stop()` did: asked again while it is stopping, it returns at once.
    const finish = vi.fn(() =>
      finish.mock.calls.length === 1 ? draining.promise : Promise.resolve(),
    )
    quitAfter(app, finish)

    app.quit()
    await Promise.resolve()
    // ⌘Q pressed again while the history's last writes are still going to disk.
    app.quit()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(app.exits).toBe(0)
    expect(finish).toHaveBeenCalledTimes(1)

    draining.resolve()
    await vi.waitFor(() => expect(app.exits).toBe(1))
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('quits all the same when what it waits for fails', async () => {
    const app = new FakeApp()
    const draining = settledLater()
    quitAfter(app, () => draining.promise)

    app.quit()
    draining.reject(new Error('the storage process did not answer'))

    await vi.waitFor(() => expect(app.exits).toBe(1))
  })
})

describe('goneWithin', () => {
  class FakeChild extends EventEmitter {
    running = true
  }

  it('is over at once for a process that is not running', async () => {
    const child = new FakeChild()
    child.running = false

    await expect(goneWithin(child, 60_000)).resolves.toBeUndefined()
  })

  it('is over when the process leaves', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    let over = false
    void goneWithin(child, 1_500).then(() => (over = true))

    await vi.advanceTimersByTimeAsync(200)
    expect(over).toBe(false)
    child.emit('exit', 0)
    await vi.advanceTimersByTimeAsync(0)

    expect(over).toBe(true)
  })

  it('does not wait longer than it is given for a process that stays', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    let over = false
    void goneWithin(child, 1_500).then(() => (over = true))

    await vi.advanceTimersByTimeAsync(1_499)
    expect(over).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(over).toBe(true)
  })
})
