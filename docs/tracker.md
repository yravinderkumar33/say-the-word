# Tracker

Task status for the plan in [03 Implementation phases](03-implementation-phases.md). The dated log, with evidence for each claim, is in [progress.md](progress.md).

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done and verified · `[!]` waiting on a person

## Residual QA fixes — 2026-10-04

- [x] R1: background Secure Input history no longer exempts the current field. Copy/recovery handles refused automatic paste.
- [x] R2: a valid terminal `done:true` is required before a warm-up establishes locality; malformed, empty and incomplete responses fail closed.
- [x] R3: warm evidence is tied to server, canonical model name and digest; changed models warm again, within the existing deadline.
- [x] Full checks pass: 626 TypeScript tests and 115 Swift tests. Native and pipeline closure probes pass. Fresh build, separate signed package and all package checks pass; all 11 packaged assets match the build.
- [x] Built and newly signed packaged quiet-app suites each pass 52/52, including three new full-dictation regression scenarios; each records 41 intercepted pastes and zero open microphone streams. All thirteen audit findings are accepted within the audited code scope.
- [!] Real keyboard/paste sign-off still needs an Accessibility-trusted execution host and an available Mac. The fresh package smoke reports `accessibilityTrusted=false`.
- [!] The fixed package is staged at `dist/.qa-security-fixes/mac-arm64/Whisper Flow Dev.app`. The existing app is running from `dist/mac-arm64` and was not stopped or overwritten.

See [the sign-off report](qa-signoff-2026-10-04.md). Its earlier review withheld sign-off for R1–R3; this entry records the subsequent requested fixes. The implementation history below is preserved with its original verification limits.

## Independent QA audit — 2026-10-04

- [x] Fresh build and full checks: 453 TypeScript tests and 71 Swift tests pass.
- [x] Built and packaged quiet-app suites: 43/43 scenarios each; no microphone streams left open.
- [x] Code audit, targeted fault reproductions, signed-package verification, and visible setup-window inspection. See [the QA report](qa-audit-2026-10-04.md) and its reusable evidence scripts.
- [x] Address the report's 13 findings: five P1 privacy/recovery/paste issues, six P2 correctness issues, and two P3 consistency issues. Existing green tests do not cover these failure paths. **Done 2026-10-04: each finding was checked first, all thirteen held, and each is fixed, with a regression test that fails when the fix is taken out for all but the wording.** The table is under "Fixes for the audit's findings" below; the evidence is in the progress log.
- [!] Real key-tap/paste rerun was blocked by Accessibility trust in this execution context; synthetic grant and TextEdit focus checks failed before paste assertions. Physical-key, hardware, real first-grant, and voice-quality gates remain open.
- [ ] Review the development-only npm advisory and explicit release-fuse hardening before distribution.

The audit did not implement fixes or change the application's existing settings. The phase history below describes prior work; the audit report is the current list of newly verified defects and coverage limits.

**Current focus:** the first report from real use ("the text is not getting pasted", 2026-10-03) is found and fixed; the entry of 2026-10-04 in the progress log has the cause and the evidence. Everything that can be built and verified without a person is done through Phase 4, and so is the part of Phase 5 that does not touch the helper. What decides the next step is at the bottom: the checks that need hands and a voice, and the set of your own dictations that Phases 3 and 4 are judged on.

**Earlier implementation verification (before the residual R1–R3 fixes above):** `npm run check` passes with 578 unit tests and 112 Swift tests; `npm run test:app` passes 49 of 49 scenarios, built and on the final package. Of the two tests that take the keyboard, `npm run test:helper:integration` passes 22 of 22 on the final helper, and the password input is still refused after 65 seconds. `npm run test:e2e` passed 11 of 11 on the package before the review fixes; on the final package it got through 2 of 11 and then stopped itself, as it should, because the owner came back to the Mac. Earlier that afternoon the keyboard tests had run four times over a FaceTime call; the progress log has what happened and what was changed in the tests. The live paste into six apps (TextEdit, iTerm2, VS Code, Safari, Brave, Chrome) is from the verification before the audit and was not repeated.

