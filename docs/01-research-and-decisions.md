# Research and decisions

Say the Word is an open-source, local-first clone of the dictation app Wispr Flow: hold a key, speak, and polished text lands in whatever app is focused. Everything runs on the user's machine, with Ollama as the LLM. Existing Wispr Flow users should be able to switch without relearning anything: same shortcuts, same hold and hands-free interaction, same on-screen pill.

**Status:** design drafted and revised after one review; implementation under way. Feasibility is unproven until the Phase 1–2 gates pass. Current state is in the [tracker](tracker.md).

| Document | Contents |
|---|---|
| 01 Research and decisions (this file) | What was decided and why, measurements, open decisions, risks |
| [02 Architecture and behaviour](02-architecture-and-behaviour.md) | Processes, data flow, the behaviour being cloned, repo layout |
| [03 Implementation phases](03-implementation-phases.md) | Phases, go/no-go gates, verification, manual steps |
| [04 Implementation reference](04-implementation-reference.md) | Version pins, build config, helper protocol, model files, Ollama contract, prompt and guard |
| [Tracker](tracker.md) | Task status per phase, gate outcomes, what is waiting on a person |
| [Progress log](progress.md) | Dated record of what was done, with evidence |

## Constraints

- **macOS first** (Apple Silicon, macOS 14+). Hotkeys, paste and speech-to-text sit behind interfaces so Windows and Linux can follow.
- **TypeScript for the app.** One Swift helper is accepted for what JavaScript cannot do.
- **Fully local.** Ollama provides the LLM, and any model Ollama would run on a remote host is refused. No cloud services.
- **What decides daily usefulness:** accurate text, predictable latency, and text that only ever lands where it was meant to. The first milestones are built around these three before any Wispr Flow parity work.

## Decision 1: Electron + TypeScript, plus one Swift helper

- **The real Wispr Flow is built exactly this way.** The installed copy inspected during planning (v1.6.1034) is an Electron app (`com.electron.wispr-flow`, `Electron Framework`, `app.asar`) with a separate signed Swift helper that owns the key event tap and accessibility work. It holds only the Accessibility and Microphone permissions.
- **No JavaScript API can see the Fn key.** Electron's `globalShortcut` has no key-up, no modifier-only shortcuts and no Fn; `uiohook-napi` maps Fn (keycode 63) to "undefined". Every Electron dictation app that supports Fn ships native code for it.
- **Tauri was rejected.** Fn hold detection, paste injection, the non-activating overlay and accessibility reads would all be Rust, which defeats the TypeScript goal. Electron costs more (roughly 200–300 MB installed, about 350 MB RAM) but keeps everything except the helper in TypeScript.
- Two MIT-licensed Electron apps (Amical, OpenWhispr) already solve the same native problems, so their patterns can be adapted with attribution.

## Decision 2: do not send raw audio to Ollama

The pipeline is **microphone → dedicated speech-to-text → optional Ollama cleanup → paste**.

- Ollama 0.35.0 does expose an undocumented `/v1/audio/transcriptions` route. Checked on the development machine: it answers HTTP 400 "not multipart", where a made-up route answers 404.
- It is not a sound foundation: it only works for Gemma 4 E2B/E4B, has open regressions and crash bugs upstream, is limited to 30-second clips, cannot stream, and is less accurate than dedicated recognizers on hard audio.
- Ollama's maintainers declined to add Whisper as a runner, so dedicated speech models will not arrive that way.
- The speech engine sits behind an interface, so "Ollama audio" can be added later as an experimental engine if upstream stabilizes it.

## Decision 3: models

| Stage | Choice | Why |
|---|---|---|
| Speech-to-text | **Parakeet TDT 0.6b v3 (int8)** through the `sherpa-onnx-node` npm package, with Silero voice-activity detection | Best accuracy among the fast models; runs on CPU, leaving the GPU to Ollama; outputs punctuation and capitalization; prebuilt binaries; a shipping Electron app (hive) already runs the same stack in a utility process. Covers 25 European languages. Confirmed, or replaced, on the user's own recordings in Phase 3. |
| Cleanup LLM (optional, "Cleaned" mode) | Ollama, starting with **`qwen3.5:4b`** | Already installed on the development machine. `gemma4:e4b` and a fine-tuned 0.8B cleanup model (`hf.co/SpeakoFlow/speakoflow-mini`) are optional candidates. |
| Later: other languages | A Metal-accelerated Whisper engine (`transcribe-cpp`) behind the same interface | Parakeet has no Hindi or other non-European languages |

