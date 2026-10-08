import { describe, expect, it } from 'vitest'
import {
  KEY,
  bindingsFor,
  dictationKeyLabel,
  dictationKeySpoken,
  spokenKeys,
} from '@shared/keycodes'

const chordsOf = (id: string, key: 'fn' | 'ctrlOption'): number[][] =>
  bindingsFor(key).find((binding) => binding.id === id)?.chords ?? []

describe('the shortcut table', () => {
  it('is Fn alone to dictate and Fn with Space for hands-free, as before', () => {
    expect(chordsOf('ptt', 'fn')).toEqual([[KEY.fn]])
    expect(chordsOf('handsFree', 'fn')).toEqual([[KEY.fn, KEY.space]])
  })

  it('takes Control and Option together, whichever of each, when that is the key', () => {
    const chords = chordsOf('ptt', 'ctrlOption')

    expect(chords).toHaveLength(4)
    for (const chord of chords) {
      expect(chord).toHaveLength(2)
      expect([KEY.leftControl, KEY.rightControl]).toContain(chord[0])
      expect([KEY.leftOption, KEY.rightOption]).toContain(chord[1])
    }
    // Never Fn: that is the key another app may be listening to.
    expect(chords.flat()).not.toContain(KEY.fn)
  })

  it('locks on with Space added to the same keys', () => {
    const dictate = chordsOf('ptt', 'ctrlOption')
    const handsFree = chordsOf('handsFree', 'ctrlOption')

    expect(handsFree).toEqual(dictate.map((chord) => [...chord, KEY.space]))
  })

  it('keeps paste-last and copy-last the same with either key', () => {
    for (const id of ['pasteLast', 'copyLast']) {
      expect(chordsOf(id, 'ctrlOption')).toEqual(chordsOf(id, 'fn'))
      expect(chordsOf(id, 'fn')).toHaveLength(4)
    }
  })
})

describe('how a key is written and said', () => {
  it('is printed as it is on the keyboard', () => {
    expect(dictationKeyLabel('fn')).toBe('Fn')
    expect(dictationKeyLabel('ctrlOption')).toBe('⌃⌥')
  })

  it('is said in words, which a screen reader can read', () => {
    expect(dictationKeySpoken('fn')).toBe('Fn')
    expect(dictationKeySpoken('ctrlOption')).toBe('Control Option')
    expect(spokenKeys(['Fn'])).toBe('Fn key')
    expect(spokenKeys(['⌘', '⌃', 'V'])).toBe('Command Control V')
    expect(spokenKeys(['⌃⌥', 'Space'])).toBe('Control Option Space')
    expect(spokenKeys(['esc'])).toBe('Escape')
  })
})