**Recorded policy choices:** F01 now uses the strict choice: background history never disables current Secure Input protection. This can refuse ordinary dictation into an app that macOS has named by mistake; recovery offers Copy. F06 retains the complete-snapshot policy: a clipboard that cannot be copied whole is not restored, and the pill says "The clipboard now holds this dictation".

## Setup

- [x] Project skills installed in `.claude/skills/`: `frontend-design`, `swift-testing-pro`, `swift-concurrency-pro` (sources and hashes in `skills-lock.json`)
- [x] Apple-documentation MCP server added to `.mcp.json` (`sosumi`); it becomes active after the next session start and approval
- [!] `context7` documentation MCP server: installed already, needs its authorization link opened once
- [x] Tracker and progress log created
- [x] `CLAUDE.md` with working agreements and commands

## Milestone 1: dependable Verbatim dictation

### Phase 0: skeleton and signed app

Done 2026-10-03. Evidence is in the progress log.

- [x] Remove `.playwright-mcp/`; `git init`; `.gitignore`; MIT licence; README
- [x] `package.json` with the pinned toolchain; dependencies installed
- [x] TypeScript, ESLint, Prettier and Vitest configs
- [x] electron-vite config: main, two preloads, two renderer entries, worker entry, worklet
- [x] Main process: lifecycle, single instance, `app://` protocol, window security defaults
- [x] Overlay and hub renderer stubs
- [x] Speech worker stub with MessagePort echo
- [x] Swift helper stub (SwiftPM package, `ready` and `ping`) and build script
- [x] `--smoke` self-check
- [x] Build-assertion script
- [x] electron-builder config, entitlements, signed `.app`
- [x] Verified: `npm run check` (types, lint, format, 18 unit tests, 11 Swift tests), build assertions, smoke in three modes (built, dev server, packaged), `codesign --verify --deep --strict`

### Phase 1: helper, hotkeys, destination-aware paste

Done 2026-10-03, apart from two checks that need a person. Evidence is in the progress log.

- [x] Helper: protocol codec, event tap with stateful swallowing, shortcut matcher
- [x] Helper: destination capture, paste transaction, permission checks
- [x] Helper: password-field refusal, for native fields (accessibility role) and Chromium pages (Secure Event Input held by the frontmost app)
- [x] Helper bridge in main: spawn, JSON-lines RPC, restart with backoff (tested against a stand-in helper)
- [x] Session state machine (push-to-talk, quick-tap cancel, `Esc`, processing rows) with fake-clock tests
- [x] Session controller: session ids, cancel rules, stale-result rule, point of no return
- [x] In-memory recovery buffer; paste-last and copy-last
- [x] The app pastes a fixed sentence on `Fn` release, in development and in the packaged build
- [x] Verified automatically: 58 Swift tests; 86 unit tests; helper integration test 15 of 15; end-to-end test 10 of 10 against the built output and against the packaged app
- [x] Packaged app launched the way a user launches it (`open -n`): runs, and waits for the Accessibility permission without crashing
- [x] Accessibility granted to the packaged app (2026-10-03 22:06); shortcuts become active; the grant survived three rebuilds on 2026-10-04 (same signing identity), with nothing asked again
- [!] Globe-key decision: needs a physical `Fn` key (synthetic key events do not trigger the system Globe action). Indirect so far: the system log of an hour's use with the physical key shows no emoji picker, input switch or Apple Dictation at any of thirteen releases

### Phase 2: first real dictation, Verbatim

Built and verified automatically on 2026-10-03. Evidence is in the progress log; measurements are in `benchmarks.md`.

