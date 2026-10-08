import { describe, expect, it } from 'vitest'
import { microphoneName, shortenInTheMiddle } from '@shared/microphone-name'

describe('microphoneName', () => {
  it('leaves out what the system adds to a name', () => {
    expect(microphoneName('MacBook Pro Microphone (Built-in)')).toBe('MacBook Pro Microphone')
    expect(microphoneName('Default - MacBook Pro Microphone (Built-in)')).toBe(
      'MacBook Pro Microphone',
    )
    expect(microphoneName('AirPods Pro (Bluetooth)')).toBe('AirPods Pro')
    expect(microphoneName('USB Audio Device (0d8c:0014)')).toBe('USB Audio Device')
  })

  it('keeps a name that has nothing added', () => {
    expect(microphoneName('Studio Display Microphone')).toBe('Studio Display Microphone')
  })

  it('keeps a name that is nothing but a bracket', () => {
    expect(microphoneName('(Virtual)')).toBe('(Virtual)')
  })

  it('shortens a long name in the middle, keeping both ends', () => {
    const name = microphoneName('Elgato Wave:3 Professional Broadcast Microphone')
    expect(name.length).toBeLessThanOrEqual(28)
    expect(name.startsWith('Elgato Wave')).toBe(true)
    expect(name.endsWith('Microphone')).toBe(true)
    expect(name).toContain('…')
  })
})

describe('shortenInTheMiddle', () => {
  it('leaves a text that fits alone', () => {
    expect(shortenInTheMiddle('short', 10)).toBe('short')
    expect(shortenInTheMiddle('exactly ten', 11)).toBe('exactly ten')
  })

  it('never makes a text longer than asked', () => {
    for (const longest of [8, 9, 12, 20]) {
      expect(shortenInTheMiddle('abcdefghijklmnopqrstuvwxyz', longest).length).toBe(longest)
    }
  })
})
