// Tests that take keyboard focus put windows in front of whatever is on the screen and
// press keys. They must not start while someone is using the Mac.
//
// A quiet keyboard does not mean nobody is there. On 2026-10-04 the keyboard tests ran
// four times over a FaceTime call, whose owner had not touched a key for minutes. So
// two things are looked at: how long ago a key, a click or the pointer last moved, and
// whether a call, a video or a recording is going on. macOS shows the second in its
// power assertions: what is keeping the display awake, and what has a microphone or
// the camera open.
import { spawnSync } from 'node:child_process'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Seconds since the last key press, click or pointer movement. */
export function idleSeconds() {
  const output = spawnSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' }).stdout
  const match = /"HIDIdleTime" = (\d+)/.exec(output)
  return match ? Number(match[1]) / 1e9 : 0
}

/** The kinds of power assertion that mean the display is being watched. */
const DISPLAY_KEPT_AWAKE = new Set(['PreventUserIdleDisplaySleep', 'NoDisplaySleepAssertion'])
/** Keeps the Mac awake for a command; says nothing about a person. The app test uses it. */
const NOT_A_PERSON = new Set(['caffeinate'])

/**
 * What is going on that a person would be watching or taking part in, or null.
 * `assertions` is the output of `pmset -g assertions`.
 */
export function busyWith(assertions) {
  let display = null
  let camera = false
  let microphone = false
  for (const line of assertions.split('\n')) {
    const held = /^\s*pid \d+\((.*)\): \[[^\]]*\] \S+ (\S+) named: "(.*)"/.exec(line)
    if (held) {
      const [, owner, kind, name] = held
      if (NOT_A_PERSON.has(owner)) continue
      if (DISPLAY_KEPT_AWAKE.has(kind)) {
        display ??= `${owner} is keeping the display awake ("${name}")`
      }
      if (/camera|VDCAssistant/i.test(owner)) camera = true
    } else if (/^\s*Resources:.*\baudio-in\b/.test(line)) {
      microphone = true
    }
  }
  if (display) return `${display}: a call or a video is on`
  if (camera) return 'the camera is in use'
  if (microphone) return 'a microphone is in use: a call, a recording or a dictation is on'
  return null
}

/** `busyWith` for this Mac, now. */
export function macBusyWith() {
  return busyWith(spawnSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' }).stdout ?? '')
}

/**
 * Resolves null once the Mac may be taken over: nobody has touched it for `idleFor`
 * seconds, and no call, video or recording is on (or has been during that time, as far
 * as this saw). Resolves with what is in the way if that has not happened within
 * `maxWaitMs`; with `maxWaitMs` 0 it looks once and does not wait.
 *
 * `ignoreCalls` leaves out everything but the keyboard and the mouse, for someone who
 * runs the test knowing a call or a video is on.
 */
export async function waitUntilFree({ idleFor, maxWaitMs, ignoreCalls = false }) {
  const deadline = Date.now() + maxWaitMs
  let announced = false
  /** When something was last seen going on, if it was. */
  let busyAt = null
  for (;;) {
    const idle = idleSeconds()
    const busy = ignoreCalls ? null : macBusyWith()
    if (busy) busyAt = Date.now()
    const inTheWay =
      busy ??
      (idle < idleFor ? `the keyboard or the mouse was used ${Math.round(idle)} s ago` : null) ??
      (busyAt !== null && Date.now() - busyAt < idleFor * 1_000
        ? 'a call or a video ended a moment ago'
        : null)
    if (!inTheWay) return null
    if (Date.now() >= deadline) return inTheWay
    if (!announced) {
      console.log(`Waiting until nobody is using the Mac (${inTheWay})…`)
      announced = true
    }
    await sleep(1_000)
  }
}

/**
 * For a test that takes the keyboard: true once it may start. Asked to wait for a quiet
 * keyboard (`idleFor` seconds), it waits up to a quarter of an hour for the Mac to be
 * free; otherwise it looks once. When the test may not start, this says why.
 */
export async function mayTakeTheKeyboard({ idleFor, evenIfInUse = false }) {
  const inTheWay = await waitUntilFree({
    idleFor,
    maxWaitMs: idleFor > 0 ? 15 * 60_000 : 0,
    ignoreCalls: evenIfInUse,
  })
  if (!inTheWay) return true
  console.log(`  skip everything: ${inTheWay}.`)
  console.log(
    '  This test puts windows in front and presses keys, so it does not start while someone is using the Mac.',
  )
  if (!evenIfInUse && macBusyWith()) console.log('  To run it all the same: -- --even-if-in-use')
  return false
}
