import { describe, expect, it } from 'vitest'
import { microphonesSchema } from '@shared/ipc'

const microphone = (index: number) => ({
  deviceId: index.toString(16).padStart(64, '0'),
  label: `USB Microphone ${index} (0d8c:0014)`,
})

describe('the microphones the overlay page reports', () => {
  it('are taken as the system lists them', () => {
    const listed = [microphone(1), microphone(2), { deviceId: 'default-ish', label: '' }]
    expect(microphonesSchema.safeParse(listed).success).toBe(true)
  })

  // Their names are written to the settings: a page cannot fill the file with them.
  it('are refused when there are more than any Mac offers', () => {
    const many = Array.from({ length: 65 }, (_, index) => microphone(index))
    expect(microphonesSchema.safeParse(many).success).toBe(false)
    expect(microphonesSchema.safeParse(many.slice(0, 64)).success).toBe(true)
  })

  it('are refused when a name or an id is longer than any device has', () => {
    expect(
      microphonesSchema.safeParse([{ ...microphone(1), label: 'x'.repeat(10_000) }]).success,
    ).toBe(false)
    expect(
      microphonesSchema.safeParse([{ ...microphone(1), deviceId: 'x'.repeat(10_000) }]).success,
    ).toBe(false)
  })
})