- [x] Model catalog and download with resume and checksum; the setup window's Download button
- [x] Parakeet engine in the speech worker; voice detection; decoding in pieces at pauses
- [x] Microphone capture (worklet, 16 kHz), audio port to the worker, session ids across processes
- [x] Failure handling from the session rules: microphone refused, slow, missing or lost; worker crash with one automatic retry; helper lost; sleep, lock and user switch; the 2-minute limit; model missing or unloaded
- [x] Interrupted sessions keep their text for recovery; cancelled sessions paste nothing and release the microphone
- [x] Pill: Resting, Starting, Listening, Processing, Recovery, with Cancel, Copy and Dismiss; sounds generated in code
- [x] Tray with status and microphone selection; setup window (permissions, model download)
- [x] The model is unloaded after ten minutes without dictation and loaded again on the next one
- [x] Debug control and fake-microphone test with injected faults (`npm run test:app`), which never takes focus or touches the keyboard
- [x] Latency gates measured and passed
- [x] Dependability checklist, automated part: every scenario 10 of 10
- [x] Packaged app: the speech library loads inside the signed app and transcribes
- [x] Accessibility and Microphone granted to the packaged app (2026-10-03)
- [!] Dictate with your own voice in everyday apps. Three short dictations with the physical key were pasted into VS Code on 2026-10-04 (seen in the log, not arranged); a word on how it went is what is missing
- [!] Two checklist items that need hardware: unplug a microphone mid-recording; close the lid mid-recording

## Milestone 2: Cleaned mode, chosen on your own voice

### Phase 3: personal evaluation set and engine check

The tooling was built and verified on 2026-10-03. The set itself needs your voice.

- [x] Opt-in evaluation recording mode (tray → Evaluation → "Save every dictation")
- [x] `eval:stt` scoring script: word errors and corrections needed, overall and per tag, with the worst dictations shown word by word
- [x] Verified: nothing is saved unless the mode is on; with it on, the recording and its text are saved; the script scores what the app saved (`npm run test:app`, built and packaged)
- [!] Record 30–50 dictations and correct the text beside each; run `npm run eval:stt`; confirm the engine. The steps are in [03 Implementation phases](03-implementation-phases.md)

### Phase 4: Cleaned mode

Built and verified automatically on 2026-10-03, ahead of the Phase 3 result: none of it depends on which recognizer wins. Verbatim stays the default until the personal set says otherwise.

- [x] Rules-only text: hesitation sounds, stuttered function words, dictionary replacements (the dictionary is `dictionary` in the settings file, and applies in both modes)
- [x] Ollama client: streaming, no thinking, fixed context, errors mid-stream, cancel
- [x] Local-only enforcement: a model that would run elsewhere is never contacted; a reply that came from elsewhere is discarded and the model blocked
- [x] Refiner: skip rules, a deadline inside the fixed 4 s ceiling, pre-warm at key-down, every stage of the text kept in the recovery buffer
- [x] Guard, with the required test cases and an early stop while the reply is still arriving
- [x] Mode switch in the tray, with a line saying which model is in use or why only the rules are
- [x] `npm run eval:cleanup`: as heard, rules only and final text against what was meant; how often the model's text was used and why not; timing
- [x] Verified: 353 unit tests; `npm run test:app` scenarios for a stopped, slow and wrong model and for cloud models; the written samples and six dictations in the app with the real `qwen3.5:4b`
- [x] Packaged app rebuilt with Cleaned mode in it (2026-10-04): `npm run test:app -- --packaged` passes 42 of 42
- [ ] Starting Ollama when it is installed but not running (the tray says it is not running; an offer to start it belongs with onboarding in Phase 6)
- [!] Run `npm run eval:cleanup` on the personal set, read the diffs for meaning changes, and choose the default mode and model

## Fixes after the first report from use (2026-10-04)

