import { describe, expect, it } from 'vitest'
import type { PillState } from '@shared/ipc'
import {
  clock,
  isClickable,
  layoutOf,
  pillView,
  spokenFor,
  type PillLocal,
} from '../../src/renderer/overlay/pill-view'

const NOW = 2_000_000
const local = (change: Partial<PillLocal> = {}): PillLocal => ({
  hover: false,
  busy: false,
  quiet: false,
  microphone: 'MacBook Pro Microphone (Built-in)',
  now: NOW,
  key: 'Fn',
  keySpoken: 'Fn',
  atRest: true,
  pausedUntil: null,
  ...change,
})
const listening = (handsFree: boolean, agoMs = 42_000, leftMs = 1_158_000): PillState => ({
  kind: 'listening',
  handsFree,
  startedAt: NOW - agoMs,
  limitAt: NOW + leftMs,
})
const kept: PillState = {
  kind: 'recovery',
  message: 'Focus moved, so nothing was pasted',
  messageKind: 'protected',
  canCopy: true,
  sound: true,
}

describe('what the pill draws', () => {
  it('all but disappears at rest, and carries a mark when text is waiting', () => {
    expect(pillView({ kind: 'resting', waiting: false }, local())).toEqual({
      shape: 'rest',
      waiting: false,
    })
    expect(pillView({ kind: 'resting', waiting: true }, local())).toEqual({
      shape: 'rest',
      waiting: true,
    })
  })

  it('names the key and the click in its hint, once the pointer has rested on it', () => {
    expect(pillView({ kind: 'resting', waiting: false }, local({ hover: true }))).toEqual({
      shape: 'hint',
      text: 'Hold Fn to dictate · click for hands-free',
    })
    expect(
      pillView({ kind: 'resting', waiting: false }, local({ hover: true, key: '⌃⌥' })),
    ).toMatchObject({ text: 'Hold ⌃⌥ to dictate · click for hands-free' })
  })

  it('says how to fetch waiting text in the hint, in place of the usual one', () => {
    expect(pillView({ kind: 'resting', waiting: true }, local({ hover: true }))).toEqual({
      shape: 'waitingHint',
      text: 'Unpasted dictation · ⌘⌃V to paste',
    })
  })

  it('shows a microphone that is not live yet without words, unless it is slow', () => {
    expect(pillView({ kind: 'starting', slow: false }, local())).toEqual({
      shape: 'mic',
      live: false,
      text: null,
    })
    expect(pillView({ kind: 'starting', slow: true }, local())).toMatchObject({
      live: false,
      text: 'Waiting for the microphone…',
    })
  })

  it('names the microphone that hears nothing, without what the system adds to its name', () => {
    expect(pillView(listening(false), local())).toEqual({ shape: 'mic', live: true, text: null })
    expect(pillView(listening(false), local({ quiet: true }))).toMatchObject({
      text: 'No sound from MacBook Pro Microphone',
    })
    expect(pillView(listening(false), local({ quiet: true, microphone: null }))).toMatchObject({
      text: 'No sound from the microphone',
    })
  })

  it('counts up in a hands-free recording, and down in its last minute', () => {
    expect(pillView(listening(true), local())).toEqual({
      shape: 'handsFree',
      clock: '0:42',
      lastMinute: false,
    })
    expect(pillView(listening(true, 1_152_000, 48_000), local())).toEqual({
      shape: 'handsFree',
      clock: '0:48 left',
      lastMinute: true,
    })
    expect(pillView(listening(true, 1_140_000, 60_000), local())).toMatchObject({
      clock: '1:00 left',
    })
  })

  it('offers Cancel on a text that is on its way only once it has taken a while', () => {
    expect(pillView({ kind: 'processing', long: false, hint: null }, local())).toEqual({
      shape: 'processing',
      text: null,
      busy: false,
      canCancel: false,
    })
    expect(pillView({ kind: 'processing', long: true, hint: null }, local())).toMatchObject({
      canCancel: true,
    })
  })

  it('says what a text is waiting for', () => {
    const view = (hint: 'tidying' | 'loadingModel', change?: Partial<PillLocal>) =>
      pillView({ kind: 'processing', long: true, hint }, local(change))

    expect(view('tidying')).toMatchObject({ text: 'Tidying' })
    expect(view('loadingModel')).toMatchObject({ text: 'Loading the speech model…' })
    // A press of the key while it is busy is answered first.
    expect(view('tidying', { busy: true })).toMatchObject({
      text: 'Still on the last dictation',
      busy: true,
    })
  })

  it('gives a confirmation no buttons, and every other message its kind and its offers', () => {
    expect(
      pillView(
        {
          kind: 'recovery',
          message: 'Copied',
          messageKind: 'confirm',
          canCopy: false,
          sound: false,
        },
        local(),
      ),
    ).toEqual({ shape: 'confirm', text: 'Copied' })
    expect(pillView(kept, local())).toEqual({
      shape: 'message',
      kind: 'protected',
      text: 'Focus moved, so nothing was pasted',
      redo: null,
      canCopy: true,
    })
    expect(
      pillView(
        {
          kind: 'recovery',
          message: 'Cancelled',
          messageKind: 'plain',
          canCopy: false,
          sound: false,
          redo: 'Undo',
        },
        local(),
      ),
    ).toMatchObject({ kind: 'plain', redo: 'Undo', canCopy: false })
  })

  it('shows no hint over anything but the resting pill', () => {
    expect(pillView(listening(false), local({ hover: true })).shape).toBe('mic')
    expect(pillView(kept, local({ hover: true })).shape).toBe('message')
  })
})

