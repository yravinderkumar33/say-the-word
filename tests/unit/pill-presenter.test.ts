import { describe, expect, it } from 'vitest'
import type { PillRecovery, PillState } from '@shared/ipc'
import { PillPresenter } from '../../src/main/dictation/pill-presenter'

function setup() {
  const sent: PillState[] = []
  const timers: Array<{ run: () => void; ms: number; cleared: boolean }> = []
  let gone = 0
  const presenter = new PillPresenter((state) => sent.push(state), {
    recoveryMs: 6_000,
    onRecoveryGone: () => (gone += 1),
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })
  /** Runs timers that are still pending. */
  const elapse = (): void => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.run()
  }
  return { presenter, sent, timers, elapse, gone: () => gone }
}

const kinds = (states: PillState[]): string[] => states.map((state) => state.kind)
const quiet = (message: string): PillRecovery => ({ message, canCopy: false, sound: false })

describe('PillPresenter', () => {
  it('shows starting, not listening, until audio is flowing', () => {
    const t = setup()

    t.presenter.setGesture('holding')
    expect(kinds(t.sent)).toEqual(['starting'])

    t.presenter.setLive()
    expect(kinds(t.sent)).toEqual(['starting', 'listening'])
  })

  it('follows a whole dictation: starting, listening, processing, resting', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('processing')
    t.presenter.setGesture('idle')

    expect(kinds(t.sent)).toEqual(['starting', 'listening', 'processing', 'resting'])
  })

  it('does not carry "audio is flowing" over to the next session', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('idle')

    t.presenter.setGesture('holding')

    expect(t.sent.at(-1)).toEqual({ kind: 'starting' })
  })

  it('ignores a late "audio is flowing" once the recording is over', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setGesture('processing')

    t.presenter.setLive()

    expect(t.sent.at(-1)).toEqual({ kind: 'processing' })
  })

  it('shows a recovery message once the session is over, then returns to rest', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setGesture('processing')
    t.presenter.showRecovery({
      message: 'Focus moved, so nothing was pasted',
      canCopy: true,
      sound: true,
    })
    t.presenter.setGesture('idle')

    expect(t.sent.at(-1)).toEqual({
      kind: 'recovery',
      message: 'Focus moved, so nothing was pasted',
      canCopy: true,
      sound: true,
    })

    t.elapse()
    expect(t.sent.at(-1)).toEqual({ kind: 'resting' })
  })

  it('drops an old recovery message when a new session starts', () => {
    const t = setup()
    t.presenter.showRecovery(quiet('Cancelled'))

    t.presenter.setGesture('holding')
    t.elapse()

    expect(kinds(t.sent)).toEqual(['recovery', 'starting'])
  })

  it('can be dismissed by the user', () => {
    const t = setup()
    t.presenter.showRecovery(quiet('Cancelled'))

    t.presenter.dismissRecovery()

    expect(kinds(t.sent)).toEqual(['recovery', 'resting'])
  })

  it('replaces one recovery message with the next and restarts its timer', () => {
    const t = setup()
    t.presenter.showRecovery(quiet('Cancelled'))
    t.presenter.showRecovery(quiet('Copied'))

    expect(t.timers.filter((timer) => !timer.cleared)).toHaveLength(1)
    expect(t.sent.at(-1)).toEqual({ kind: 'recovery', ...quiet('Copied') })
  })

  it('sends nothing when the state has not changed', () => {
    const t = setup()
    t.presenter.setGesture('idle')
    t.presenter.setGesture('idle')
    t.presenter.dismissRecovery()

    expect(kinds(t.sent)).toEqual(['resting'])
  })

  it('keeps listening through a tap and into hands-free, then offers Stop and Cancel', () => {
    const t = setup()
    t.presenter.setGesture('holding')
    t.presenter.setLive()
    t.presenter.setGesture('tapPending')
    t.presenter.setGesture('locked')

    expect(t.sent).toEqual([
      { kind: 'starting' },
      { kind: 'listening', handsFree: false },
      { kind: 'listening', handsFree: true },
    ])
  })

  it('shows starting for a hands-free recording until audio is flowing', () => {
    const t = setup()
    t.presenter.setGesture('locked')
    expect(t.sent.at(-1)).toEqual({ kind: 'starting' })

    t.presenter.setLive()
    expect(t.sent.at(-1)).toEqual({ kind: 'listening', handsFree: true })
  })

  it('says when a message has gone, by time or by hand, but not when one replaces another', () => {
    const t = setup()
    t.presenter.showRecovery(quiet('Cancelled'))
    t.presenter.showRecovery(quiet('Copied'))
    expect(t.gone()).toBe(0)

    t.elapse()
    expect(t.gone()).toBe(1)

    t.presenter.showRecovery(quiet('Cancelled'))
    t.presenter.dismissRecovery()
    expect(t.gone()).toBe(2)
  })
})
