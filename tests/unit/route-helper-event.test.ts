import { describe, expect, it } from 'vitest'
import {
  describeHelperEvent,
  describeTarget,
  toMachineEvent,
} from '../../src/main/hotkeys/route-helper-event'

describe('toMachineEvent', () => {
  it('maps push-to-talk down and up, keeping the helper timestamps', () => {
    expect(toMachineEvent({ type: 'bindingDown', id: 'ptt', t: 1_200.5 })).toEqual({
      type: 'pttDown',
      t: 1_200.5,
    })
    expect(toMachineEvent({ type: 'bindingUp', id: 'ptt', t: 2_400, reason: 'released' })).toEqual({
      type: 'pttUp',
      t: 2_400,
    })
  })

  it('treats a release caused by a tap reset as an abort, never as a normal release', () => {
    expect(toMachineEvent({ type: 'bindingUp', id: 'ptt', t: 2_400, reason: 'tapReset' })).toEqual({
      type: 'abort',
    })
  })

  it('maps another key during the hold to an interruption', () => {
    expect(toMachineEvent({ type: 'interrupted', id: 'ptt', t: 5 })).toEqual({
      type: 'interrupted',
    })
  })

  it('maps the armed Escape to escape', () => {
    expect(toMachineEvent({ type: 'cancel', t: 5 })).toEqual({ type: 'escape' })
  })

  it.each(['pasteLast', 'copyLast'] as const)('maps %s on key-down only', (id) => {
    expect(toMachineEvent({ type: 'bindingDown', id, t: 5 })).toEqual({ type: id })
    expect(toMachineEvent({ type: 'bindingUp', id, t: 9, reason: 'released' })).toBeNull()
  })

  it('ignores shortcuts this build does not act on', () => {
    expect(toMachineEvent({ type: 'bindingDown', id: 'handsfree', t: 5 })).toBeNull()
    expect(toMachineEvent({ type: 'interrupted', id: 'command', t: 5 })).toBeNull()
  })

  it('ignores helper events that are not gestures', () => {
    expect(toMachineEvent({ type: 'tapState', installed: true, reason: 'timeout' })).toBeNull()
    expect(toMachineEvent({ type: 'pasteSettled', pasteId: 3, restored: true })).toBeNull()
  })
})

describe('the hands-free shortcut', () => {
  it('is its own gesture, separate from push-to-talk', () => {
    expect(toMachineEvent({ type: 'bindingDown', id: 'handsFree', t: 42 })).toEqual({
      type: 'handsFreeDown',
      t: 42,
    })
    // Its release means nothing: the recording is locked on.
    expect(
      toMachineEvent({ type: 'bindingUp', id: 'handsFree', t: 50, reason: 'released' }),
    ).toBeNull()
  })
})

describe('describeHelperEvent', () => {
  it('names the shortcut and what happened to it', () => {
    expect(describeHelperEvent({ type: 'bindingDown', id: 'ptt', t: 1 })).toBe('[key] ptt down')
    expect(describeHelperEvent({ type: 'bindingUp', id: 'ptt', t: 2, reason: 'released' })).toBe(
      '[key] ptt up',
    )
    expect(describeHelperEvent({ type: 'bindingUp', id: 'ptt', t: 2, reason: 'tapReset' })).toBe(
      '[key] ptt up (tapReset)',
    )
    expect(describeHelperEvent({ type: 'interrupted', id: 'ptt', t: 3 })).toBe(
      '[key] another key was pressed while ptt was held',
    )
    expect(describeHelperEvent({ type: 'cancel', t: 4 })).toBe('[key] escape')
  })

  it('says when macOS switched the key tap off', () => {
    expect(describeHelperEvent({ type: 'tapState', installed: true, reason: 'timeout' })).toBe(
      '[key] macOS switched the key tap off; it is back on (timeout)',
    )
  })

  it('says what became of the clipboard after a paste', () => {
    expect(describeHelperEvent({ type: 'pasteSettled', pasteId: 3, restored: true })).toBe(
      '[paste] clipboard put back',
    )
    expect(
      describeHelperEvent({
        type: 'pasteSettled',
        pasteId: 3,
        restored: false,
        reason: 'notSaved',
      }),
    ).toBe('[paste] clipboard left as it is (notSaved)')
    expect(describeHelperEvent({ type: 'pasteSettled', pasteId: 3, restored: false })).toBe(
      '[paste] clipboard left as it is',
    )
  })
})

describe('describeTarget', () => {
  it('names the app and what the helper could see of it', () => {
    expect(
      describeTarget({
        targetId: 4,
        secure: false,
        hasElement: false,
        hasWindow: true,
        bundleId: 'com.microsoft.VSCode',
        appName: 'Code',
      }),
    ).toBe('[target] app=com.microsoft.VSCode element=no window=yes secure=no')
  })

  it('says why a field counts as a password field', () => {
    expect(
      describeTarget({
        targetId: 5,
        secure: true,
        secureReason: 'secureInput',
        hasElement: true,
        hasWindow: true,
        bundleId: 'com.brave.Browser',
      }),
    ).toBe('[target] app=com.brave.Browser element=yes window=yes secure=secureInput')
  })

  it('says when the Secure Input that refused it was seen held in the background before', () => {
    // An app that kept Secure Input on after the lock screen, say.
    expect(
      describeTarget({
        targetId: 5,
        secure: true,
        secureReason: 'secureInput',
        secureInputStuck: true,
        hasElement: true,
        hasWindow: true,
        bundleId: 'com.brave.Browser',
      }),
    ).toBe(
      '[target] app=com.brave.Browser element=yes window=yes ' +
        'secure=secureInput (background Secure Input observed)',
    )
    // A terminal, whose Secure Input does not count.
    expect(
      describeTarget({
        targetId: 6,
        secure: false,
        secureInputStuck: true,
        hasElement: true,
        bundleId: 'com.apple.Terminal',
      }),
    ).toBe(
      '[target] app=com.apple.Terminal element=yes window=unknown ' +
        'secure=no (background Secure Input observed)',
    )
  })

  it('falls back to the process name for an app with no bundle id', () => {
    expect(
      describeTarget({ targetId: 6, secure: false, hasElement: true, appName: 'some-tool' }),
    ).toBe('[target] app=unknown (some-tool) element=yes window=unknown secure=no')
  })

  it('says when nothing was frontmost', () => {
    expect(describeTarget({ targetId: -1, secure: false, hasElement: false })).toBe(
      '[target] nothing is frontmost',
    )
  })
})
