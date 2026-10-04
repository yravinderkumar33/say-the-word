import { describe, expect, it } from 'vitest'
import { busyWith } from '../../scripts/lib/mac-in-use.mjs'

const HEADER = `2026-10-04 14:05:00 +0530
Assertion status system-wide:
   PreventUserIdleDisplaySleep    1
   PreventUserIdleSystemSleep     1
Listed by owning process:
`

/** What `pmset -g assertions` listed on this Mac during a FaceTime call on 2026-10-04. */
const FACETIME_CALL = `${HEADER}   pid 406(coreaudiod): [0x0003687300018c04] 00:28:03 PreventUserIdleSystemSleep named: "com.apple.audio.VPAUAggregateAudioDevice-0x7849c0e40.context.preventuseridlesleep"
	Created for PID: 821.
	Resources: audio-in audio-out BuiltInMicrophoneDevice
   pid 60833(FaceTime): [0x0003686100058b93] 00:28:20 PreventUserIdleDisplaySleep named: "Ongoing A/V conference"
   pid 334(powerd): [0x0003649400018a58] 00:44:34 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
   pid 523(cameracaptured): [0x0003684500018b78] 00:28:49 PreventUserIdleSystemSleep named: "cameracaptured-idleSleepPreventionForBWFigCaptureDevice"
   pid 393(WindowServer): [0x0003649400098a57] 00:04:47 UserIsActive named: "com.apple.iohideventsystem.queue.tickle serviceID:100000aaa service:AppleMultitouchDevice product:Apple Internal Keyboard / Trackpad eventType:11"
	Timeout will fire in 912 secs Action=TimeoutActionRelease
   pid 84519(caffeinate): [0x00036ee400018d52] 00:00:34 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting for 300 secs
	Localized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.
	Timeout will fire in 266 secs Action=TimeoutActionRelease
No kernel assertions.
`

/** The same Mac a minute after the call ended, with someone typing. */
const AFTER_THE_CALL = `${HEADER}   pid 84792(caffeinate): [0x00036fd400018d6c] 00:01:37 PreventUserIdleSystemSleep named: "caffeinate command-line tool"
	Details: caffeinate asserting for 300 secs
	Localized=THE CAFFEINATE TOOL IS PREVENTING SLEEP.
	Timeout will fire in 203 secs Action=TimeoutActionRelease
   pid 334(powerd): [0x0003649400018a58] 00:49:37 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on"
   pid 334(powerd): [0x0003702500108389] 00:00:16 InternalPreventDisplaySleep named: "com.apple.powermanagement.delayDisplayOff"
	Timeout will fire in 284 secs Action=TimeoutActionTurnOff
   pid 393(WindowServer): [0x0003649400098a57] 00:00:00 UserIsActive named: "com.apple.iohideventsystem.queue.tickle serviceID:100000aaa service:AppleMultitouchDevice product:Apple Internal Keyboard / Trackpad eventType:11"
	Timeout will fire in 1200 secs Action=TimeoutActionRelease
No kernel assertions.
`

// The three below are written in the form pmset prints. They were not captured.
const held = (owner: string, kind: string, name: string, more = ''): string =>
  `${HEADER}   pid 4321(${owner}): [0x0003686100058b93] 00:01:10 ${kind} named: "${name}"\n${more}No kernel assertions.\n`

describe('whether someone is using the Mac', () => {
  it('sees a FaceTime call, and names what it saw', () => {
    expect(busyWith(FACETIME_CALL)).toBe(
      'FaceTime is keeping the display awake ("Ongoing A/V conference"): a call or a video is on',
    )
  })

  it('finds nothing going on once the call is over', () => {
    expect(busyWith(AFTER_THE_CALL)).toBeNull()
  })

  it('sees a video playing in a browser', () => {
    const video = held('Google Chrome', 'NoDisplaySleepAssertion', 'Video Wake Lock')
    expect(busyWith(video)).toMatch(/^Google Chrome is keeping the display awake/)
  })

  it('does not take the display kept awake by caffeinate for a person', () => {
    // The app test keeps the display awake this way while it runs.
    const ours = held('caffeinate', 'PreventUserIdleDisplaySleep', 'caffeinate command-line tool')
    expect(busyWith(ours)).toBeNull()
  })

  it('sees a microphone in use when nothing keeps the display awake', () => {
    const recording = held(
      'coreaudiod',
      'PreventUserIdleSystemSleep',
      'com.apple.audio.context.preventuseridlesleep',
      '\tCreated for PID: 821.\n\tResources: audio-in BuiltInMicrophoneDevice\n',
    )
    expect(busyWith(recording)).toMatch(/^a microphone is in use/)
  })

  it('does not take music for a person at the screen', () => {
    const music = held(
      'coreaudiod',
      'PreventUserIdleSystemSleep',
      'com.apple.audio.context.preventuseridlesleep',
      '\tCreated for PID: 900.\n\tResources: audio-out BuiltInSpeakerDevice\n',
    )
    expect(busyWith(music)).toBeNull()
  })

  it('sees the camera in use', () => {
    const camera = held(
      'cameracaptured',
      'PreventUserIdleSystemSleep',
      'cameracaptured-idleSleepPreventionForBWFigCaptureDevice',
    )
    expect(busyWith(camera)).toBe('the camera is in use')
  })

  it('finds nothing in output it cannot read', () => {
    expect(busyWith('')).toBeNull()
  })
})