The cleanup defaults are not chosen by synthetic benchmarks. Phase 4 compares raw, rules-only and LLM-cleaned text on 30–50 of the user's own recordings, and Cleaned becomes the default mode only if it clearly helps. Until then the app ships Verbatim. See [03 Implementation phases](03-implementation-phases.md).

## Measurements

Taken on the development machine: Apple M4, 16 GB, macOS 26.6, Ollama 0.35.0, temperature 0.

| Model | One sentence | 60-word paragraph | Result |
|---|---|---|---|
| `qwen3.5:4b`, thinking off | ~1.5 s (0.6 s to first token, 23 tokens/s) | ~4.5 s | Correct on most cases; one botched self-correction |
| `qwen3.5:4b`, thinking on (its default) | 9.75 s, empty output | not run | Unusable, so every request sends `think:false` |
| `qwen3:1.7b` | ~0.35 s | ~1.7 s | Unusable: dropped content |

- **Cold model load is 4.7 s**, so the model is pre-warmed on key-down.
- **Cached prompt tokens are not free.** With the same 1,650-token system prompt, prompt evaluation took 5.9 s on first use and about 1.95 s on each later call. The system prompt therefore stays under about 200 tokens.
- **LLM output speed is the bottleneck.** Wispr Flow's cloud target is 0.7 s. A realistic local figure on this machine is about 1.5–2.5 s for a sentence with LLM cleanup and under 1 s without. The design runs fast deterministic rules first, gives the LLM a fixed time ceiling that does not grow with the transcript, and falls back to the rules-only text when the LLM is late or wrong.
- **Not yet measured:** speech-to-text speed, the time from key-down to the microphone being live, and the time from release to text appearing. All three are go/no-go gates in [03 Implementation phases](03-implementation-phases.md).
- These numbers are single runs with ad hoc prompts, not a benchmark. The Phase 4 eval replaces them.

## Consequences worth knowing

1. **Helper size.** About 1,200 lines of Swift for Milestone 1 (event tap, shortcut matching, destination capture, paste, permissions) and about 1,900 at full parity (adding the read-receipt paste, reading text around the cursor, Globe-key fallback). These come from per-file estimates and are not measured. Earlier planning estimates of 300 and then 700 lines for the core were too low. It stays OS glue only; all product logic is TypeScript with tests.
2. **GPL-3.0 component (reported, not yet audited).** Planning research found `espeak-ng` inside the speech library's prebuilt binary, pulled in by a text-to-speech feature this app does not use. Upstream confirms the licence conflict and plans to remove it in sherpa-onnx 2.0 ([issue #3731](https://github.com/k2-fsa/sherpa-onnx/issues/3731)). Fine for development. Before any public release, the exact shipped binaries get a licence audit.
3. **Minimum macOS is 14.0**, because the speech addon is built for 14.

## Decisions before a public release

None of these block development.

1. **Name and branding.** The public product name is **Say the Word**, chosen by the owner on 2026-10-09. The repository remains `whisper-flow`; existing user-data paths, bundle IDs and environment switches retain their original values for compatibility. The visible product name is defined in `src/shared/product.ts`. All sounds and icons are original; nothing is copied from Wispr Flow.
2. **Licence audit of the shipped binaries.** List every binary the release contains (Electron, the speech addon and its libraries, ONNX Runtime, the helper), its licence, and what that licence obliges. For the GPL component the options are: upgrade to sherpa-onnx 2.0 once it drops `espeak-ng`, make `transcribe-cpp` the default engine, or accept and document the obligation.
3. **Licence.** MIT assumed, matching OpenWhispr, Amical and Handy.
4. **Update checks.** The network policy allows only traffic the user starts. The release therefore ships a manual "Check for updates", with automatic checks as an opt-in setting.

