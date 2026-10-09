# Implementation phases

Part of the plan set: [01 Research and decisions](01-research-and-decisions.md) · [02 Architecture and behaviour](02-architecture-and-behaviour.md) · 03 Implementation phases · [04 Implementation reference](04-implementation-reference.md)

**Status:** see [tracker.md](tracker.md) for the current phase and [progress.md](progress.md) for the evidence. Phases 0 to 2 were built and verified automatically on 2026-10-03; what still needs a person is listed in the tracker.

The work is grouped into two milestones and a set of later phases. Three things decide whether the app is worth using every day, and the milestones are built around them: accurate text, predictable latency, and text that only ever lands where it was meant to.

- **Milestone 1: dependable Verbatim dictation.** Hold `Fn`, speak, release; the recognizer's text is pasted into the place you were when you released. No LLM yet.
- **Milestone 2: Cleaned mode, chosen on your own voice.** Optional Ollama cleanup, with the engine and the defaults decided on recordings of your own speech.
- **Later phases** add Wispr Flow parity (hands-free, the Hub, Command Mode, long recordings, more styles) in the order real use asks for.

## Milestone 1: dependable Verbatim dictation

| # | Delivers | Verified automatically | Needs a person |
|---|---|---|---|
| 0 | **Skeleton and signed app.** Delete the stray `.playwright-mcp/` folder, `git init`, MIT licence, project scaffold, helper stub, `npm run pack` producing a signed `.app`, `--smoke` self-check | Typecheck, lint, unit tests; build assertions (two HTML entries, worklet contains `registerProcessor(`, worker chunk exists); smoke: worker fork and MessagePort echo, worklet loads, helper answers; `codesign --verify --deep --strict` | Nothing |
| 1 | **Helper, hotkeys, destination-aware paste.** Event tap with stateful swallowing, shortcut matcher, session state machine (push-to-talk, quick-tap cancel, `Esc`), destination capture at release and recheck before paste, password-field refusal, in-memory recovery buffer, paste-last and copy-last, Globe-key spike. The packaged app pastes a fixed string on `Fn` release. | `swift test` (matcher, protocol); state-machine and session-rule tests under a fake clock, including cancel races and stale results; after the one-time grant: a synthetic `Fn` event through the real tap, a paste into a scratch TextEdit document read back through accessibility, a paste refused after another app is activated, clipboard restored | Grant Accessibility once; hold and tap physical `Fn`; confirm no emoji picker, `Fn`+arrows still work, the grant survives a rebuild; check the destination rule does not block correct pastes in Slack, Chrome, VS Code and Terminal |
| 2 | **First real dictation, Verbatim.** Model download with resume and checksum, Parakeet worker with chunked decoding at pauses, 2-minute recording limit, mic capture, session ids across processes, the failure handling in the session rules, pill states (Starting, Listening, Processing, Recovery), sounds, tray with microphone selection, bare setup window (permissions, model download) | `npm run test:app`: whole dictations in the running app, with a WAV in place of the microphone and a debug control in place of the key; it scores what would be pasted and never takes focus. Injected faults: cancel at every stage, worker killed mid-recording and mid-decode, microphone opening after a cancel, microphone lost, a stale result from an old session, interruption, the recording limit, the model unloaded or missing. `npm run test:e2e`: the real key tap and the real paste into TextEdit, including a paste refused because focus moved. Latency metrics recorded. Speech synthesized with `say` is used for plumbing only. | Grant Accessibility and Microphone to the packaged app; dictate with your own voice in everyday apps; the two checklist items that need hardware (unplugging a microphone, closing the lid) |

**Exit criteria:** the latency gates pass or have a recorded decision, and the dependability checklist shows zero wrong-destination pastes and zero pastes from cancelled sessions.

## Milestone 2: Cleaned mode, chosen on your own voice

| # | Delivers | Verified automatically | Needs a person |
|---|---|---|---|
| 3 | **Personal evaluation set and engine check.** Opt-in recording mode in the app; 30–50 real dictations with the intended text written beside each; `eval:stt` scoring the recognizer on that set, and comparing against `transcribe-cpp` Whisper if Parakeet falls short | Scoring script: word error rate against the intended text, and the share of words and punctuation marks that would need fixing by hand, overall and per tag (names, technical vocabulary, numbers, corrections). `test:app` checks that the mode saves nothing unless it is on, and that the script scores what the app saved | Record the set and write the intended text (about 30–45 minutes); confirm the engine |
| 4 | **Cleaned mode.** Conservative rules, dictionary replacements from the settings file, Ollama client with local-only enforcement, refiner with the fixed ceiling, guard, pre-warm, handling for Ollama missing or stopped, mode switch in the tray, `eval:cleanup` | Ollama client against a mock streaming server (split lines, thinking chunks, mid-stream error, abort, refused); guard tests including the required cases in the reference; cloud-model refusal against mocked `/api/tags` and `/api/show`; live-Ollama integration tests (skipped when absent); eval table on the personal set | Read the before/after diffs and mark meaning changes; choose the default mode and model; rerun the dependability checklist with Ollama stopped and slowed |

