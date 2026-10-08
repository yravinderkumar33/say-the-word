import { describe, expect, it } from 'vitest'
import { InOrder } from '../../src/renderer/hub/answers'

describe('InOrder', () => {
  it('shows each answer as it comes when they come in the order asked', () => {
    const answers = new InOrder()
    const first = answers.ask()
    const second = answers.ask()

    expect(first()).toBe(true)
    expect(second()).toBe(true)
  })

  it('drops an answer that comes after a later one is shown: old news never replaces new', () => {
    const answers = new InOrder()
    const first = answers.ask()
    const second = answers.ask()

    expect(second()).toBe(true)
    expect(first()).toBe(false)
  })

  it('shows an answer that is slow although the question was put again in the meantime', () => {
    // The window asks every second and a half. When each answer takes two seconds, every
    // answer arrives after the next asking, and every one of them is still the newest there is.
    const answers = new InOrder()
    const first = answers.ask()
    const second = answers.ask()
    expect(first()).toBe(true)
    const third = answers.ask()
    expect(second()).toBe(true)
    const fourth = answers.ask()
    expect(third()).toBe(true)
    expect(fourth()).toBe(true)
  })

  it('keeps dropping what is older than the answer shown, however many are still out', () => {
    const answers = new InOrder()
    const out = [answers.ask(), answers.ask(), answers.ask(), answers.ask()]

    expect(out[2]!()).toBe(true)
    expect(out[0]!()).toBe(false)
    expect(out[1]!()).toBe(false)
    expect(out[3]!()).toBe(true)
  })
})
