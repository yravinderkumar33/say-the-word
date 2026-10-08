import { describe, expect, it } from 'vitest'
import { SampleBuffer } from '../../src/main/stt/sample-buffer'
import { fixRecognizerArtifacts } from '../../src/main/stt/text-artifacts'

/** A buffer holding 0, 1, 2, … in frames of the given sizes. */
function buffer(...frameSizes: number[]): SampleBuffer {
  const samples = new SampleBuffer()
  let next = 0
  for (const size of frameSizes) {
    samples.append(Float32Array.from({ length: size }, () => next++))
  }
  return samples
}

describe('SampleBuffer', () => {
  it('reports its length', () => {
    expect(new SampleBuffer().length).toBe(0)
    expect(buffer(4, 4, 2).length).toBe(10)
  })

  it('slices within one frame', () => {
    expect(Array.from(buffer(8).slice(2, 5))).toEqual([2, 3, 4])
  })

  it('slices across frame boundaries', () => {
    expect(Array.from(buffer(4, 4, 4).slice(2, 10))).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('slices across frames of different sizes', () => {
    expect(Array.from(buffer(3, 1, 5, 2).slice(1, 10))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('returns everything for the full range', () => {
    expect(Array.from(buffer(2, 3).slice(0, 5))).toEqual([0, 1, 2, 3, 4])
  })

  it('clamps a range that runs past either end', () => {
    expect(Array.from(buffer(4, 4).slice(-5, 3))).toEqual([0, 1, 2])
    expect(Array.from(buffer(4, 4).slice(6, 100))).toEqual([6, 7])
  })

  it('returns nothing for an empty or inverted range', () => {
    expect(buffer(4).slice(2, 2)).toHaveLength(0)
    expect(buffer(4).slice(3, 1)).toHaveLength(0)
    expect(new SampleBuffer().slice(0, 10)).toHaveLength(0)
  })

  it('returns a copy, not a view of the stored audio', () => {
    const samples = buffer(4)
    samples.slice(0, 4).fill(99)

    expect(Array.from(samples.slice(0, 4))).toEqual([0, 1, 2, 3])
  })
})

describe('fixRecognizerArtifacts', () => {
  it('restores the space the recognizer leaves out before a currency amount', () => {
    expect(fixRecognizerArtifacts('The invoice total is$4,350, due Friday.')).toBe(
      'The invoice total is $4,350, due Friday.',
    )
    expect(fixRecognizerArtifacts('about€20 and roughly£5')).toBe('about €20 and roughly £5')
  })

  it('leaves correct text alone', () => {
    const text = 'It costs $4,350, or US$5,000 at most. Email me at a$b.'
    expect(fixRecognizerArtifacts('It costs $4,350.')).toBe('It costs $4,350.')
    expect(fixRecognizerArtifacts('Email me at a$b.')).toBe('Email me at a$b.')
    expect(fixRecognizerArtifacts(text)).toBe(
      'It costs $4,350, or US $5,000 at most. Email me at a$b.',
    )
  })
})

it('enforces its sample boundary without accepting a partial oversized frame', () => {
  const buffer = new SampleBuffer(4)
  buffer.append(new Float32Array(3))
  expect(() => buffer.append(new Float32Array(2))).toThrow('Recording sample limit reached')
  expect(buffer.length).toBe(3)
})