**What the personal set should contain:** real messages of the kind you actually dictate, names of people and products, technical vocabulary, numbers, dates and times, and sentences where you correct yourself. A mix of short and long.

**How to record it**

1. In the tray menu, choose Evaluation → "Save every dictation (recording and text)".
2. Dictate as you normally would, 30 to 50 times. Nothing else changes.
3. Choose Evaluation → "Show saved dictations". Each dictation has three files: the recording (`.wav`), what the recognizer heard (`.txt`), and a second copy of that text that is never edited (`.heard.txt`).
4. Correct each `.txt` until it says what you meant. Pressing Space on a `.wav` in Finder plays it. A first line of tags is optional, and shows where the errors are: `#names`, `#technical`, `#corrections`. Dictations with a number in them are tagged `#numbers` automatically.
5. Delete the files of any dictation you do not want in the set, then switch the mode off.
6. Run `npm run eval:stt`.

**How the cleanup decision is made.** For each recording, compare three outputs against the intended text: raw recognizer text, rules-only text, and LLM-cleaned text. Track:

- corrections still needed to reach the intended text;
- meaning changes, marked while reading the diffs;
- how often cleanup fell back to rules-only;
- release-to-text latency.

Cleaned becomes the default only if it clearly reduces corrections, its meaning changes are zero or rare enough to accept, and the latency is acceptable. Otherwise Verbatim stays the default and Cleaned is opt-in. A lower word error rate alone does not settle it.

## Later phases

Ordered by what real use asks for; the order can change after Milestone 2.

| # | Delivers | Verified automatically | Needs a person |
|---|---|---|---|
| 5 | **Interaction parity.** Hands-free (all three ways in), third-tap cancel, recordings up to 20 minutes with decoding during the recording, Undo for a cancelled session, retry, failed-paste detection via pasteboard read receipt, pill hover hint and right-click menu, display following, Secure Input notice, no-`Fn` fallback | State-machine tests per documented rule; end-to-end hands-free with debug triggers and a multi-minute fixture | Short manual checklist for each gesture |
| 6 | **Hub and persistent history.** Onboarding (permissions, Ollama check and model pull, speech model download, mic test, shortcut practice), history by date (after the history behaviour is confirmed), dictionary and snippets, settings (shortcut recorder, microphone ranking, launch at login, pill and Dock visibility, sounds, retention). Medium and High levels and styles, once their edits are defined and evaluated. | Settings-schema and IPC contract tests, component tests, migration tests, settings survive restart | Onboarding on a fresh macOS user account; visual pass |
| 7 | **Context awareness and Command Mode.** Read app, selection and text around the cursor; smart leading space and capitalization; app category picks the style; `Fn`+`Ctrl` transforms the selection by voice; "press enter" voice command | Unit tests for spacing and category mapping; scripted accessibility reads against TextEdit | Try Command Mode in a native app, a browser and VS Code |
| 8 | **Release.** Licence audit of the shipped binaries, Say the Word branding, README and attributions, Developer ID signing and notarization, DMG, update checks consistent with the network policy, CI | `codesign --verify`, `spctl -a -vv`, `stapler validate`, packaged smoke | An Apple Developer ID certificate (only an Apple Development identity exists today); clean-machine install |

## Go/no-go gates

Recorded in `docs/benchmarks.md` before anything is built on them. Latency targets are starting values.

