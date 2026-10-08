import { describe, expect, it } from 'vitest'
import { parseSwitches } from '../../scripts/lib/args.mjs'

/** The switches of `npm run test:e2e`. */
const E2E = {
  packaged: { type: 'boolean' },
  only: { type: 'string' },
  'when-idle': { type: 'number' },
  'even-if-in-use': { type: 'boolean' },
} as const

describe('the switches a script is given', () => {
  it('reads them as the documentation spells them', () => {
    const values = parseSwitches(E2E, ['--packaged', '--when-idle', '120', '--only', 'focus'])
    expect(values).toEqual({ packaged: true, 'when-idle': 120, only: 'focus' })
  })

  it('reads a value given after an equals sign, which was once taken for none', () => {
    expect(parseSwitches(E2E, ['--when-idle=120'])['when-idle']).toBe(120)
  })

  it('leaves out a switch that was not given', () => {
    const values = parseSwitches(E2E, [])
    expect(values['when-idle']).toBeUndefined()
    expect(values.packaged).toBeUndefined()
  })

  it('refuses a switch given without its value', () => {
    expect(() => parseSwitches(E2E, ['--when-idle'])).toThrow(/argument missing/)
    expect(() => parseSwitches(E2E, ['--only'])).toThrow(/argument missing/)
  })

  it('refuses a number it cannot read, or one too small', () => {
    expect(() => parseSwitches(E2E, ['--when-idle', '2m'])).toThrow(
      '--when-idle takes a whole number of 1 or more, not "2m"',
    )
    expect(() => parseSwitches(E2E, ['--when-idle', '0'])).toThrow(/of 1 or more/)
    expect(() => parseSwitches(E2E, ['--when-idle', '1.5'])).toThrow(/whole number/)
  })

  it('takes zero where a switch allows it', () => {
    expect(parseSwitches({ show: { type: 'number', min: 0 } }, ['--show', '0']).show).toBe(0)
  })

  it('refuses a misspelt switch', () => {
    expect(() => parseSwitches(E2E, ['--when-idel', '120'])).toThrow(/Unknown option '--when-idel'/)
  })

  it('refuses a word that belongs to no switch', () => {
    expect(() => parseSwitches(E2E, ['cancel'])).toThrow(/Unexpected argument 'cancel'/)
  })

  it('refuses a value for a switch that takes none', () => {
    expect(() => parseSwitches(E2E, ['--packaged=yes'])).toThrow(/does not take an argument/)
  })
})
