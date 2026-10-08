# QA evidence — 5 October 2026

The authoritative findings, test results, and coverage limits are in [QA_REPORT_5_10_2026.md](../../QA_REPORT_5_10_2026.md). All fixtures in these probes are synthetic. No production code is patched.

## Reproduction scripts

- `storage-probes.ts`: actual settings/history modules with isolated temporary files; asserts four current defects. Run with `TSX_TSCONFIG_PATH=tsconfig.node.json node --import tsx docs/qa-2026-10-05/storage-probes.ts`.
- `pipeline-integrity-probes.ts`: actual cleanup guard/refiner with controlled model replies and clock; asserts numeric-symbol changes and persistent speed-estimate rejection. Same Node/tsx invocation.
- `ui-state-probes.mjs`: exact component/IPC-handler source evaluated under a small deterministic hook/IPC harness. This is not a React DOM or hardware test. Run with Node.
- `app-extra-probes.mjs`: inserts the six scenarios from `app-extra-scenarios.txt` into a temporary copy of the existing `scripts/test-app.mjs` harness. Runs the actual app with isolated storage, fake audio, no key tap, and intercepted paste/clipboard/system dialogs. The temporary generated script is removed when its child exits. Run with Node after building, while no other harness owns `out/`.
- `package-parity.mjs`: compares all 11 compiled app assets to the existing signed app archive.

The first three probes exit successfully after reproducing the current defects. The additional app runner exits **1** because its desired-behavior assertions fail. These are different assertion conventions; neither result means the defects are fixed. The extra app runner accepts `--packaged` or `--repeat 2` like the upstream harness.

## Captures and output

`screenshots/` contains 67 captures from `scripts/capture-ui.mjs`: 32 main-page captures, nine onboarding captures, 21 overlay states, and five menu-bar icons. They contain the capture script's sample content. The app windows remained hidden; these are rendered UI captures, not a substitute for native focus, VoiceOver, or hardware testing.

`*.log` files contain the executed check outputs. They are locally available evidence but ignored by the repository's existing global `*.log` rule. Key results are retained in the report; rerun the checked-in scripts to regenerate logs. The two unrestricted logs supersede the initial sandbox build/check attempts. The original built-app failures are retained alongside their isolated rerun rather than silently discarded.

The remaining native gates are documented in the report. Do not run focus-taking scripts against an active user session or bypass `scripts/lib/mac-in-use.mjs`; do not replace or quit a normal app instance with unsaved session history as part of these reproductions.

## After the fixes (5 October 2026, evening)

All fourteen findings are fixed; the closure table is at the end of the report. The probes above assert the defects of the code that was audited, so on the fixed tree they now fail, or no longer load: `storage-probes.ts` fails where the QA-02 entry now survives, `pipeline-integrity-probes.ts` fails at its first assertion because the guard rejects `-15 → 15`, and `ui-state-probes.mjs` stops at a hook its harness does not provide. They are kept as the record of what was reproduced. What now guards each finding is a maintained test: `tests/unit/{settings,history-store,storage-host,evaluation-sessions,session-controller,stt-host,guard,refiner,hub-mutations,questions}.test.ts`, `tests/renderer/{async-controls,pill-view}.test.ts`, and the `QA regression:` scenarios of `npm run test:app`.