- [x] Paste refused on every first launch: the helper's once-only permission question was asked before the grant. Trust is now read live, and the helper is replaced when the grant arrives
- [x] A log file (`~/Library/Logs/Whisper Flow/main.log`, tray → Show Log) with a reason for every refused paste; never what was said
- [x] Packaging cannot leave a half-signed app where it can be opened (staging folder), and takes half a minute instead of seven
- [x] Six further bugs found on a second read of the code (model unloaded mid-recording, worker lost while loading, Undo with the recording gone, pill-click clock, modifier bits, frontmost app without a bundle id)
- [x] The key-posting test tool lost the last event of a chord now and then, which explains the earlier one-in-eleven failures of `test:e2e`
- [ ] One speaker-played recording at a normal level was heard as "No speech heard"; not reproduced, not explained
- [x] Three review agents gave a second opinion on the helper, the main process and the renderer: about thirty-five findings, each checked. Fixed with tests: the tap taken down when Accessibility is withdrawn, Secure Input left on by macOS, Caps Lock, a lost key release, the clipboard save, recordings with no frames, a microphone failing after the release, Undo with nothing captured, double-clicks on the pill, audio kept after use, worklets that never finished, the audio graph that never slept, a slow worker start, a full disk during the download, one bad settings entry, the notice shown behind the lock screen, the model list asked of another machine, test switches in a release build, cleanup rules deleting real words, the cleanup guard accepting changed meaning, a helper that would not leave, a log that stopped after one failed write, and nine smaller ones. The second entry of 2026-10-04 in the progress log has the table
- [ ] Open from that review: a panel that takes the keyboard without becoming frontmost (Spotlight, the emoji picker) can receive the paste; an app that reads the clipboard later than half a second gets the old content (the read receipt fixes it); the paste shortcut's event source
- [!] `CLAUDE.md` gives the first, less exact explanation of the remembered permission answer. The corrected one is in the implementation reference, section C; the sentence in `CLAUDE.md` is yours to change or approve, because a reviewing agent pointed it out

## Fixes for the audit's findings (2026-10-04)

Each finding was checked against the code before it was changed. All thirteen were real. "Test" names where the regression test lives; every one fails with the fix taken out (F13 is wording and has none).

|     | Finding                                                  | Status    | What was done                                                                                                                                                                                                 | Test                                                                                                  |
| --- | -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| F01 | Password protection expired after 60 s                   | [x] fixed | No time or background-history exception. Current Secure Input for the foreground app refuses paste, apart from the documented terminal exception; recovery offers Copy                                        | Swift: `SecureInputHistoryTests`, `SecureFieldPolicyTests`; live with `--hold-password 65`            |
| F02 | Ollama redirects were followed                           | [x] fixed | No Ollama request follows a redirect; the tray says why cleanup fell back                                                                                                                                     | `ollama-client.test.ts` (real loopback servers), `test:app` scenario                                  |
| F03 | A warm-up reply naming a remote host was ignored         | [x] fixed | Only a completed local warm reply for the verified server, canonical model name and digest permits a transcript. Remote metadata blocks immediately; replacements warm again and all waits share the deadline | `refiner.test.ts`, `ollama-client.test.ts`, `test:app` scenario                                       |
| F04 | Undo after recognition failed and erased the kept text   | [x] fixed | The recording is held until the session is over; an attempt with no text keeps the earlier text                                                                                                               | `session-controller.test.ts`, `recovery-buffer.test.ts`, `test:app` scenario                          |
| F05 | A paste could happen after the app had given up on it    | [x] fixed | The request carries the time the app stops waiting; the helper does nothing after it. The app the paste was meant for is asked whether it is still in front                                                   | Swift: `PasteSequenceTests`; `helper-bridge.test.ts`; `test:helper:integration` with a slow clipboard |
| F06 | A partial clipboard copy was put back as whole           | [x] fixed | A copy is whole or not taken, with its formats in order; the pill says so when the clipboard could not be kept                                                                                                | Swift: `ClipboardSnapshotTests` (a private pasteboard); `pill-messages.test.ts`                       |
| F07 | An old Escape release disarmed the next session's Escape | [x] fixed | The arming is used up when the press goes down                                                                                                                                                                | Swift: `BindingMatcherTests`                                                                          |
| F08 | A setting that could not be saved still took effect      | [x] fixed | Written first, in force only then; the menu is redrawn and the pill says so                                                                                                                                   | `settings.test.ts`, `settings-changer.test.ts`, `test:app` scenario                                   |
| F09 | A damaged model of the same size could not be repaired   | [x] fixed | The marker records size and date; unvouched files are read once before loading; a failed load checks every file; "Check the model files" in the setup window                                                  | `model-store.test.ts`, `model-step.test.ts`, `test:app` no-model launch                               |
| F10 | A failed write waited on a stalled network; no cancel    | [x] fixed | A failed write, 30 s of silence and Cancel each end the download at once; Cancel button; resume                                                                                                               | `model-store.test.ts`, `test:app` no-model launch                                                     |
| F11 | No models offered when the list names no capabilities    | [x] fixed | Such entries are asked about through `/api/show`, once per digest                                                                                                                                             | `local-only.test.ts`, with Ollama's documented example                                                |
| F12 | A late status answer overwrote a newer setting           | [x] fixed | Only the latest asking is shown; the menu asks again as the pointer reaches it                                                                                                                                | `latest-only.test.ts`, two `test:app` scenarios                                                       |
| F13 | Setup window and README described the app wrongly        | [x] fixed | Both recording modes and the one case of saved audio are described; a notice while dictations are being saved                                                                                                 | Read; `capture-hub` picture                                                                           |