## Risks

- **Fn/Globe key behaviour on macOS 26** can only be settled by the Phase 1 spike. Two fallbacks are listed in the gates.
- **Local latency** will not match Wispr Flow's cloud. Model choice, the rules-first design and the fixed cleanup ceiling decide how it feels.
- **Parakeet on the user's accent and vocabulary** is unmeasured. The personal evaluation set in Phase 3 is the test; the Whisper engine is the fallback.
- **The cleanup guard is a heuristic.** It catches common small-model failures but cannot prove that meaning is preserved. The raw transcript is always kept for recovery.
- **The destination check may block correct pastes** in apps whose accessibility elements are unstable. Phase 1 measures this in everyday apps.
- **electron-vite 5** predates Electron 44, so build targets are set explicitly. One upgrade task is expected when version 6 leaves beta.
- **A shared Ollama server.** Another client using a different context size forces a model reload.
- **Secure Event Input** (password fields, some terminals) blocks `Fn`+`Space` and `Esc` but not the `Fn` hold. Wispr Flow has the same limitation.

## Revisions

**2026-10-03, after a design review.** The architecture is unchanged. The first milestone is narrower and the reliability rules are tighter:

- **Paste destination.** It is recorded at release and rechecked before pasting; password fields are refused from the first usable version.
- **Sessions.** Every session has an id, stale results are dropped, cancel is terminal, and failure cases are specified.
- **Cleanup guard.** Rewritten around a list of allowed edits, with required test cases. The earlier rules conflicted with self-correction and let a dropped "not" through.
- **Local inference.** Ollama models with remote-host metadata are refused.
- **Time limit.** Cleanup has a fixed ceiling in place of a deadline that grew with the transcript.
- **Order of work.** The first real dictation now comes before the cleanup system, and defaults are chosen on the user's own recordings.
- **Scope of the first milestones.** Two modes (Verbatim, Cleaned) in place of four levels and four styles, a memory-only recovery buffer in place of a history database, and clearer pill states.
- **Release.** A licence audit replaces the GPL shorthand, and update checks are reconciled with the network policy.

Wispr Flow parity (hands-free, the Hub, Command Mode, long recordings, more levels and styles) remains the destination; it moved after the two milestones.

## Key sources

Inspected or measured directly on the development machine: the installed Wispr Flow bundle and its shortcut configuration, the Ollama endpoint check, the Ollama model metadata fields, the cleanup latency numbers, and package versions on the npm registry.

Cited by the research:

- Wispr Flow shortcuts and hands-free behaviour: <https://docs.wisprflow.ai/articles/2612050838-supported-unsupported-keyboard-hotkey-shortcuts>, <https://docs.wisprflow.ai/articles/6391241694-use-flow-hands-free>
- Ollama API reference (no audio field): <https://github.com/ollama/ollama/blob/main/docs/api.md>
- Ollama audio regressions and crashes: <https://github.com/ollama/ollama/issues/16584>, <https://github.com/ollama/ollama/issues/15333>
- Ollama declining a Whisper runner: <https://github.com/ollama/ollama/pull/13475>
- Ollama remote-model fields (`remote_host`, `remote_model`): <https://github.com/ollama/ollama/blob/v0.35.0/api/types.go>
- sherpa-onnx removing `espeak-ng`: <https://github.com/k2-fsa/sherpa-onnx/issues/3731>
- Pasteboard data-provider callback (a request for data, not proof of insertion): <https://developer.apple.com/documentation/appkit/nspasteboarditemdataprovider>
- Gemma audio limits (30 s clips): <https://ai.google.dev/gemma/docs/capabilities/audio>
- Parakeet TDT 0.6b v3 model card: <https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3>
- sherpa-onnx: <https://github.com/k2-fsa/sherpa-onnx>
- Electron `globalShortcut` limits: <https://www.electronjs.org/docs/latest/api/global-shortcut>
- Reference apps: <https://github.com/amicalhq/amical>, <https://github.com/OpenWhispr/openwhispr>, <https://github.com/cjpais/Handy>, <https://github.com/morapelker/hive>