| Check | Phase | Pass | If it fails |
|---|---|---|---|
| Dropping `Fn` events in the tap suppresses the emoji picker, input switch and Apple Dictation | 1 | no system action on tap or double-tap | fall back to the `TISUpdateFnUsageType` approach OpenWhispr uses, then to a setup step that sets the Globe key to "Do Nothing" |
| Destination rule in everyday apps | 1 | correct pastes are not blocked in Slack, Chrome, VS Code, Terminal | compare app and window only for apps whose focused element is unstable |
| Speech addon loads in the signed, hardened utility process | 2 | loads and reports 1.13.8 | run sherpa-onnx as a sidecar process, or switch the engine to `transcribe-cpp` |
| Warm decode of 10 s of audio | 2 | ≤ 0.5 s | tune the thread count, then try `transcribe-cpp` on Metal |
| Single-decode length | 2 | 30 s decodes within the memory budget (≤ 2.5 GB peak) | cap chunks at 15 s, which is what hive and OpenWhispr use |
| **Key-down to microphone live** (`Fn` down → first audio frame), built-in microphone | 2 | median ≤ 200 ms, 95th percentile ≤ 400 ms; Bluetooth reported separately | keep the stream warm briefly between dictations (opt-in), prefer the built-in microphone |
| **Release to text appearing** (`Fn` up → paste sent), Verbatim, 10 s utterance | 2 | 95th percentile ≤ 1.0 s | decode chunks during the recording, tune threads, switch engine |
| Recognizer accuracy on the personal set | 3 | few enough corrections that Verbatim is usable daily (the user's judgement, with numbers recorded) | switch the default engine to Whisper via `transcribe-cpp` |
| **Release to text appearing**, Cleaned | 4 | never more than tail decode plus the cleanup ceiling (4 s to start); median, 95th percentile and fallback rate recorded | rules-only by default, a smaller or faster model, or a lower ceiling |
| Cleanup on the personal set | 4 | meets the decision rule above | Verbatim stays the default; Cleaned is opt-in |

## Dependability checklist

Run before calling a milestone dependable. Each scenario is run at least 10 times, automated wherever the debug control can drive it.

| # | Scenario | Automated by |
|---|---|---|
| 1 | Switch to another app, window or field during processing: nothing is pasted, and Recovery offers Copy | `test:e2e` (the app, real paste); `test:helper:integration` (the helper's refusal) |
| 2 | Cancel during Starting, Listening and Processing: nothing is pasted, and the microphone is released each time | `test:app`, ×10 |
| 3 | Press the shortcut again during processing: it is ignored, and the first session completes untouched | `test:app`, ×10 |
| 4 | Start a new recording immediately after a paste: the second session's text is its own | `test:app`, ×10 |
| 5 | Unplug or disable the microphone mid-recording | `test:app`, ×10, by ending the capture the way a lost microphone does; a real unplug needs a person |
| 6 | Kill the speech worker mid-recording and mid-decode | `test:app`, ×10 |
| 7 | Copy something during the paste window: the newer clipboard survives | `test:helper:integration` |
| 8 | Focus a password field at release: nothing is pasted | `test:helper:integration` (native field and Chromium field); unit tests for the app's rule |
| 9 | Sleep or lock mid-recording: nothing is pasted, and no key is stuck on wake | `test:app`, ×10, by sending the event that sleep and lock send; a real sleep needs a person |
| 10 | Milestone 2: stop Ollama, slow it down, and make it return garbage: the rules-only text arrives within the ceiling | Phase 4 |
| 11 | Milestone 2: select a cloud-backed Ollama model: it is refused before any transcript is sent | Phase 4 |

**Pass bar:** zero pastes into the wrong destination and zero pastes from cancelled sessions, across every run.

## Verification commands

| Command | What it checks |
|---|---|
| `npm test` | Unit tests: fake-clock state machine, session rules, microphone capture, chunking, model download; later the guard, rules and Ollama client against a mock server |
| `swift test --package-path native/flow-helper` | Shortcut matcher and protocol |
| `npm run test:app` | Launches the app with a WAV in place of the microphone, drives it through the debug control, injects faults, and scores what would be pasted. Takes no focus and touches no keys. `-- --repeat 10` is the dependability run; `-- --latency 20` and `-- --real-mic 20` measure the latency gates |
| `npm run test:e2e` | The real key tap and the real paste into TextEdit, with synthetic `Fn` presses. Takes focus for about 40 s |
| `npm run test:helper:integration` | The helper alone against the real OS: tap, paste, clipboard, refusals. Takes focus for about 10 s |
| `npm run bench:stt` | Decode speed and memory on this machine |
| `npm run eval:stt` | Recognizer accuracy on the personal set: reads the dictations evaluation mode saved, runs each recording through the same path the app uses, and scores it against the text beside it. `-- --quiet` prints numbers only |
| `npm run eval:cleanup` | As heard, rules only and final text against what was meant, on the personal set, with timing and how often the model's text was used. `-- --samples` runs the written samples instead; it needs the local Ollama running |
| `npm run test:app -- --live-ollama 6` | Cleaned mode in the app with the real local model: what is pasted is what was said, inside the ceiling |
| `npm run pipeline -- <file>.wav` | Headless speech → rules → Ollama → guard, printing the text and per-stage timings |
| `npm run pack && open -n dist/mac-arm64/<App>.app` | The signed build, for anything that needs real permissions |

## Manual steps that need a person

- **Quit Wispr Flow while testing.** It launches at login on the development machine, and two apps tapping `Fn` will fight.
- **Grant Accessibility and Microphone** to the packaged dev build once (Phases 1 and 2). The build is signed with the Apple Development identity so the grants survive rebuilds.
- **Press and speak.** Automated tests cannot press physical keys or speak, so each phase ends with a short manual checklist. Everything else is covered through a debug control and a recording in place of the microphone.
- **Record the personal evaluation set** (Phase 3): 30–50 dictations plus the intended text for each, about 30–45 minutes.
- **Optional model pulls** for the cleanup eval: `gemma4:e4b-it-qat` is about 6 GB and `hf.co/SpeakoFlow/speakoflow-mini` about 0.8 GB. Confirm before downloading.

## Not in this plan

- **Wispr Flow features left out:** meeting notetaker, scratchpad/notes, Transforms/Polish, insights, accounts/teams/sync, mobile apps, mouse-button shortcuts, IDE file tagging, mute or pause media while dictating.
- **Other platforms:** Windows and Linux come after macOS behind the same interfaces. The Windows default is `Ctrl`+`Win`.
- **Later performance work:**
  - Start decoding and cleanup speculatively when the speaker pauses before releasing the key.
  - Clean long dictations chunk by chunk, so dictations longer than the cleanup ceiling allows can still be cleaned.
  - Let a new recording start while the previous one is still processing.
