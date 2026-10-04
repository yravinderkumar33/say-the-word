// Tests that take keyboard focus are a nuisance to someone who is typing. This waits
// until nobody has touched the keyboard or the mouse for a while before they start.
import { spawnSync } from 'node:child_process'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Seconds since the last key press, click or pointer movement. */
export function idleSeconds() {
  const output = spawnSync('ioreg', ['-c', 'IOHIDSystem'], { encoding: 'utf8' }).stdout
  const match = /"HIDIdleTime" = (\d+)/.exec(output)
  return match ? Number(match[1]) / 1e9 : 0
}

/**
 * Resolves true once the Mac has been idle for `seconds`, or false if that has not
 * happened within `maxWaitMs`.
 */
export async function waitForIdle(seconds, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs
  let announced = false
  for (;;) {
    if (idleSeconds() >= seconds) return true
    if (Date.now() > deadline) return false
    if (!announced) {
      console.log(`Waiting until the keyboard and mouse have been idle for ${seconds} s…`)
      announced = true
    }
    await sleep(1_000)
  }
}
