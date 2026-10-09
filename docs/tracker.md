# Tracker

Task status for the plan in [03 Implementation phases](03-implementation-phases.md). The dated log, with evidence for each claim, is in [progress.md](progress.md).

**Legend:** `[ ]` not started · `[~]` in progress · `[x]` done and verified · `[!]` waiting on a person

## Product identity and explainer — 2026-10-09

- The owner chose **Say the Word** as the public product name. Current interface copy and builds use it; local packages are named `Say the Word Dev.app`.
- The README links the 36-second explainer through a clickable cover and a direct video link. The media lives in `docs/media`.
- The GitHub repository was renamed to `yravinderkumar33/say-the-word` (the old URL redirects). The macOS bundle IDs, `WHISPER_FLOW_*` switches and existing `~/Library/Application Support/Whisper Flow` data stay compatible with earlier builds. New logs use `~/Library/Logs/Say the Word/main.log`. Historical evidence below retains the names used when it was recorded.

- [x] `npm run check`: 1,185 TypeScript tests, 121 Swift tests, type-checking, lint and formatting. Build assertions and all nine quiet smoke checks passed.
- [x] `npm run pack` (later the same day): `dist/mac-arm64/Say the Word Dev.app`, every package check and nine packaged smoke checks passed; bundle id unchanged.
- [x] The isolated screenshot harness completed all 67 captures in `dist/.pictures-say-the-word`. Inspected About, Welcome and Accessibility: the new name fits without clipping or overlap.

## Review of the whole codebase before submission — 2026-10-05, night