describe('what can be clicked', () => {
  const clickable = (state: PillState, change?: Partial<PillLocal>): boolean =>
    isClickable(pillView(state, local(change)))

  it('is the pill at rest, and any pill with a button', () => {
    expect(clickable({ kind: 'resting', waiting: false })).toBe(true)
    expect(clickable({ kind: 'resting', waiting: true }, { hover: true })).toBe(true)
    expect(clickable(listening(true))).toBe(true)
    expect(clickable(kept)).toBe(true)
    expect(clickable({ kind: 'processing', long: true, hint: null })).toBe(true)
  })

  it('is nothing while a key is held, while a text arrives quickly, or on a confirmation', () => {
    expect(clickable({ kind: 'starting', slow: true })).toBe(false)
    expect(clickable(listening(false))).toBe(false)
    expect(clickable({ kind: 'processing', long: false, hint: 'tidying' })).toBe(false)
    expect(
      clickable({
        kind: 'recovery',
        message: 'Copied',
        messageKind: 'confirm',
        canCopy: false,
        sound: false,
      }),
    ).toBe(false)
  })
})

describe('where the buttons are', () => {
  const layout = (state: PillState, change?: Partial<PillLocal>): string =>
    layoutOf(pillView(state, local(change)))

  it('changes when the hint brings its button, and when Cancel arrives', () => {
    const waiting: PillState = { kind: 'resting', waiting: true }
    expect(layout(waiting)).not.toBe(layout(waiting, { hover: true }))
    expect(layout({ kind: 'processing', long: false, hint: null })).not.toBe(
      layout({ kind: 'processing', long: true, hint: null }),
    )
  })

  it('does not change when the plain hint appears: a click still starts hands-free', () => {
    const resting: PillState = { kind: 'resting', waiting: false }
    expect(layout(resting)).toBe(layout(resting, { hover: true }))
  })

  it('changes when a message loses a button and keeps its words (Sp-F6)', () => {
    // The text was fetched with the paste shortcut: Copy goes, Retry stays.
    const failed = (canCopy: boolean): PillState => ({
      kind: 'recovery',
      message: 'The recognizer took too long',
      messageKind: 'problem',
      canCopy,
      sound: true,
      redo: 'Retry',
    })
    expect(layout(failed(true))).not.toBe(layout(failed(false)))
  })

  it('does not change when only the words do: a slow start, a quiet microphone, the clock', () => {
    expect(layout({ kind: 'starting', slow: false })).toBe(layout({ kind: 'starting', slow: true }))
    expect(layout(listening(false))).toBe(layout(listening(false), { quiet: true }))
    expect(layout(listening(true))).toBe(layout(listening(true, 50_000)))
  })
})

