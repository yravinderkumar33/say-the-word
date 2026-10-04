# Pipeline QA reproductions

These probes preserve the 2026-10-04 audit evidence. They do not fix or modify production code. Run commands from the repository root with dependencies installed.

## Model selection and local-only cleanup

```sh
TSX_TSCONFIG_PATH=tsconfig.node.json node --import tsx docs/qa-audit-evidence/pipeline-probes.mts
```

The script asserts the current defective behavior and exits **0** when all three defects are reproduced. After a fix, its assertions will need to change. Expected output has three lines beginning:

- `CONFIRMED model picker`
- `CONFIRMED warm privacy`
- `CONFIRMED redirect privacy`

The first two probes use an in-memory HTTP substitute. The third binds two temporary servers to ephemeral `127.0.0.1` ports and checks that a 307 redirect forwards a synthetic chat POST body to the second origin. It requires loopback listen/connect permission and closes both servers afterward. It does not contact an external server or transmit any user data. The remote host mentioned in the warm-up response is inert mock metadata.

**Model-picker scope correction:** `capabilities` is optional in the current upstream `ListModelResponse`. This probe tests an Ollama server that omits it from `/api/tags` while returning `completion` from `/api/show`. This is a compatibility defect for servers that omit the optional field, not a claim that all current Ollama servers fail. `gate.check()` accepts the model, but `localTextModels()` returns no choices. See [upstream types](https://github.com/ollama/ollama/blob/main/api/types.go) and the [tags example](https://docs.ollama.com/api/tags).

The warm-up probe shows that a response containing `remote_host` is discarded by `warm()`, so the following refinement still sends its synthetic transcript before the model is blocked. The redirect probe demonstrates missing origin enforcement; it deliberately uses two local origins to avoid transmitting any data off this Mac.

## Undo after cancelling processing

Prerequisites are the same as `scripts/test-app.mjs`: built output, generated audio fixtures, and the downloaded speech model. Prepare these through the normal project commands if needed. The probe itself performs no download or build.

```sh
node docs/qa-audit-evidence/undo-processing-probe.mjs
```

For an existing development package:

```sh
node docs/qa-audit-evidence/undo-processing-probe.mjs --packaged
```

The wrapper reads the existing app-test harness, inserts one scenario into a temporary copy, fixes its project paths, and runs only that scenario. It leaves the repository harness unchanged and removes its temporary copy afterward. The inherited harness creates an isolated temporary profile and a loopback Ollama substitute, uses synthetic microphone audio, disables the key tap and focus-taking behavior, and counts mock pastes without touching the clipboard. It quits the app and cleans up afterward. Electron launch and loopback server access must be permitted.

The scenario holds processing with the existing `text-delay` debug hook, waits until speech recognition has released the recording, cancels, then clicks the offered Undo button. This makes the post-recognition window deterministic; Cleaned-mode refinement also creates such a window in normal operation.

On the audited code, expect **exit 1**, one failed scenario, and these count/state observations:

```text
AUDIT before Undo {"holdsRecording":false,"pill":"recovery","hasText":true}
AUDIT after Undo {"state":"idle","outcome":"failed","hasText":false,"pastesAdded":0}
```

The app reports `The recording is no longer held`. Besides failing to undo, the retry overwrites the usable recovery entry with an empty failed entry. No transcript text is printed. A fixed implementation should paste once or preserve recovery according to its revised Undo contract; the probe can then be converted into a permanent regression test.