- [x] Dead code, unused exports and dependencies (`knip`, each entry checked by hand), and a read of every area by eight reviewers: about 135 findings, each shown to hold before it was changed. The progress log has them, worst first.
- [x] Fixed: the four worst (Cleaned mode losing a dictation that said "constructor"; the guard accepting a moved negation or swapped numbers; a release build accepting debugging switches; the keyboard tests posting keys while another dictation app listened), every medium finding, and the low ones that were safe. Every new test fails with its fix taken out.
- [x] Verified: `npm run check` (1,171 TypeScript tests, 121 Swift tests), `npm run build`, `npm run smoke` (quiet now), `npm run test:app` 91 of 91 on the built output, `npm run pictures` (67), and a package built from this tree in a scratch folder that passed every check of `check-pack.mjs`, its smoke included. `npm audit`: 0 vulnerabilities.
- [x] **Electron fuses** (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect-brk` act before the app's own code, under its permissions): set in `electron-builder.yml` and read back from that scratch package (running as Node, `NODE_OPTIONS` and the inspector off; archive-only loading and the archive's integrity check on).
- [ ] **Licence notices.** MIT, Apache-2.0 and CC-BY-4.0 ask for their notices to ship; the bundles carry none, and About shows names and licence names only. A notices file generated at build time, shipped in the app and linked from About, is the fix: before any release.
- [ ] Recommendations left for later, each in the progress log: splitting `wire-dictation.ts` (its Cleanup and Try it part) and `FirstRun.tsx` by step; a typed request map for the storage process; one shared launcher for the test scripts; signing the helper without the app's entitlements; type-checking the `.mjs` scripts; typed lint rules for floating promises in `src/main` (one left at the time of writing); Secure Input with several login sessions (needs a second user to test); the menu-bar icon and Home sharing one status function; a structured cleanup reason in `AppStatus` instead of a sentence four places read.
- [!] **Run the keyboard tests once on this build**, with the packaged app quit (they refuse while it runs): `npm run test:e2e -- --when-idle 120` and `npm run test:helper:integration -- --when-idle 120`. The helper's paste requests in the second were changed for the fields the helper now requires, and not run.
- [!] **Rebuild the package and run its suite**, when the open app may be replaced: `npm run pack`, then `npm run test:app -- --packaged`.

## End-to-end QA review — 2026-10-05

- [x] Review the current working tree, run full checks/build, reproduce fault paths, and inspect the implemented user journeys. Findings and evidence: [QA_REPORT_5_10_2026.md](../QA_REPORT_5_10_2026.md).
- [x] **Resolve the report's 14 confirmed issues (3 P1, 9 P2, 2 P3). Done the evening of 2026-10-05:** each was checked first, all fourteen held, and all fourteen are fixed, with history and the figures moved into SQLite in a storage process of their own (the plan the owner approved). A review of the first fixes found defects they had brought in (one failing write holding back every later one, history in memory lost without a word, a time to keep deleting what its question had not counted, Cleaned-mode latency, and smaller ones); those are fixed too. Every new test fails with its fix taken out. The closure table is at the end of the report; the evidence is in the progress log.
- [x] The report's remaining risk 6 (hosts on a download's way not listed on the Privacy page) is fixed. Risk 5 (a crashed overlay page) was not reproduced and is not addressed.
- [!] Complete guarded real-keyboard/paste, fresh macOS permission, physical microphone, and VoiceOver verification on an available Mac. The audit preserved the normal running instance and its session-only history.

|       | Finding                                            | Status    | Test                                                              |
| ----- | -------------------------------------------------- | --------- | ----------------------------------------------------------------- |
| QA-01 | An unrelated setting authorised deleting history   | [x] fixed | `settings.test.ts`, `history-store.test.ts`, `test:app`           |
| QA-02 | A failed migration deleted the only copy           | [x] fixed | `history-store.test.ts`                                           |
| QA-03 | Practice saved audio and text                      | [x] fixed | `evaluation-sessions.test.ts`, `test:app`                         |
| QA-04 | Stop Saving let the recording under way be written | [x] fixed | `evaluation-sessions.test.ts`, `test:app`                         |
| QA-05 | Delete Everything left text for Paste Last         | [x] fixed | `session-controller.test.ts`, `stt-host.test.ts`, `test:app`      |
| QA-06 | A later save hid an unsaved earlier one            | [x] fixed | `storage-host.test.ts`, `history-store.test.ts`                   |
| QA-07 | Unreadable history uncounted and undeletable       | [x] fixed | `history-store.test.ts`, `questions.test.ts`                      |
| QA-08 | Cleanup accepted changed numbers                   | [x] fixed | `guard.test.ts`                                                   |
| QA-09 | One slow comparison disabled cleanup               | [x] fixed | `refiner.test.ts`                                                 |
| QA-10 | An older model choice overwrote a later one        | [x] fixed | `hub-mutations.test.ts`, `test:app`                               |
| QA-11 | A new microphone inherited "Heard you"             | [x] fixed | `async-controls.test.ts`                                          |
| QA-12 | Try it kept an old model's result                  | [x] fixed | `async-controls.test.ts`, `test:app`                              |
| QA-13 | The volume slider showed a value not saved         | [x] fixed | `async-controls.test.ts`                                          |
| QA-14 | Processing Cancel missing from the menu            | [x] fixed | `pill-view.test.ts`, `test:app` (reads the menu the app built)    |

## The interface, from the design — 2026-10-04

The interface is designed in Claude Design from [the design brief](05-design-brief.md). The owner chose direction A. Round 2 (the pill, Home, the components and the tokens) was built first. **Every other screen of the design followed the same evening, except Dictionary, Apps and Snippets: the owner decided against those, the screens and what they would do.** What differs from the design, and why, is listed in the brief.

Round 2:

- [x] The design's tokens as CSS variables: light and dark for the windows, one look for the pill, and the Increase Contrast, Reduce Motion and Reduce Transparency variants (`src/renderer/tokens.css`)
- [x] The pill: every state, variant and kind of message in the design. Hint after half a second of hover; "Waiting for the microphone…" after a second; green bars only while live; "No sound from …" when nothing has been heard for three seconds; the clock of a hands-free recording and its last-minute countdown; Cancel on a text only once it has taken a second; "Tidying"; the shake and "Still on the last dictation"; an icon and a weight per kind of message; confirmations that leave after two seconds; a message that waits under the pointer; the mark for text left waiting
- [x] Everything the pill offers is in the menu-bar menu too (Undo Cancel, Retry, Stop Dictation, Cancel Dictation, Paste Last Dictation, Copy Last Dictation), and what VoiceOver says for each state is written (`spokenFor`)
- [x] The main window: sidebar, Home (the status line with its one fix button in place of the setup checklist, mode, microphone, gestures, the last three dictations, the figures line), the amber bar while dictations are being saved, the layout for a small window
- [x] The figures: words per day and recent timings in `usage.sqlite`. Counts only
- [x] The "Buy me a coffee" link, menu item and its one door to the browser. Hidden until there is an address

The rest of the design:

- [x] **The first run**, one step per screen: Welcome, Microphone (with a live level and "Heard you"), Accessibility (with a drawing of the list in System Settings; it completes by itself), Keys (only when another dictation app is on the same key), Try it (a practice box, three exercises ticked off as each is done, and a drawing of what the pill is saying), Cleaned mode, Ready (the gestures, where the app lives, Open at login). A new installation starts with it; Settings can show it again
- [x] **History**: every dictation with its time, app, first line and how it ended, by day; search; pause; how long it is kept (only until the app quits, 7 days, 30 days, until deleted); Delete All. Held in memory unless the owner chooses otherwise, and that choice is confirmed in a system dialog which no page can answer. On disk: one file per day in a folder only the owner can read, deleted when its time is up
- [x] **A dictation opened**: outcome and mode in words, the reason it was not pasted or was tidied with rules only, with one fix button; what was heard beside what was written, with the differences marked; the timings; Copy, Use the Raw Text, Delete
- [x] **Cleanup**: the two modes as cards, Ollama's state with its one action (Get Ollama, Start Ollama), the models that run on this Mac, a refused model with the reason in words, what Cleaned may and never changes, and "Try it": a sentence three ways with the time each took
- [x] **Privacy**: where speech is recognized; what has been contacted since launch, counted by the app itself; what is stored and how much, each with Show in Finder and Delete; Delete Everything. Each deletion is confirmed in a system dialog
- [x] **Settings**: the dictation key (`Fn`, or `Control`+`Option` for keyboards without it); microphones in an order of preference, each with a ten-second test; sounds on or off, their volume, and each cue to listen to; the pill shown at rest or only while dictating; Open at login; Show in Dock; how long the speech model stays in memory; the log and "Copy Diagnostics"; the Ollama address (this Mac only)
- [x] **About**, from the design: version, the licences, and the links, each shown once it has somewhere to lead
- [x] **The menu-bar icon in five shapes** (ready, live, needs attention, paused, saving), told apart without colour, and **the menu** in the design's order with Recent (the last five; choosing one copies it) and "Pause Dictation for 1 Hour"
- [x] **Pause**: every shortcut off for an hour, or until resumed in the menu or on Home; the pill, the menu and Home each say until when
- [x] **The app icon** (`npm run icon`), an app menu of the app's own in place of Electron's, and no Dock icon unless Settings asks for one
- [x] **The accessibility round**: the contrast of secondary text, a focus ring on every control, the sidebar as one stop for the keyboard with the arrow keys inside it, the history list worked from the keyboard, a sentence for VoiceOver wherever a mark or a colour carries meaning, and the Increase Contrast and Reduce Transparency looks
- [x] Tests never reach outside the app: what would open Finder, the browser, the clipboard, a login item or a system dialog is replaced by a counting stand-in when the app runs under test
- [x] `npm run pictures`: the icon's five shapes, the pill's states, every page in light and dark, the first run step by step, and the two accessibility looks, from a quiet instance
- [x] A second reading by a reviewer with no part in the work, with two helpers: fifteen findings and a dozen smaller ones, each checked first. All held. Two were blockers (a settings file that could not be read deleted the saved history at the next start; day files named by the local date went wrong after a change of time zone); all are fixed but two that are answered as designed (the table is in the progress log)
- [x] Verified: `npm run check` (943 TypeScript tests, 123 Swift tests); `npm run test:app` 82 of 82 on the built output and 82 of 82 on the signed package, with 24 new scenarios since Round 2; `npm run pack`; `npm run pictures`, 67 pictures
- [ ] **Not built, by decision:** Dictionary, Apps, Snippets
- [ ] **Not built, and why** (each is in the brief): a recorder for the other shortcuts; the Keys step for a Globe key that is set to do something else; Check for Updates (Phase 8); the pill's right-click menu
- [!] **The Buy Me a Coffee address.** It goes in `SUPPORT_URL` in `src/main/support.ts`; the note from the maker on About appears with it (`MAKER_NAME` in `src/shared/product.ts` is the name it is signed with)
- [!] **The repository's address**, for About's "Source code" and "Report a problem": `SOURCE_URL` in `src/main/support.ts`
- [!] **Look at it and listen to it.** The pictures were looked at. Nobody has yet gone through the first run on a Mac that has never run the app, used `Control`+`Option` or Pause with a real key, dragged a microphone into another place with a real pointer, opened the menu, seen where the close, minimise and zoom buttons sit over the sidebar, or listened to VoiceOver
- [!] **A decision: how long Undo and Retry are offered to someone who does not use the pointer.** They are in the menu-bar menu for as long as the pill shows them, which is six seconds, and a menu takes longer than that to reach from the keyboard. Offering them for longer means holding the recording for longer. One middle way is to hold the message while the menu is open

## Residual QA fixes — 2026-10-04

- [x] R1: background Secure Input history no longer exempts the current field. Copy/recovery handles refused automatic paste.
- [x] R2: a valid terminal `done:true` is required before a warm-up establishes locality; malformed, empty and incomplete responses fail closed.
- [x] R3: warm evidence is tied to server, canonical model name and digest; changed models warm again, within the existing deadline.
- [x] Full checks pass: 626 TypeScript tests and 115 Swift tests. Native and pipeline closure probes pass. Fresh build, separate signed package and all package checks pass; all 11 packaged assets match the build.
- [x] Built and newly signed packaged quiet-app suites each pass 52/52, including three new full-dictation regression scenarios; each records 41 intercepted pastes and zero open microphone streams. All thirteen audit findings are accepted within the audited code scope.
- [!] Real keyboard/paste sign-off still needs an Accessibility-trusted execution host and an available Mac. The fresh package smoke reports `accessibilityTrusted=false`.
- [x] The fixed package was first staged at `dist/.qa-security-fixes/mac-arm64/Whisper Flow Dev.app`, beside a running copy. Since the evening of 2026-10-04 the package in `dist/mac-arm64` itself is a build with these fixes (and the interface from the design); the staged copy is no longer needed.

See [the sign-off report](qa-signoff-2026-10-04.md). Its earlier review withheld sign-off for R1–R3; this entry records the subsequent requested fixes. The implementation history below is preserved with its original verification limits.

## Independent QA audit — 2026-10-04

- [x] Fresh build and full checks: 453 TypeScript tests and 71 Swift tests pass.
- [x] Built and packaged quiet-app suites: 43/43 scenarios each; no microphone streams left open.
- [x] Code audit, targeted fault reproductions, signed-package verification, and visible setup-window inspection. See [the QA report](qa-audit-2026-10-04.md) and its reusable evidence scripts.
- [x] Address the report's 13 findings: five P1 privacy/recovery/paste issues, six P2 correctness issues, and two P3 consistency issues. Existing green tests do not cover these failure paths. **Done 2026-10-04: each finding was checked first, all thirteen held, and each is fixed, with a regression test that fails when the fix is taken out for all but the wording.** The table is under "Fixes for the audit's findings" below; the evidence is in the progress log.
- [!] Real key-tap/paste rerun was blocked by Accessibility trust in this execution context; synthetic grant and TextEdit focus checks failed before paste assertions. Physical-key, hardware, real first-grant, and voice-quality gates remain open.
- [ ] Review the development-only npm advisory and explicit release-fuse hardening before distribution.

The audit did not implement fixes or change the application's existing settings. The phase history below describes prior work; the audit report is the current list of newly verified defects and coverage limits.

**Current focus (2026-10-04, night):** the interface is built from the design, except the three screens decided against (the section above). What follows is the state before that work, and still holds.

**Earlier focus:** the first report from real use ("the text is not getting pasted", 2026-10-03) is found and fixed; the entry of 2026-10-04 in the progress log has the cause and the evidence. Everything that can be built and verified without a person is done through Phase 4, and so is the part of Phase 5 that does not touch the helper. What decides the next step is at the bottom: the checks that need hands and a voice, and the set of your own dictations that Phases 3 and 4 are judged on.

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
  - [x] Pill hover hint (2026-10-04, with the pill from the design)
  - [x] A dictation key for keyboards without `Fn`: `Control`+`Option`, chosen in Settings (2026-10-04). The helper takes the table as it took the first; the Swift tests cover it. Not yet pressed on a physical keyboard
  - [x] Pause Dictation for 1 Hour (2026-10-04): the shortcuts are off, and the menu, the pill and Home say until when
  - [ ] Pill right-click menu; Secure Input notice
  - [x] `npm run test:e2e` and `npm run test:helper:integration` rerun after hands-free (2026-10-04): 11 of 11 and 16 of 16. The end-to-end test now starts the way a first launch does, with Accessibility arriving after the app is up
  - [!] Try each gesture with the physical key: synthetic key events were not used for these
- [x] Phase 6: Hub and persistent history, built from the design on 2026-10-04 (see the section at the top): the first run, History, Cleanup, Privacy, Settings, About. The dictionary editor and Snippets are not built, by the owner's decision
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

1. **Use it.** The package in `dist/mac-arm64` was rebuilt late on 2026-10-04 (23:55) with every screen of the design and every fix up to then. It was not started: it was not running at the time (it had been quit at 20:58), and it would put a second key tap on `Fn` beside Wispr Flow's. For a new build after the rename, quit Wispr Flow, then `open -n "dist/mac-arm64/Say the Word Dev.app"`. Two things are different from the build before: it has no Dock icon unless Settings › General › Show in Dock is switched on (it lives in the menu bar; the window opens from the menu-bar icon), and the window opens on Home, not on the first run, because this Mac has settings already. Settings › Advanced › Setup guide › Show Again shows the first run. Hold `Fn` in a text field, speak, let go. If a dictation does not arrive, note what the pill said; the log (menu-bar icon → Show Log) has the rest, and it never contains what you said.
2. **Quit Wispr Flow, then try the physical `Fn` key's other gestures:** tap it once and twice quickly (note whether the emoji picker opens or Apple Dictation starts), and try `Fn`+arrow keys. If a tap triggers any system action, say so: the fallback is ready to be switched on.
3. **Dictate in the apps you use** (Slack, Chrome, VS Code, Terminal) and note anything that feels wrong: a clipped first word, text landing in the wrong place, a paste refused when it should not have been, "No speech heard" when you did speak.
4. **Two hardware checks:** unplug or switch off a microphone mid-recording, and close the lid mid-recording. Nothing should be pasted in the second case, and no key should be stuck afterwards.
5. **The personal set (Phases 3 and 4):** record 30 to 50 real dictations and correct the text beside each (about 30 to 45 minutes). The steps are under "How to record it" in [03 Implementation phases](03-implementation-phases.md). Then:
   - `npm run eval:stt` shows whether Parakeet is accurate enough on your voice to stay the engine.
   - `npm run eval:cleanup` shows whether Cleaned mode leaves you fewer corrections than Verbatim, and prints each cleaned text beside what you meant so you can look for changed meaning. Cleaned becomes the default only if it clearly helps and does not change meaning.
6. **Run the end-to-end keyboard test once on the final build**, when you can leave the Mac alone for a minute: quit the app, then `npm run test:e2e -- --packaged --when-idle 120`. It passed its first two checks on this package and stopped when you came back; the other nine last passed on the package before the review fixes. (The helper's own keyboard test has passed on the final build.) Both tests now refuse to start during a call or a video and stop when you bring another app forward.
7. **Three things from the audit's fixes that need a person.** (a) Lock the screen with a browser's password field focused, unlock, and dictate into it: it must be refused ("Secure Input is on: nothing was pasted"). (b) If macOS ever leaves Secure Input on after the lock screen, automatic dictation into the app it names stays refused until the signal clears; switching away and back must not bypass protection. Copy remains available. (c) In the setup window, try Cancel during a model download and "Stop saving" while dictations are being saved: the functions behind them are tested, the buttons themselves were not clicked.
8. **The real first launch.** The fix for a grant that arrives while the app is running was tested with an imitation of that order of events. The real thing needs someone to remove the app from System Settings → Privacy & Security → Accessibility, open it, grant again, and dictate without restarting it.

9. **What the new screens need from a person** (2026-10-04):
   - **Two addresses.** The Buy Me a Coffee page (`SUPPORT_URL` in `src/main/support.ts`) and the repository (`SOURCE_URL`, same file). Until each is there, its links are not shown anywhere. With the first comes the note on About: say what it should say, and under which name (`MAKER_NAME` in `src/shared/product.ts` is "Ravinder" for now).
   - **The first run on a Mac, or an account, that has never run the app:** the real prompts for the microphone and Accessibility, the microphone check with a voice, the three exercises with a real key. Or, on this Mac: Settings › Advanced › Setup guide › Show Again.
   - **`Control`+`Option` as the dictation key** (Settings › Shortcuts), and **Pause Dictation for 1 Hour** in the menu: both with real keys. Neither has been pressed by a hand.
   - **Move the window by its top edge**, and click what is at the top of each page in a small window. The second is tested; the first cannot be without a pointer.
   - **The menu-bar icon** in its five shapes in the real menu bar, light and dark, and the menu itself.
   - **VoiceOver** on the pill's messages, the History list and an opened dictation's marks.
   - **Keep the history on disk once** (History › Keep), look at the dialog, and at Privacy afterwards.
   - **A decision that was taken for you and can be taken back:** the dictionary that `settings.json` can hold still works, although the Dictionary page is not built. Say if it should go too.

Also open (optional): authenticate `context7` through `/mcp`, which gives the assistant current library documentation.