describe('what VoiceOver says', () => {
  it('says nothing at rest, and says once that a dictation is waiting to be fetched', () => {
    expect(spokenFor({ kind: 'resting', waiting: false }, local())).toBe('')
    expect(spokenFor({ kind: 'resting', waiting: true }, local())).toBe(
      'Unpasted dictation. Command Control V to paste.',
    )
  })

  it('says nothing for what passes in a moment, or while a voice would be recorded with it', () => {
    expect(spokenFor({ kind: 'starting', slow: false }, local())).toBe('')
    expect(spokenFor({ kind: 'processing', long: false, hint: null }, local())).toBe('')
    // The sound says "speak now"; a sentence here would be dictated along with the words.
    expect(spokenFor(listening(false), local())).toBe('')
  })

  it('says a wait in words once it lasts', () => {
    expect(spokenFor({ kind: 'starting', slow: true }, local())).toBe('Waiting for the microphone.')
    expect(spokenFor({ kind: 'processing', long: true, hint: null }, local())).toBe(
      'Writing the text. Cancel Dictation is in the menu bar menu.',
    )
    expect(spokenFor({ kind: 'processing', long: false, hint: 'tidying' }, local())).toBe(
      'Tidying the text.',
    )
    // Cancel is offered from a second on, and said with what is being waited for (QA-14).
    expect(spokenFor({ kind: 'processing', long: true, hint: 'tidying' }, local())).toBe(
      'Tidying the text. Cancel Dictation is in the menu bar menu.',
    )
    expect(spokenFor({ kind: 'processing', long: true, hint: 'loadingModel' }, local())).toBe(
      'Loading the speech model. Cancel Dictation is in the menu bar menu.',
    )
    expect(spokenFor({ kind: 'processing', long: true, hint: null }, local({ busy: true }))).toBe(
      'Still writing the last dictation.',
    )
  })

  it('names a microphone that hears nothing', () => {
    expect(spokenFor(listening(false), local({ quiet: true }))).toBe(
      'No sound from MacBook Pro Microphone.',
    )
  })

  it('names the key that stops a hands-free recording, in words, then counts it down in quarters of a minute', () => {
    expect(spokenFor(listening(true), local())).toBe('Hands-free. Press Fn to stop.')
    expect(spokenFor(listening(true), local({ key: '⌃⌥', keySpoken: 'Control Option' }))).toBe(
      'Hands-free. Press Control Option to stop.',
    )
    expect(spokenFor(listening(true, 1_140_000, 60_000), local())).toBe('60 seconds left.')
    expect(spokenFor(listening(true, 1_152_000, 48_000), local())).toBe('60 seconds left.')
    expect(spokenFor(listening(true, 1_155_000, 45_000), local())).toBe('45 seconds left.')
    expect(spokenFor(listening(true, 1_199_000, 1_000), local())).toBe('15 seconds left.')
  })

  it('names a way without the pointer for everything a message offers, in words and not in symbols', () => {
    expect(spokenFor(kept, local())).toBe(
      'Focus moved, so nothing was pasted. Command Control C copies it.',
    )
    const withRedo = (redo: 'Undo' | 'Retry', canCopy = false): PillState => ({
      kind: 'recovery',
      message: redo === 'Undo' ? 'Cancelled' : 'The recognizer took too long',
      messageKind: redo === 'Undo' ? 'plain' : 'problem',
      canCopy,
      sound: false,
      redo,
    })
    expect(spokenFor(withRedo('Undo'), local())).toBe('Cancelled. Undo is in the menu bar menu.')
    expect(spokenFor(withRedo('Retry'), local())).toBe(
      'The recognizer took too long. Retry is in the menu bar menu.',
    )
    expect(spokenFor(withRedo('Retry', true), local())).toBe(
      'The recognizer took too long. Retry is in the menu bar menu. Command Control C copies it.',
    )
  })

  it('says a message with nothing to do as it stands, and that a recording stopped at the limit was used', () => {
    const says = (message: string, messageKind: 'plain' | 'problem' | 'note' | 'confirm') =>
      spokenFor({ kind: 'recovery', message, messageKind, canCopy: false, sound: false }, local())

    expect(says('No speech heard', 'plain')).toBe('No speech heard.')
    expect(says('Copied', 'confirm')).toBe('Copied.')
    expect(says('The clipboard now holds this dictation', 'note')).toBe(
      'The clipboard now holds this dictation.',
    )
    expect(says('The microphone disconnected', 'problem')).toBe('The microphone disconnected.')
    // Said because the main process says the recording stopped at the limit, whatever its words (Sp-F7).
    const stopped = (message: string): PillState => ({
      kind: 'recovery',
      message,
      messageKind: 'problem',
      canCopy: false,
      sound: true,
      stoppedAtLimit: true,
    })
    expect(spokenFor(stopped('Stopped at the 20-minute limit'), local())).toBe(
      'Stopped at the 20-minute limit. Your text was pasted.',
    )
    expect(spokenFor(stopped('Recording stopped after 20 minutes'), local())).toBe(
      'Recording stopped after 20 minutes. Your text was pasted.',
    )
    expect(says('Stopped at the 20-minute limit', 'problem')).toBe(
      'Stopped at the 20-minute limit.',
    )
  })
})