Not part of F01 to F13, and not done: the three risks the report lists as already known (a panel that takes the keyboard without becoming frontmost, the fixed half-second before the clipboard is put back, the paste shortcut's event source), the fallback for a destination that loses its accessibility information, the development-only npm advisory, and the release fuses.

## Later phases

- [~] Phase 5: interaction parity
  - [x] Hands-free: double-tap `Fn`, `Fn`+`Space`, or a click on the resting pill; the next press stops it; a third tap right after locking cancels; Stop and Cancel on the pill; lock sound
  - [x] Recordings up to 20 minutes, decoded in pieces while recording, with a warning sound a minute before the limit
  - [x] Verified: state-machine tests for every row of the table; `npm run test:app` scenarios for each way in and out, for Undo and Retry, and for how long a recording is held
  - [x] Undo for a cancelled session and Retry for a failed decode: the recording is held for as long as the offer is shown (six seconds), then dropped
  - [ ] Failed-paste detection through a pasteboard read receipt
  - [ ] Pill hover hint and right-click menu; Secure Input notice; shortcut for keyboards without `Fn`
  - [x] `npm run test:e2e` and `npm run test:helper:integration` rerun after hands-free (2026-10-04): 11 of 11 and 16 of 16. The end-to-end test now starts the way a first launch does, with Accessibility arriving after the app is up
  - [!] Try each gesture with the physical key: synthetic key events were not used for these
- [ ] Phase 6: Hub and persistent history
- [ ] Phase 7: context awareness and Command Mode
- [ ] Phase 8: release

## Gates

Results go in `docs/benchmarks.md`; this table shows the outcome.

| Gate                                                                         | Phase | Status                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------- | ----- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Fn` events dropped in the tap suppress the system Globe action              | 1     | waiting on a person       | A synthetic `Fn` tap does not trigger the Globe action at all, so only a physical key can show this. One keyboard layout is enabled on this Mac and the Globe key is at its default, so a leak would show as the emoji picker. The system log of 2026-10-03 22:06 to 23:03, an hour of physical `Fn` use, shows no emoji picker, dictation or input-switcher process at any of thirteen releases; and on 2026-10-04, with the input switcher running, it logged nothing at any of four physical releases (holds of 1.3 s and more). Encouraging, but an absence in a log, not an observation, and a quick tap has not been tried |
| Destination rule does not block correct pastes in everyday apps              | 1     | passed (automated)        | Driven one by one on 2026-10-04 with the packaged app: TextEdit, iTerm2, Safari and Brave expose a focused element and are tracked at element level; VS Code and Chrome expose none and are compared on app and window. None refused, and the text was read back from each. Slack was not driven                                                                                                                                                                                                                                                                                                                                 |
| Speech addon loads in the signed, hardened utility process                   | 2     | passed                    | `sherpa-onnx-node` 1.13.8 unpacked and signed; in the packaged app the model loads in about 1.1 s and a recording is transcribed word for word                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Warm decode of 10 s of audio ≤ 0.5 s                                         | 2     | passed                    | About 250 ms with four threads; 229 ms median inside the app for 8.8 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Single-decode length (30 s within 2.5 GB peak)                               | 2     | passed                    | A 57 s clip decodes in one piece with a 2.49 GB peak; the cap is 30 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Key-down to microphone live: median ≤ 200 ms, 95th percentile ≤ 400 ms       | 2     | passed                    | Built-in microphone, 20 runs: median 108 ms, 95th percentile 119 ms, slowest 157 ms. Bluetooth not measured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Release to text appearing, Verbatim, 10 s utterance: 95th percentile ≤ 1.0 s | 2     | passed                    | 8.8 s utterance, 20 runs: median 384 ms, 95th percentile 420 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Recognizer accuracy on the personal set                                      | 3     | not run                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Release to text appearing, Cleaned: within tail decode plus the ceiling      | 4     | passed on synthetic input | Real `qwen3.5:4b`: release to paste median 0.93 s, slowest 2.1 s over six dictations; cleanup alone median 1.5 s, slowest 2.0 s over 14 written samples; fallback 1 of 14. A model that never answers is cut off at the deadline                                                                                                                                                                                                                                                                                                                                                                                                 |
| Cleanup on the personal set meets the decision rule                          | 4     | waiting on a person       | Needs the personal set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Waiting on a person

None of these blocks the next phase. The first three are what stands between the build and daily use.

1. **Use it.** The app is running (reopened at 12:27 on 2026-10-04, on the package with the fixes for the audit's findings); to start it again, `open -n "dist/mac-arm64/Whisper Flow Dev.app"`. Hold `Fn` in a text field, speak, let go. If a dictation does not arrive, note what the pill said; the log (menu-bar icon → Show Log) has the rest, and it never contains what you said.
2. **Quit Wispr Flow, then try the physical `Fn` key's other gestures:** tap it once and twice quickly (note whether the emoji picker opens or Apple Dictation starts), and try `Fn`+arrow keys. If a tap triggers any system action, say so: the fallback is ready to be switched on.
3. **Dictate in the apps you use** (Slack, Chrome, VS Code, Terminal) and note anything that feels wrong: a clipped first word, text landing in the wrong place, a paste refused when it should not have been, "No speech heard" when you did speak.
4. **Two hardware checks:** unplug or switch off a microphone mid-recording, and close the lid mid-recording. Nothing should be pasted in the second case, and no key should be stuck afterwards.
5. **The personal set (Phases 3 and 4):** record 30 to 50 real dictations and correct the text beside each (about 30 to 45 minutes). The steps are under "How to record it" in [03 Implementation phases](03-implementation-phases.md). Then:
   - `npm run eval:stt` shows whether Parakeet is accurate enough on your voice to stay the engine.
   - `npm run eval:cleanup` shows whether Cleaned mode leaves you fewer corrections than Verbatim, and prints each cleaned text beside what you meant so you can look for changed meaning. Cleaned becomes the default only if it clearly helps and does not change meaning.
6. **Run the end-to-end keyboard test once on the final build**, when you can leave the Mac alone for a minute: quit the app, then `npm run test:e2e -- --packaged --when-idle 120`. It passed its first two checks on this package and stopped when you came back; the other nine last passed on the package before the review fixes. (The helper's own keyboard test has passed on the final build.) Both tests now refuse to start during a call or a video and stop when you bring another app forward.
7. **Three things from the audit's fixes that need a person.** (a) Lock the screen with a browser's password field focused, unlock, and dictate into it: it must be refused ("Secure Input is on: nothing was pasted"). (b) If macOS ever leaves Secure Input on after the lock screen, automatic dictation into the app it names stays refused until the signal clears; switching away and back must not bypass protection. Copy remains available. (c) In the setup window, try Cancel during a model download and "Stop saving" while dictations are being saved: the functions behind them are tested, the buttons themselves were not clicked.
8. **The real first launch.** The fix for a grant that arrives while the app is running was tested with an imitation of that order of events. The real thing needs someone to remove the app from System Settings → Privacy & Security → Accessibility, open it, grant again, and dictate without restarting it.

Also open (optional): authenticate `context7` through `/mcp`, which gives the assistant current library documentation.
