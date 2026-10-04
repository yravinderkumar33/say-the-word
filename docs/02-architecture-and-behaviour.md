# Architecture and behaviour

Part of the plan set: [01 Research and decisions](01-research-and-decisions.md) · 02 Architecture and behaviour · [03 Implementation phases](03-implementation-phases.md) · [04 Implementation reference](04-implementation-reference.md)

## Architecture

```
          ┌──────────────────────── Electron app (TypeScript) ────────────────────────┐
 keys ──► │ flow-helper (Swift) ──JSON lines──► main process                          │
          │  event tap · paste · AX reads        session state machine · pipeline     │
          │                                        │                       │          │
 mic ───► │ overlay renderer ────MessagePort────► speech worker         Ollama client ─┼─► 127.0.0.1:11434
          │  the pill + mic capture               (utility process:                    │
          │ hub renderer (React)                   voice detection + Parakeet)         │
          │  onboarding · history · settings                                           │
          └────────────────────────────────────────────────────────────────────────────┘
```

| Process | Language | Owns |
|---|---|---|
| Main | TypeScript | Lifecycle, tray, windows, session state machine, pipeline, settings (JSON), recovery buffer, Ollama client |
| `flow-helper` | Swift | Active key event tap, destination capture, paste transaction, accessibility reads, permission checks |
| Speech worker | TypeScript + native addon | Voice detection, chunking, Parakeet decoding. Crash-isolated in an Electron `utilityProcess` and respawned on exit. |
| Overlay renderer | TypeScript/React | The pill, microphone capture (AudioWorklet, 16 kHz mono), sounds |
| Hub renderer | TypeScript/React | Onboarding, history, dictionary, snippets, style, settings (Phase 6) |
| Ollama (the user's own install) | n/a | Cleanup LLM over HTTP on loopback, local models only |

### One dictation, end to end

Every dictation is a session with its own id (see [Session rules](#session-rules)).

1. **`Fn` down.** The helper reports the shortcut. Main creates the session, the overlay requests the microphone, and the pill shows *Starting microphone*. In Cleaned mode, main also pre-warms the Ollama model.
2. **Microphone live.** When audio starts to flow, the start sound plays and the pill switches to *Listening*. Audio frames flow from the overlay straight to the speech worker. Speech is grouped into pieces of up to 30 s that end at a pause, and each piece is decoded as soon as it closes, while the recording continues.
3. **`Fn` up.** Two things happen at the same moment: the overlay stops the microphone (after a 150 ms tail, because people let go a little early), and the helper records the paste destination: app, window, focused element, and whether it is a password field. The worker decodes what is left and returns the transcript.
4. **Text.** Verbatim mode uses the transcript as is. Cleaned mode applies conservative rules, then Ollama cleanup under a fixed time ceiling, then an output guard; any failure falls back to the rules-only text. The raw transcript is always kept.
5. **Paste.** Main confirms the session is still current and not cancelled. The helper re-reads the destination. If it is unchanged and not a password field, the helper pastes: save clipboard, set text, `Cmd+V`, restore the clipboard 0.5 s later unless something new was copied. Otherwise nothing is pasted, the clipboard is left alone, and the pill offers Copy.
6. **Recovery buffer.** The session's raw and final text go into an in-memory buffer, so paste-last and copy-last work whatever happened in step 5.

### Session rules

The state machine below covers gestures. These rules cover everything asynchronous around them.

- **Identity.** Each session gets an id at `Fn` down. Audio frames, worker results, Ollama results and paste requests all carry it. A result whose id is not the current session's, or that arrives when the session is not waiting for it, is dropped.
- **One session at a time.** Pressing the shortcut while a session is processing is ignored, and the pill shows a "still processing" cue. Queuing a second recording is later work.
- **Cancel is terminal.** It releases the microphone (including a microphone request that only resolves after the cancel), tells the worker to drop the session, aborts the Ollama request, and blocks the paste. The cancel is recorded in the recovery buffer.
- **A cancel can be taken back for a few seconds.** After `Esc`, the Cancel button or a triple tap, the pill says "Cancelled" and offers Undo for six seconds. The overlay holds the recording for exactly that long: when the message goes, or the next dictation starts, it is dropped. Undo transcribes it and pastes the text where the cursor is then. A cancel that leaves no message (a quick tap, another key during the hold) holds nothing.
- **An interruption is not a cancel.** When something outside the user's control ends a session (the helper is lost, the key tap loses track of the keyboard, the Mac sleeps or locks), nothing is pasted, but the recording is still stopped and transcribed, and the text goes to the recovery buffer. The pill offers Copy, and paste-last works.
- **Point of no return.** Once the paste command has been sent to the helper, the session is finished and cancel no longer applies.
- **Destination is fixed at release.** A session may paste only into the destination recorded when recording stopped. This is stricter than pasting into whatever is focused, because several seconds of local processing leave room to switch apps.

| Event | Behaviour |
|---|---|
| Microphone permission missing, or the microphone fails to open | The session ends before Listening, with no start sound. Recovery explains why. |
| Microphone is slow to open (Bluetooth) | The pill stays on Starting until audio flows, so it is visible that speech is not yet being captured. |
| The microphone chosen in the tray is not connected | The system default microphone is used instead. |
| Microphone disconnects mid-recording | Capture stops. What was captured is transcribed and handled as a normal stop, with a notice. |
| No speech detected | Nothing is pasted; brief notice. |
| Recording reaches the length limit | Treated as a stop, with a notice. The limit is 20 minutes, with a warning sound a minute before. |
| Speech worker crashes | The worker respawns and the overlay sends the session's audio again, once; the dictation then completes as usual, about a second later. A second failure ends the session with a message and a Retry button. After three crashes in a row the worker is left alone until the next dictation. |
| The decode fails or takes too long | The session ends with a message and a Retry button, which works for as long as the message is shown. |
| The speech model is not loaded | Normal after ten minutes without dictation: the model is unloaded to free about 1.9 GB of memory. The next dictation records at once and loads the model meanwhile, which takes about a second. |
| Helper exits | Shortcuts are unavailable until it restarts (automatic, with backoff). An active session is interrupted: its text is kept in Recovery, never pasted. |
| Sleep, screen lock or user switch during a session | The session is interrupted: its text is kept in Recovery, never pasted. On wake, key state is reconciled so no key is stuck down. |
| Ollama not running, too slow, or its output fails the guard | The rules-only text is pasted and the reason is recorded. |
| Destination changed, or a password field is focused | No paste. Recovery offers Copy, and paste-last works. |
| The user copies something during the paste window | The user's newer clipboard is kept; nothing is restored over it. |

### Privacy rules

- **Typing stays private.** The helper reports only shortcut events. It never forwards ordinary typing to the app.
- **Inference stays local.** Ollama is reached on loopback by default, and any model that Ollama would run on a remote host is refused. Details are in [04 Implementation reference](04-implementation-reference.md), section F.
- **Network use is limited** to loopback Ollama, model downloads the user starts, and update checks the user starts. Automatic update checks are off unless switched on. No telemetry.
- **Nothing sensitive is written without a decision.** Transcript text is never logged. Transcripts and audio live only in memory until the history behaviour below is confirmed. The one exception is evaluation recordings, which the user switches on.

## Behaviour to clone

Verified against the installed Wispr Flow's configuration and the official docs.

| Action | macOS default |
|---|---|
| Push-to-talk | hold `Fn` |
| Hands-free | `Fn`+`Space` to start and again to stop; or double-tap `Fn` within 0.5 s; or click the pill |
| Command Mode | hold `Fn`+`Ctrl` (experimental, off by default, as in Wispr Flow) |
| Cancel | `Esc`, swallowed during dictation so it does not reach the app |
| Paste / copy last transcript | `Cmd`+`Ctrl`+`V` / `Cmd`+`Ctrl`+`C` |
| Macs without an Apple `Fn` key | `Ctrl`+`Opt` set, as Wispr Flow does |

### Session state machine

Pure TypeScript, unit-tested with a fake clock.

| State | Event | Result |
|---|---|---|
| idle | `Fn` down | start capture → holding |
| idle | pill click, or hands-free shortcut | start capture → locked |
| holding | `Fn` up after ≥ 0.3 s | stop → processing |
| holding | `Fn` up sooner | tap pending: keep capturing until 0.5 s after start |
| holding | `Space` while `Fn` held | lock sound → locked |
| holding | another key (for example `Fn`+arrow) | silent cancel → idle |
| tap pending | `Fn` down again within 0.5 s | lock sound → locked (double-tap) |
| tap pending | 0.5 s elapses | silent cancel → idle |
| locked | `Fn` press or hands-free shortcut | within 0.5 s of locking: cancel; otherwise stop → processing |
| locked | stop button | stop → processing |
| locked | another key, or the release of the key that locked it | nothing: typing while dictating hands-free is fine |
| any recording | 19 min / 20 min | warning sound / stop → processing, with a notice |
| holding, locked, processing | `Esc` or cancel button | cancel → Recovery → idle |
| processing | `Fn` down | ignored; the pill shows a "still processing" cue |
| processing | paste-last shortcut | cancel processing and paste the previous transcript |

- The 0.5 s windows are documented by Wispr Flow. The 0.3 s tap threshold is a starting value (Wispr Flow does not publish its own) and is a tunable constant.
- Every row is implemented (`src/main/hotkeys/session-machine.ts`). A locked recording is ended by the next press of the key, not by its release, so stopping feels immediate.
- A lone tap costs half a second of open microphone: the recording runs until the double-tap window closes, and is then dropped without a trace.

### The pill

- **Look and position:** small dark capsule, bottom-centre above the Dock, on all Spaces and over fullscreen apps. It follows the display the cursor is on.
- **Focus:** it never takes focus, and it is click-through outside its controls.

| State | Shows | Means |
|---|---|---|
| Resting | Small capsule | Idle |
| Starting microphone | Expanded, bars flat, no sound yet | The microphone has been requested but no audio is flowing; speech is not being captured |
| Listening | Bars moving with the real audio level, after the start sound | Capture is live |
| Listening, hands-free | The same, wider, with Stop and Cancel buttons; a double note when it locks | Capture is live and no key is held |
| Processing | Moving dots and a cancel button | Decoding and cleanup |
| Recovery | A short message with at most one offer: Copy when the session left text behind, Undo after a cancel, Retry after a failed decode. It goes away after six seconds, or when dismissed. | Something did not end in a paste: cancelled, interrupted, destination changed, password field, failure |

- The bars are driven by captured audio, so a moving indicator always means capture is working.
- **Sounds:** a rising pair of notes when audio starts to flow (speak now), a falling pair when recording stops, a low pair when a dictation did not end in a paste, and a single low note when the shortcut is pressed during processing. They are generated in code; no sound files ship. Things the user did on purpose (cancel, copy) are silent.
- **Messages** are listed in `src/main/dictation/pill-messages.ts`, for example "Focus moved, so nothing was pasted" and "Password field: nothing was pasted".
- **The log has the rest.** A message has room for a few words. Which check refused a paste, which app the text was meant for and how loud the recording was go to the log file (menu-bar icon → Show Log), which never holds what was said.

A click on the resting pill starts a hands-free recording.

Later (Phase 5): hover hint that names the configured shortcut, right-click menu at rest (hide for 1 hour, microphone, paste last transcript).

### Text handling

The first milestones ship two modes. Wispr Flow's four cleanup strengths and four tones come later, once their exact edits are written down and evaluated.

| | Verbatim | Cleaned |
|---|---|---|
| What you get | The recognizer's text, untouched | The same words, tidied |
| Uses Ollama | No | Yes, with a rules-only fallback |
| Wispr Flow equivalent | None | Light |
| Arrives in | Milestone 1 | Milestone 2 |

Example (illustrative, not measured output):

- **Spoken:** "um so let's meet thursday no wait friday at 3 pm and uh bring the the q3 report"
- **Verbatim:** "Um, so let's meet Thursday, no wait, Friday at 3 PM and uh bring the the Q3 report."
- **Cleaned:** "So let's meet Friday at 3 PM and bring the Q3 report."

Allowed edits, which the guard and its tests are written against:

| Edit | Verbatim | Cleaned |
|---|---|---|
| Dictionary replacements (once the dictionary exists) | yes | yes |
| Remove hesitation sounds (um, uh, er) and stutters | no | yes |
| Fix punctuation and capitalization | no | yes |
| Apply a self-correction, keeping only the corrected version | no | yes |
| Spoken commands ("new line", "new paragraph") | no | yes |
| Fix an obviously mis-recognized word | no | yes, tightly limited |
| Change numbers, names, emails, URLs or negations | never | never, except inside a retracted phrase |
| Reorder, rephrase, summarize, translate or add content | never | never |

The raw transcript is kept for every session, so "use the raw transcript" is always available when cleanup or a rule got something wrong.

**Deferred until defined and evaluated**

- **Medium and High levels** (Wispr Flow parity): their allowed edits are not specified yet.
- **Styles:** four categories (personal, work, email, other), each set to formal / casual / very casual / excited. Proposed exact edits, not yet evaluated:
  - Formal: no change.
  - Casual: drop the final period.
  - Very casual: casual, plus lowercase sentence starts.
  - Excited: the final period becomes "!".
- **Lists** and the full spoken-punctuation set.
- **Snippets:** a spoken trigger phrase expands to saved text (Phase 6).

### History and recovery

- **First milestones: memory only.** The recovery buffer holds the last 20 sessions: raw transcript, final text and outcome. It is cleared on quit. The overlay holds a session's audio until its text has arrived, so that a crashed speech worker can be given it again. After a cancel or a failed decode it holds it for as long as the Undo or Retry offer is shown, and no longer.
- **What it provides:** paste-last (`Cmd`+`Ctrl`+`V`), copy-last (`Cmd`+`Ctrl`+`C`), the Copy, Undo and Retry actions on the Recovery pill, and the raw transcript.
- **A paste that looked successful is still recoverable.** The app cannot prove text appeared in the editor, so every session goes into the buffer regardless of the paste outcome.
- **Persistent history arrives with the Hub (Phase 6).** Before it ships, these are confirmed: what is stored (text, audio, app name), where, the default retention period, audio retention, a delete-all control and a pause switch. Proposed defaults: text kept until deleted, with a retention setting; audio kept only for failed or cancelled sessions, for 14 days.
- **Evaluation recordings are separate and opt-in.** When "Save every dictation" is switched on in the tray menu, each dictation's recording and the text the recognizer heard are saved for the Phase 3 comparison. The folder is `~/Library/Application Support/Whisper Flow/evaluation`, outside the repository, so a recording of someone's voice cannot be committed by accident. This is the one place where the app writes what was said to disk, and it is off unless chosen.

## Repo layout

As built up to Phase 2; later phases add the entries marked with their phase.

```
whisper-flow/
├─ package.json · electron.vite.config.ts · electron-builder{,.dev}.yml · tsconfig.{node,preload,web,worklet}.json
├─ native/flow-helper/                      SwiftPM package, the only non-TypeScript code
│   ├─ Sources/FlowHelperCore/              pure logic, unit-tested: protocol, shortcut matcher, dispatcher, password-field rule,
│   │                                       modifier state, the rule for when the helper may post keys
│   └─ Sources/FlowHelper/                  main · EventTap · Target · PasteTransaction · KeyLayout · SecureInput · SystemActions · TestTools
├─ src/shared/                              helper-protocol · stt-protocol · ipc · ipc-channels · bridge · keycodes · audio-format ·
│                                           wav · wer · jsonl · test-switches (which builds may act on the test switches)
├─ src/main/
│   ├─ index.ts                             lifecycle, single instance, wiring, test switches, --smoke
│   ├─ smoke.ts · debug-control.ts          self-check; control line for the automated tests
│   ├─ log-file.ts                          the log on disk: what happened to each dictation, never what was said
│   ├─ test-switch-policy.ts                a release build drops the test switches before anything reads them
│   ├─ app-url.ts · app-protocol.ts · security.ts   the app:// pages, and who may talk to main
│   ├─ native/helper-bridge.ts              spawn, JSON-lines RPC, restart with backoff, replacement on a late permission grant
│   ├─ hotkeys/                             session-machine (the state machine above) · route-helper-event (and its log lines)
│   ├─ dictation/
│   │   ├─ session-controller.ts            session ids, cancel and interruption rules, point of no return
│   │   ├─ speech-service.ts                microphone commands, worker lifecycle, model load and unload, recording limit
│   │   ├─ wire-dictation.ts                connects helper, speech, pill, power events
│   │   ├─ pill-presenter.ts · pill-messages.ts   what the pill shows and says
│   │   ├─ recovery-buffer.ts               last 20 sessions, in memory
│   │   └─ session-metrics.ts               per-session timings and loudness, for the latency gates and the log
│   ├─ stt/                                 stt-host · stt-worker · transcriber · chunk-planner · vad · sample-buffer ·
│   │                                       model-catalog · model-store · models-dir · engines/sherpa-parakeet
│   ├─ cleanup/                             Cleaned mode: rules · ollama-client · local-only · prompts · guard · refiner
│   ├─ text/words.ts                        what a word, a hesitation, a correction and a protected token are; snippets and style later
│   ├─ windows/                             overlay-window · hub-window · tray · load-renderer
│   └─ store/settings.ts                    settings as one JSON file; database in Phase 6
├─ src/preload/{overlay,hub}.ts
├─ src/renderer/overlay/                    Pill.tsx · pill-store · sounds · capture/{mic-capture,pcm.worklet,load-worklet}
├─ src/renderer/hub/                        the setup window; the full Hub in Phase 6
├─ scripts/                                 build-helper · check-build · check-pack · setup-signing · download-model ·
│                                           make-fixtures · bench-stt · pipeline-cli · eval-stt · eval-cleanup ·
│                                           test-helper · test-app · test-e2e · check-not-running · pack
├─ tests/{unit,renderer,fixtures}/          fixtures/audio/ and fixtures/personal/ are git-ignored
└─ docs/                                    this plan set, tracker, progress log, benchmarks
```

Nothing is borrowed for the interface: the sounds are generated in code and the menu-bar icon is drawn in code.