describe('the pill when it is not shown at rest, and while dictation is paused', () => {
  it('draws nothing at rest when the setting says so, and has nothing to click', () => {
    const hidden = pillView({ kind: 'resting', waiting: true }, local({ atRest: false }))
    expect(hidden).toEqual({ shape: 'hidden' })
    expect(isClickable(hidden)).toBe(false)
    // A dictation, and a message about one, are shown all the same.
    expect(pillView(listening(false), local({ atRest: false })).shape).toBe('mic')
    expect(pillView(kept, local({ atRest: false })).shape).toBe('message')
  })

  it('says until when it is paused in its hint, and a click on it starts nothing', () => {
    const hint = pillView(
      { kind: 'resting', waiting: false },
      local({ hover: true, pausedUntil: '11:42' }),
    )
    expect(hint).toEqual({ shape: 'hint', text: 'Paused until 11:42 · resume in the menu bar' })
    expect(isClickable(hint, true)).toBe(false)
    expect(isClickable({ shape: 'rest', waiting: false }, true)).toBe(false)
    // Text that is waiting can still be copied from its hint.
    expect(isClickable({ shape: 'waitingHint', text: '' }, true)).toBe(true)
  })

  it('does not promise the paste shortcut while every shortcut is off', () => {
    const waiting: PillState = { kind: 'resting', waiting: true }

    expect(pillView(waiting, local({ hover: true, pausedUntil: '11:42' }))).toEqual({
      shape: 'waitingHint',
      text: 'Unpasted dictation · paused until 11:42',
    })
    expect(spokenFor(waiting, local({ pausedUntil: '11:42' }))).toBe(
      'Unpasted dictation. Paste Last Dictation is in the menu bar menu.',
    )
    // With dictation running again the shortcut is back, and so is its name.
    expect(pillView(waiting, local({ hover: true }))).toEqual({
      shape: 'waitingHint',
      text: 'Unpasted dictation · ⌘⌃V to paste',
    })
    expect(spokenFor(waiting, local())).toBe('Unpasted dictation. Command Control V to paste.')
  })
})

describe('clock', () => {
  it('shows minutes and seconds, and never goes below nought', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(42_999)).toBe('0:42')
    expect(clock(605_000)).toBe('10:05')
    expect(clock(-3_000)).toBe('0:00')
  })
})
