import { describe, expect, it } from 'vitest'
import type { Microphone } from '@shared/ipc'
import {
  microphoneToUse,
  orderFrom,
  rankedMicrophones,
  withFirst,
  withFreshNames,
} from '../../src/main/microphones'

const display: Microphone = { deviceId: 'display', label: 'Studio Display Microphone' }
const builtIn: Microphone = { deviceId: 'built-in', label: 'MacBook Pro Microphone (Built-in)' }
const airpods: Microphone = { deviceId: 'airpods', label: 'AirPods Pro' }

describe('which microphone a dictation uses', () => {
  it('follows the system default until an order has been given', () => {
    expect(microphoneToUse([], [builtIn, display])).toBeNull()
  })

  it('takes the first of the order that is connected', () => {
    expect(microphoneToUse([airpods, display, builtIn], [builtIn, display])).toBe('display')
    expect(microphoneToUse([airpods, display], [airpods, display])).toBe('airpods')
  })

  it('falls back to the system default when none of the order is connected', () => {
    expect(microphoneToUse([airpods], [builtIn])).toBeNull()
  })

  it('asks for the first choice anyway while what is connected is not known yet', () => {
    // The capture falls back to the default by itself if that microphone is not there.
    expect(microphoneToUse([airpods, display], [])).toBe('airpods')
  })

  it('reads a settings file from before there was an order as an order of one', () => {
    expect(rankedMicrophones({ microphoneOrder: [], microphoneId: 'usb' })).toEqual([
      { deviceId: 'usb', label: '' },
    ])
    expect(rankedMicrophones({ microphoneOrder: [], microphoneId: null })).toEqual([])
    expect(rankedMicrophones({ microphoneOrder: [display], microphoneId: 'usb' })).toEqual([
      display,
    ])
  })
})

describe('changing the order', () => {
  it('puts a chosen microphone first, once', () => {
    expect(withFirst([display, builtIn], builtIn)).toEqual([builtIn, display])
    expect(withFirst([], airpods)).toEqual([airpods])
  })

  it('saves an order with each name, and drops an id nobody knows', () => {
    const order = orderFrom(['airpods', 'made-up', 'built-in', 'airpods'], [airpods], [builtIn])

    expect(order).toEqual([airpods, builtIn])
  })

  it('takes the name of a connected microphone over a remembered one', () => {
    const remembered = { deviceId: 'display', label: '' }

    expect(orderFrom(['display'], [remembered], [display])).toEqual([display])
  })

  it('brings remembered names up to date, and says nothing when none changed', () => {
    expect(withFreshNames([{ deviceId: 'display', label: '' }, airpods], [display])).toEqual([
      display,
      airpods,
    ])
    expect(withFreshNames([display, airpods], [display])).toBeNull()
    // A microphone whose name is not known yet does not erase the one remembered.
    expect(withFreshNames([display], [{ deviceId: 'display', label: '' }])).toBeNull()
  })
})
