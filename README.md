# Whisper Flow (working title)

Local-first dictation for macOS: hold a key, speak, and the text lands where you were typing. Speech recognition and the optional cleanup model run on your machine; nothing is sent to a cloud service.

It is an open-source take on the Wispr Flow interaction model (same shortcuts, same hold-to-talk feel) built with Electron and TypeScript, one small Swift helper, a local speech recognizer, and Ollama for optional cleanup.

**Status:** early development. Dictation works end to end: hold `Fn`, speak, release, and the text is pasted where you were typing. Two modes, chosen in the menu-bar menu: Verbatim (the recognizer's text) and Cleaned (tidied by a local Ollama model, behind a guard that falls back to a rules-only text). Hands-free mode and the full settings window are not built yet. See [`docs/tracker.md`](docs/tracker.md) for what is done and what is next.

## Requirements

- macOS 14 or later on Apple Silicon
- Node 22.12 or later
- Xcode command-line tools (Swift 6)
- For signed local builds: an Apple Development certificate in your keychain

## Getting started

```sh
npm install
npm run models:download   # the speech model, about 670 MB, once
npm run dev               # builds the helper, then starts the app with hot reload
```

The app asks for two permissions, Accessibility and Microphone. In development macOS attributes both to the terminal that started the app. The setup window shows what is still missing.

The app tests also need the test recordings: `npm run fixtures` generates them with the macOS voices.

## Commands

| Command                           | What it does                                                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Start the app in development mode                                                                                                                               |
| `npm run check`                   | Type-check, lint, format check, unit tests, Swift tests                                                                                                         |
| `npm test`                        | Unit tests (Vitest)                                                                                                                                             |
| `npm run test:helper`             | Swift helper tests                                                                                                                                              |
| `npm run test:app`                | Whole dictations in the running app, with a recording in place of the microphone and injected faults. Touches neither the keyboard, the focus nor the clipboard |
| `npm run test:e2e`                | The real key tap and the real paste, with synthetic `Fn` presses into TextEdit, starting the way a first launch does. Takes keyboard focus for about 45 s       |
| `npm run test:helper:integration` | Helper against the real OS: event tap and paste. Takes keyboard focus for about 10 s                                                                            |
| `npm run build`                   | Build the helper and the app, then assert the build output                                                                                                      |
| `npm run smoke`                   | Build, start every part once and verify they can talk to each other                                                                                             |
| `npm run smoke:dev`               | The same check with pages served by the dev server                                                                                                              |
| `npm run models:download`         | Download and verify the speech model                                                                                                                            |
| `npm run fixtures`                | Generate the test recordings                                                                                                                                    |
| `npm run bench:stt`               | Recognizer speed and memory on this machine                                                                                                                     |
| `npm run eval:stt`                | Recognizer accuracy on your own saved dictations (tray → Evaluation)                                                                                            |
| `npm run eval:cleanup`            | Whether Cleaned mode helps: heard, rules-only and final text against what you meant                                                                             |
| `npm run setup:signing`           | Record your local signing identity (once per machine)                                                                                                           |
| `npm run pack`                    | Build a signed `.app`, verify it in a staging folder, then move it into `dist/`                                                                                 |

`npm run pack` produces `dist/mac-arm64/Whisper Flow Dev.app`. Launch it with `open -n` so macOS attributes permissions to the app rather than to your terminal.

## When a dictation does not arrive

The pill says why in a few words. The rest is in the log: menu-bar icon → **Show Log**, or `~/Library/Logs/Whisper Flow/main.log`. Each dictation leaves the shortcut events, the app the text was meant for, whether it was pasted and, if not, which check refused it, and how loud the recording was. It never contains what you said.

## Layout

| Path                 | Contents                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `src/main`           | Electron main process: lifecycle, windows, session rules, the helper bridge, the speech worker |
| `src/preload`        | Sandboxed preload scripts, one per window                                                      |
| `src/renderer`       | The overlay (pill and microphone capture) and the Hub window                                   |
| `src/shared`         | Types and constants shared by every process                                                    |
| `native/flow-helper` | The Swift helper: OS glue only (key events, paste, accessibility)                              |
| `scripts`            | Build, packaging and verification scripts                                                      |
| `tests`              | Unit tests (main and renderer) and fixtures                                                    |
| `docs`               | Design, plan, tracker and progress log                                                         |

## Documentation

Start with [`docs/01-research-and-decisions.md`](docs/01-research-and-decisions.md). It links to the architecture, the implementation phases and the technical reference.

## Licence

MIT. See [`LICENSE`](LICENSE). Third-party components and their licences are listed in the docs and will be audited before any binary release.
