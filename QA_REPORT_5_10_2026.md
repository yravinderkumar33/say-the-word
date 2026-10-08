# Whisper Flow — End-to-End QA Report

**Review date:** 5 October 2026 (Asia/Kolkata)  
**Application:** Whisper Flow 0.0.1, macOS desktop application  
**Verdict:** **Do not sign off for release.** Confirmed data-loss and privacy defects remain despite the passing unit suite.

## Executive assessment

This review identified **14 confirmed defects: 3 P1, 9 P2, and 2 P3**. The most urgent are saved history being deleted after settings recovery, destructive ordering during history migration, and setup practice saving recordings despite promising that nothing is kept. Additional failures affect deletion completeness, recording opt-out, cleanup accuracy and reliability, asynchronous selections, and UI truthfulness.

All implemented screens and major journeys were inventoried and reviewed. Automated journeys were exercised in the real Electron application with synthetic audio and isolated storage, supplemented by targeted production-module fault reproductions and visual inspection. This is **not a claim that every possible device, OS state, editor, timing, or permission combination has passed**. Outstanding native and hardware checks are explicitly listed below.

Application code was not changed. Existing uncommitted work, the normal running app, its settings, transcripts, recordings, clipboard, and login items were preserved. Test-created files and apps used their own temporary directories. Network fault tests used loopback servers.

## Build and test identity

| Item             | Audited value                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository       | `whisper-flow`                                                                                                                                |
| Base Git commit  | `6fd9f2db3beb60e6469f0a84180608b917e9c9d6`                                                                                                    |
| Actual scope     | The entire current working tree, including substantial pre-existing modified and untracked implementation files; **not just the base commit** |
| Platform         | macOS 26.6.2, build 25G83, Apple Silicon arm64                                                                                                |
| Runtime          | Node 22.22.2; npm 10.9.7; Electron 44.5.1                                                                                                     |
| Speech model     | `parakeet-tdt-0.6b-v3-int8`, existing verified local model                                                                                    |
| Audio            | Repository-generated synthetic WAV fixtures; fake Chromium microphone                                                                         |
| Package          | Existing signed `dist/mac-arm64/Whisper Flow Dev.app`; all 11 built JavaScript/CSS/HTML/worklet assets matched its archive byte-for-byte      |
| Native preflight | Helper reported `accessibilityTrusted=true`; the readiness probe explicitly disabled the event tap                                            |

The initial sandbox build could not access Swift compiler caches, and its Vitest worker run stalled. Those attempts were stopped/replaced with approved normal-host execution. They are environment limitations, not application defects. No application source change was needed for the successful build/checks.

## Executed checks and evidence

Evidence is in [`docs/qa-2026-10-05/`](docs/qa-2026-10-05/). Logs contain synthetic scenario metadata, counts, timings, and errors; no real user transcript was captured.

| Check                                 | Result                                                                                                                                                                              | Evidence                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `npm run check`                       | **Pass:** type checks, ESLint, formatting; **943 TypeScript tests in 52 files**, **123 Swift tests in 10 suites**                                                                   | `check-unrestricted.log`                                           |
| `npm run build`                       | **Pass:** helper, main, renderer, preloads, worklet, and build assertions                                                                                                           | `build-unrestricted.log`                                           |
| Full built-app suite                  | **80/82 passed** initially; 61 intercepted pastes, **0 open microphone streams**                                                                                                    | `app-built.log`                                                    |
| Isolated history rerun                | **3 scenarios × 3 repetitions passed**; includes both initially failing history scenarios and retention consent; 12 intercepted pastes, 0 open streams                              | `history-recheck.log`                                              |
| Additional app probes                 | **6/6 expected-behavior assertions failed**, reproducing QA-03, 04, 05, 10, 12, 14; app itself completed each scenario; 0 open streams                                              | `app-extra.log`, `app-extra-probes.mjs`, `app-extra-scenarios.txt` |
| Storage fault probes                  | **4 defects reproduced** using actual storage/settings modules and temporary filesystem faults                                                                                      | `storage-probes.ts`, `storage-probes.log`                          |
| Cleanup fault probes                  | Numeric guard failures and persistent performance-estimate rejection reproduced                                                                                                     | `pipeline-integrity-probes.ts`, `pipeline-integrity-probes.log`    |
| UI/IPC state probes                   | Exact component/handler source reproduced microphone false success, unsaved volume display, and out-of-order model selection                                                        | `ui-state-probes.mjs`, `ui-state-probes.log`                       |
| Signed package verification and smoke | **Pass:** signature, hardened runtime, microphone entitlement, helper/native library, icon, app protocol, worklet/audio transfer, local transcription                               | `package-check.log`                                                |
| Package/build parity                  | **11/11 assets match**                                                                                                                                                              | `package-parity.mjs`, `package-parity.log`                         |
| Visual capture and review             | **67 screenshots captured**; 62 full-page/overlay images reviewed. QA-12 visually corroborated; dark practice-preview anomaly remains unconfirmed; native icon shapes also captured | `screenshots.log`, `screenshots/`                                  |
| Packaged-app regression suite         | **82/82 passed**; 62 intercepted pastes, **0 open microphone streams**                                                                                                              | `app-packaged.log`                                                 |
| Real local Ollama integration         | **5/5 passed**, `qwen3.5:4b`; model cleanup accepted in all five; release-to-paste median **944 ms**, p95/max **1,970 ms**                                                          | `ollama-live.log`                                                  |

### Initial history failures: disposition

The initial run failed “history lists a dictation, in memory” (count stayed 16 rather than increasing) and “history says how a dictation ended” (interrupted entry did not appear). Both text-production/recovery paths completed. Both scenarios subsequently passed **three times each** in a fresh isolated run, together with the related retention-consent scenario. The complete signed-package suite also passed **82/82**, including both history scenarios.

The failing snapshot showed the test Hub on **History before the harness had navigated to History**. The app intentionally excludes dictations into its own focused window, and quiet tests still consult `BrowserWindow.getFocusedWindow()` unless explicitly overridden. This makes focus/test-state interference a plausible explanation; its exact origin was not established. Preserve the initial failures as an **unresolved harness/reproducibility observation**, not a confirmed history product defect or an unqualified full-suite pass. A test should set external-app focus classification deterministically and separately test the own-window exclusion.

## Severity definitions

- **P1 — High:** loss of saved user data or unexpectedly persistent sensitive content. Resolve before release.
- **P2 — Medium:** incorrect core output, incomplete privacy actions, failed recovery/reliability, or misleading functional state. Resolve before broad use, or explicitly accept with a documented mitigation.
- **P3 — Low:** limited UI/accessibility inconsistency with another usable path.

## Confirmed findings

### QA-01 — P1: An unrelated preference change authorizes deletion of preserved history

**Journey:** recover from damaged settings → change an unrelated preference → relaunch.

1. Keep a dictation on disk using persistent history retention.
2. Damage the settings JSON, then launch. The app correctly preserves the existing history file because retention is unknown.
3. Change only Sounds, then quit and relaunch without choosing a history retention/deletion action.

**Expected:** saved history remains until an explicit retention or deletion choice.  
**Actual:** the preference save writes all fallback defaults, including `historyKeep: "session"`. The next launch treats that as an explicit choice and deletes the preserved file. Probe: **1 preserved file → 0**, with no history choice.

**Cause:** `SettingsStore.update()` materializes fallback defaults and marks every field as stated. The launch-time protection cannot distinguish that later save from consent. Automatic first-run preference writes expose the same provenance problem when settings are missing/unreadable.

**Source:** `src/main/store/settings.ts:111`, `src/main/index.ts:161`, `src/main/history/history-store.ts:162`.  
**Evidence:** `storage-probes.log`, case `unrelated_setting_after_corrupt_settings`.  
**Fix/retest:** preserve unknown retention provenance across all unrelated saves and restarts. Test corrupt, missing, legacy, and partially invalid settings, followed by sound/microphone/onboarding changes and two launches.

### QA-02 — P1: Failed history date migration deletes the only persisted source

**Journey:** launch with history requiring local-date-to-UTC file migration while a destination cannot be written.

1. Create a valid old day file whose entry belongs to the following UTC day.
2. Obstruct the destination day filename with a directory (a deterministic rename/write failure).
3. Launch, then relaunch after the failed migration.

**Expected:** retain the original file until every migrated destination has been safely published.  
**Actual:** the first launch lists the entry and reports a disk problem, but deletes the original file. On the next launch the entry is gone: **1 row → 0**, original source absent.

**Cause:** the migration rewrites/removes source days before guaranteeing successful destination writes. A destination failure can destroy the only durable copy.

**Source:** `src/main/history/history-store.ts:454`, `:506`, `:518`.  
**Evidence:** `storage-probes.log`, case `migration_destination_write_failure`.  
**Fix/retest:** commit destinations before removing sources, preserve retryable originals, and test permission errors, full disk, destination obstruction, and interruption between migration stages. Full-disk behavior is a risk inferred from the same ordering; the executed probe used destination obstruction.

### QA-03 — P1: Setup practice saves audio and text while saying “Nothing here is kept”

**Journey:** enable evaluation recording → reopen setup → practice dictation.

1. Enable “Save every dictation.”
2. Reopen the setup guide and reach its practice step.
3. Dictate a short fixture into the practice field.

**Expected:** honor the practice promise and keep its audio/text out of persisted stores; any active storage should be accurately disclosed.  
**Actual:** practice is excluded from History, but **three evaluation files** are created. The usual **Stop Saving banner is absent** on setup screens.

**Cause:** the own-window check gates History only. Evaluation saving consults the global setting, while App returns FirstRun before rendering the saving banner.

**Source:** `src/renderer/hub/FirstRun.tsx:774`, `src/renderer/hub/App.tsx:70`, `src/main/index.ts:424`, `src/main/dictation/wire-dictation.ts:418`, `src/main/dictation/speech-service.ts:453`.  
**Evidence:** `app-extra.log`, setup-practice scenario: `saved 3 evaluation files; Stop Saving visible=false; history added=0`. The test uses the real speech/storage pipeline, a synthetic fixture, and an own-window test override; physical focus/paste is not claimed.  
**Fix/retest:** exclude practice from evaluation saving at the recording boundary and keep storage disclosure visible throughout onboarding. Verify hold, hands-free, cancel/undo, interrupted practice, and setup reopened with persistent history/evaluation already enabled.

### QA-04 — P2: “Stop Saving” still permits the active recording to be written

**Journey:** evaluation recording on → start dictation → turn saving off before release → finish.

**Expected:** the active recording is not written after the user has stopped saving, or the UI explicitly states that stopping applies only to future dictations.  
**Actual:** the setting is false before release, yet **one new evaluation file—the WAV recording—is written afterward**. The test uses the same settings path as Stop Saving and counts files in its isolated evaluation folder.

**Cause:** audio saving is queued when recording begins. Turning the setting off does not retract that worker request; the later text-saving decision sees the new setting, leaving audio alone on disk.

**Source:** `src/main/dictation/speech-service.ts:245`, `:453`; evaluation-setting toggle in `src/main/index.ts:292`, `:681`.  
**Evidence:** `app-extra.log`, `QA5_STOP_SAVING_EVIDENCE`: `recordingsCreatedAfterOptOut:1`, `evaluationRecording:false`. The counter counts added files, not complete three-file dictations.  
**Fix/retest:** revoke queued audio writes when storage is disabled; test toggling during opening, listening, transcription, retry, and cancellation. Define and display the boundary if completion of an already-active recording is intentional.

### QA-05 — P2: “Delete Everything” leaves deleted text available to Paste Last

**Journey:** dictate → Privacy → Delete Everything → confirm → Paste Last.

**Expected:** deleted dictation text is no longer recoverable through the app's own commands.  
**Actual:** History is empty and Privacy reports no deletion problem, but the recovery buffer still holds the transcript and **Paste Last produces another paste**. Probe: `historyRows:0`, `recoveryEntriesWithText:1`, `additionalPastes:1`.

**Cause:** privacy deletion clears History, evaluation files, counts, and logs but does not clear `RecoveryBuffer`. Copy/Paste Last use that independent store. The confirmation enumerates those four stores without disclosing retained recovery text; the completeness expectation follows from the broader “Delete Everything” label.

**Source:** `src/main/hub/wire-hub.ts:296`, `:313`; `src/main/dictation/recovery-buffer.ts`.  
**Evidence:** `app-extra.log`, `QA5_DELETE_EVIDENCE`. Pastes were intercepted; the user's clipboard/editor was untouched.  
**Fix/retest:** define deletion across all in-memory copies, recovery/pill state, and pending callbacks. After confirmation, verify Copy Last, Paste Last, Undo/Retry, and late transcription cannot expose or resurrect deleted text. Separate History-row deletion semantics from the stronger Delete Everything promise. If retaining recovery is intentional, narrow the label and disclose exactly what remains.

### QA-06 — P2: A successful save for another day hides an unresolved lost-history write

**Journey:** persistent history → temporary disk failure → later successful dictation on another day → restart.

1. Make the history directory unwritable and add an entry for day A.
2. Restore write access and add an entry for day B.
3. Read storage status and restart.

**Expected:** retry day A or keep the unsaved-data warning until it is durable.  
**Actual:** both entries are displayed, `diskProblem` becomes false, and restart retains only day B: **2 rows → 1**.

**Cause:** `writeFailed` reflects only the most recent touched-day batch. There is no persistent dirty-day tracking/retry.

**Source:** `src/main/history/history-store.ts:446`, `:480`.  
**Evidence:** `storage-probes.log`, `successful_other_day_clears_unsaved_warning`.  
**Fix/retest:** track unsaved days separately and clear warnings only after all are synchronized. Test disk recovery across midnight and entries edited on multiple days.

### QA-07 — P2: Corrupt history remains on disk but cannot be deleted through its normal controls

**Journey:** persistent history file becomes truncated → relaunch → attempt privacy deletion.

**Expected:** remaining private files are counted even if their entries cannot be parsed; deletion remains available and failures are reported.  
**Actual:** a truncated file contains **307 bytes**, but the store reports zero rows/leftovers. History Delete All and Privacy's History Delete are disabled. If deletion is attempted with the directory protected, it reports **zero failures while the file remains**.

**Cause:** persistent mode forces `leftOnDisk` to zero, and clear/failure accounting relies on parsed entries rather than the actual file inventory.

**Source:** `src/main/history/history-store.ts:221`, `:317`, `:492`; `src/main/hub/wire-hub.ts:189`, `:299`; `src/renderer/hub/privacy-view.ts:61`; `src/renderer/hub/History.tsx:145`.  
**Evidence:** `storage-probes.log`, `unreadable_history_unaccounted`.  
**Fix/retest:** count all owned data/temp files independently of readable records, enable deletion whenever files remain, and report each failed file. Test malformed JSON, unreadable files, and undeletable temporary files.

### QA-08 — P2: Cleanup guard accepts changes to numeric meaning

**Journey:** Cleaned mode → local model changes a number's associated symbol → paste.

**Expected:** a meaning-changing model reply is rejected and rules-only text is used.  
**Actual:** the production guard and Refiner accept **`-15 → 15`, `$500 → €500`, and `5% → 5`** as `cleaned`; the altered reply becomes final text.

**Cause:** token normalization excludes leading signs, currency symbols, and percent markers. Protected-number comparison sees identical digit tokens.

**Source:** `src/main/text/words.ts:24`, `src/main/cleanup/guard.ts:93`.  
**Evidence:** `pipeline-integrity-probes.log`, three numeric-symbol cases. Model replies were deliberately injected; this does **not** claim an installed model happened to produce these errors.  
**Fix/retest:** compare semantic numeric units/signs while allowing intentional equivalent formatting. Cover negative values, currency identity, percentages, ranges, decimal/grouping formats, and dates.

### QA-09 — P2: One slow comparison can disable model cleanup for the rest of the process

**Journey:** Cleanup Try it with a slow loaded model → normal dictation → select a faster model → try again.

**Expected:** normal fallback should recover; changing models or using the longer comparison budget should allow a fresh measurement.  
**Actual:** a valid comparison with a 12-second first token learns a **4,020 ms** first-token estimate. Subsequent model-eligible requests return `tooLong` without a model call, including a different-model patient request. The probe's total chat count stays **1**.

**Cause:** shared, unscoped speed estimates are rejected against the 4,000 ms ceiling before the 20-second patient budget is applied. No request gets through to improve the estimate.

**Source:** `src/main/cleanup/refiner.ts:97`, `:220`, `:226`, `:330`; `src/main/dictation/wire-dictation.ts:292`, `:393`.  
**Evidence:** `pipeline-integrity-probes.log`, `slow-try-disables-all-subsequent-model-cleanup`; deterministic injected clock/client timings.  
**Fix/retest:** scope estimates to server/model/digest, apply the correct budget first, expire stale estimates, and permit bounded remeasurement. Verify recovery after transient load and model switches.

### QA-10 — P2: A slow earlier model selection overwrites a later Rules only choice

**Journey:** choose a model while validation is slow → immediately choose Rules only.

**Expected:** the most recent user choice remains selected.  
**Actual:** Rules only first saves `null`, then the older validation finishes and saves the prior model over it. Reproduced both through the real page with a delayed loopback server and through the exact IPC handler with controlled promises.

**Cause:** non-null model selection awaits `cleanupFacts()`; null selection commits immediately. There is no request generation or stale-result check before committing the older request.

**Source:** `src/main/hub/wire-hub.ts:250`.  
**Evidence:** `app-extra.log`, latest-choice scenario; `ui-state-probes.log`: `latest choice=null, final saved choice=model-A, writes=2`.  
**Fix/retest:** enforce last-choice-wins across awaited validation, including switching between two models, Rules only, and server addresses.

### QA-11 — P2: A newly selected microphone inherits the previous microphone's successful setup check

**Journey:** setup microphone test succeeds on device A → select device B.

**Expected:** clear the successful check, test device B, and show B's actual result.  
**Actual:** B is never opened, but “Heard you. The microphone works” remains and Continue stays enabled. Probe: selected B, **one test start, for A only**.

**Cause:** `heard` is shared by the setup flow rather than keyed to device identity; the effect skips testing whenever it is already true.

**Source:** `src/renderer/hub/FirstRun.tsx:112`, `:130`, `:414`, `:517`.  
**Evidence:** `ui-state-probes.mjs` loads the exact component body with an isolated hook scheduler. This verifies state/effect logic, **not physical microphone behavior or React DOM integration**.  
**Fix/retest:** associate successful validation with the selected device; reset on changes/disconnection and test A→B, system-default changes, denied permission, and device removal.

### QA-12 — P2: Changing the cleanup model leaves the comparison result stale

**Journey:** enter a sentence in Cleanup Try it → wait for result → select another model without editing the sentence.

**Expected:** rerun the comparison or clearly invalidate its result so it reflects the selected configuration.  
**Actual:** the selected model changes, but **zero new comparison requests** are made. The old model's result stays until the text is edited.

**Cause:** the comparison effect depends on typed text only, not model/server/configuration changes.

**Source:** `src/renderer/hub/Cleanup.tsx:219`, `:241`; `src/renderer/hub/cleanup-view.ts:173`.  
**Evidence:** `app-extra.log`, model-change comparison scenario; `screenshots/cleanup-dark-model-refused.png` also shows a refused selected model beside the previous model’s successful comparison.  
**Fix/retest:** key comparisons by input and model/server identity, invalidate in-flight obsolete answers, and test model changes, Rules only, and server restarts while input remains unchanged.

### QA-13 — P3: Volume slider continues showing a value that failed to save

**Journey:** Settings → change sound volume while settings persistence fails.

**Expected:** revert the control to the actual saved value or visibly mark it unsaved.  
**Actual:** the backend remains at **60%**, while the slider remains at **80%**. A global failure pill exists, but the control itself continues misrepresenting the applied value.

**Cause:** local slider state only resets when the authoritative prop changes; rejected persistence returns the same old prop and does not trigger that effect.

**Source:** `src/renderer/hub/Settings.tsx:314`.  
**Evidence:** `ui-state-probes.log`, exact component body under an isolated hook scheduler; no DOM/pointer test claimed.  
**Fix/retest:** handle the save result and reconcile local state even when the authoritative value is unchanged. Cover pointer-up, keyboard commits, repeated rejection, and recovery.

### QA-14 — P3: Processing Cancel is missing from the menu-bar menu

**Journey:** release dictation → processing lasts longer than one second → use menu-bar controls.

**Expected:** the processing Cancel action offered on the non-focusable pill also exists in the menu, as the app's accessibility design requires.  
**Actual:** pill Cancel is present, but the actual tray template contains **zero Cancel Dictation items**. Escape is an alternative, limiting severity.

**Cause:** tray cancellation is conditional on hands-free listening; processing clears that state.

**Source:** `src/renderer/overlay/Pill.tsx:267`, `src/main/windows/tray.ts:161`, `src/main/index.ts:397`.  
**Evidence:** `app-extra.log`, live processing state combined with production tray-template construction under Electron stubs. The native macOS menu was not opened during this probe.  
**Fix/retest:** expose Cancel for cancellable processing/cleanup states and verify keyboard/VoiceOver access alongside listening, Undo, and Retry.

## Performance observations

The existing signed-package smoke loaded the speech model in **1,153 ms** and transcribed **2.9 seconds** of synthetic audio in **143 ms**, with **0% fixture word error rate**. These are individual observations, not percentile gates.

Five synthetic dictations through the installed local **qwen3.5:4b** completed with accepted model cleanup in all five cases. Release-to-paste was **944 ms median**, **1,970 ms p95/max** (minimum 861 ms); cleanup alone was **622 ms median**, **1,521 ms p95/max** (minimum 575 ms). Pastes were intercepted. This small sample verifies the current local integration and its test latency bound; it does not requalify a 20-run latency gate or establish real-voice accuracy.

## Complete implemented-flow inventory and coverage

**A** = executed in isolated real app; **U** = unit/production-module verification; **V** = screenshot inspection; **R** = code review; **N** = native/hardware validation still required. A passing baseline path does not override the listed failing edge cases.

| Area / user journey                                                    | Coverage  | Outcome / boundary                                                         |
| ---------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| Launch, helper/worker/preload/worklet startup                          | A/U       | Build/package smoke passes                                                 |
| Missing model → refusal → download → dictation                         | A/U       | Passed with local fixture server                                           |
| Download cancel, partial resume, stall/failure, checksum rejection     | A/U       | Passed; real public CDN/proxy not exercised                                |
| Existing model adoption, changed files, failed load, repair            | A/U       | Passed                                                                     |
| First run Welcome, download/cancel/retry, progress                     | A/U/V     | Covered; fresh OS installation remains N                                   |
| Microphone permission, check, listen again, skip                       | A/U/R/V/N | State handling covered; QA-11; actual grant/deny/revoke not toggled        |
| Accessibility step, missing permission guidance, continuation          | A/U/R/V/N | Synthetic UI state covered; real grant-after-launch/revoke not executed    |
| Shortcut conflict and Control+Option selection                         | A/U/R/V/N | Preference/UI/helper matching covered; physical keys remain N              |
| Practice hold, hands-free, cancel/undo, three completion ticks         | A/U/V     | Covered with injected gestures; QA-03                                      |
| First-run Cleaned, Rules only, skip, Ready/login choice, reopen        | A/U/V     | Baseline passes; evaluation-enabled reentry fails QA-03                    |
| Home readiness/fix actions, modes, microphone, recents, statistics     | A/U/V     | Baseline passes; inherits relevant data/storage defects                    |
| Hold/release, quick tap, sequential dictations                         | A/U       | Text pipeline passes; actual keyboard/paste remains N                      |
| Hands-free via pill, double tap, shortcut model                        | A/U       | Injected actions pass; physical gestures remain N                          |
| Cancel during opening/listening/processing/cleanup                     | A/U       | Baseline passes; no cancellation paste observed in assertions              |
| Undo Cancel, expiration, Retry, late cancelled results                 | A/U       | Baseline passes; recording release checked                                 |
| Interruption while listening/processing, worker death, microphone loss | A/U       | Injected failures pass; physical lock/sleep/hot-unplug remain N            |
| Silence, max recording limit, long/chunked recordings                  | A/U       | Covered; not every language/accent/noise condition                         |
| Model idle unload/reload                                               | A/U       | Passed                                                                     |
| Clipboard restoration, target changes, secure fields, paste expiry     | U/R/N     | Native algorithms covered; actual cross-editor/paste gate remains N        |
| Last-text recovery, Copy/Paste Last, waiting marker                    | A/U       | Baseline passes; deletion violates QA-05                                   |
| Pill rest/hint/start/listen/process/busy/cancel/recovery/redo          | A/U/V     | Covered; menu parity fails QA-14                                           |
| History add/order/outcome/fetched status                               | A/U/V     | Initial two failures pass repeated isolation; observation retained         |
| History search, empty/no-results, day groups, keyboard navigation      | A/U/V     | Baseline passes                                                            |
| History detail, differences, raw/final copy, selection, Back           | A/U/V     | Baseline passes; real clipboard door intercepted                           |
| History pause/resume                                                   | A/U       | Baseline passes                                                            |
| Retention session/week/month/forever; approve/cancel confirmation      | A/U       | Consent baseline passes; fault/restart paths fail QA-01, 02, 06, 07        |
| Delete one, Delete All, cancel bulk confirmation                       | A/U       | Normal deletion passes; unreadable storage fails QA-07                     |
| Cleanup Verbatim/Cleaned, local models, rules fallback                 | A/U/V     | Baseline passes                                                            |
| Missing/stopped/slow/bad/remote/redirecting Ollama                     | A/U/R     | Controlled endpoints pass locality/deadline assertions                     |
| Cleanup empty/incomplete warmup, changed model digest                  | A/U       | Baseline passes                                                            |
| Cleanup meaning preservation and performance learning                  | U         | QA-08 and QA-09 reproduced                                                 |
| Cleanup Try it, changing models, overlapping selection                 | A/U/V     | QA-10 and QA-12 reproduced                                                 |
| Settings key, microphone preference/fallback/order/test                | A/U/R/V/N | Software selection paths covered; physical reorder/hot-plug remains N      |
| Sounds/cues/volume, pill at rest, model memory duration                | A/U/V/N   | Baseline software paths covered; QA-13; listening quality remains N        |
| Open at login, Show in Dock, Finder/browser links                      | A/U/R/N   | Test doors counted; real system changes deliberately not made              |
| Logs and diagnostics                                                   | A/U/R     | Baseline checks pass; no fixture speech words in production log assertions |
| Ollama address validation and local-only boundary                      | A/U       | Invalid/nonlocal settings and remote model responses checked               |
| Privacy contact ledger and renderer network refusal                    | A/U/V     | Baseline passes; intermediate redirect-host accounting limitation below    |
| Privacy storage counts, reveal, delete/retry/everything                | A/U/V     | Normal deletion passes; QA-05 and QA-07                                    |
| Evaluation off/on, persistent save, banner, Stop Saving                | A/U/V     | Basic opt-in passes; QA-03 and QA-04                                       |
| Tray statuses, icons, recents, modes, microphones, pause/resume        | A/U/R/V/N | Software state checked; native menu interaction remains N; QA-14           |
| About version, licenses, conditional links                             | A/U/R/V   | Covered; unset support/source URLs intentionally hide links                |
| Light/dark, minimum window, contrast/transparency variants             | A/V       | See visual results; VoiceOver/native window chrome remains N               |
| Packaging/signature/icon/native dependency integrity                   | A         | Existing matching signed package passes validation                         |

## Remaining risks and unverified coverage

1. **Real global keyboard and paste:** a normal Whisper Flow instance was already running. It was not quit or modified because quitting can discard session-only history. The guarded native integration suites were not run in parallel with that instance. They require the idle-Mac and focus safeguards documented in `CLAUDE.md` and `scripts/lib/mac-in-use.mjs`. Accessibility preflight passed, but it does not prove event delivery, Secure Input protection in real editors, or clipboard restoration under native contention. No native permission auto-review rejection occurred.
2. **Hardware/OS matrix:** physical Fn and Control+Option, USB/Bluetooth microphone changes, multiple displays/scaling, real sleep/lock/user switching, permission revocation/regrant, and macOS 14/15 were not validated on separate hardware/OS installations.
3. **First install:** a truly fresh macOS permission database, Finder-launched first grant, real login-start behavior, Dock transitions, and unsigned/quarantined distribution remain unverified. Test dialogs/login/browser/clipboard operations were counted through safe stand-ins.
4. **Accessibility:** screenshot contrast variants and keyboard-related automated paths do not establish full VoiceOver semantics, announcement timing, native menu navigation, or keyboard reachability of time-limited Undo/Retry. The six-second recovery window is already an acknowledged product decision requiring evaluation.
5. **Renderer crash recovery:** source inspection suggests that a crashed/reloaded capture renderer may fail to send the worker's final audio-end message, losing recoverable speech despite audio already reaching the worker. **Not reproduced; not counted as a confirmed defect.** Add a safe renderer-crash scenario distinct from the existing worker-death test.
6. **Network accounting:** the ledger records a download's initial URL and final response URL; intermediate redirect hosts are not enumerated. This limits the claim that Privacy lists every contacted host. It was code-reviewed, not exercised with a multi-host redirect chain.
7. **Speech/cleanup quality:** synthetic fixtures do not establish performance on accents, multilingual speech, background noise, technical vocabulary, or all semantic edits. Fault-injected cleanup replies demonstrate guard behavior, not observed model hallucination frequency.
8. **Dark practice-preview screenshot:** `first-run-try-dark.png` has a blank pill preview while its legend says Resting; the light capture has the resting line. Source and compiled CSS use identical rendering/tokens in both themes. A hidden-window paint/capture artifact remains plausible. A visible-window repeat and computed-style inspection are needed; this is not counted as a confirmed defect.
9. **Duration/stress:** this audit is not a multi-day soak, exhaustive race schedule, memory-leak qualification, or full distribution/update audit. Dictionary, Apps, Snippets, automatic updates, shortcut recording, and the pill context menu are documented as not implemented; their absence was not misreported as a regression.

## Reproduction and follow-up

Run from the repository root. These probes use synthetic inputs; inspect the scripts before running on another workstation.

```sh
# Production modules; success means the current defect was reproduced.
TSX_TSCONFIG_PATH=tsconfig.node.json node --import tsx docs/qa-2026-10-05/storage-probes.ts
TSX_TSCONFIG_PATH=tsconfig.node.json node --import tsx docs/qa-2026-10-05/pipeline-integrity-probes.ts
node docs/qa-2026-10-05/ui-state-probes.mjs

# Real app, isolated user data/evaluation folder, fake microphone, no key tap.
# Build first; do not build while another test is using out/.
node docs/qa-2026-10-05/app-extra-probes.mjs
node scripts/test-app.mjs --only 'the history' --repeat 3
```

The extra app probe runner should currently exit **1**, because it asserts the desired behavior and all six cases expose defects. The production-module probes currently exit **0** after asserting that the defects occur. After fixes, convert these into normal regression tests that assert the desired behavior rather than preserving the defects.

**Release follow-up:** fix QA-01–03 first; then resolve storage/deletion integrity and cleanup selection/accuracy/reliability issues. Rerun the focused probes, full checks, built and signed-package app suites, and guarded native keyboard/paste suite on an available Mac. Require a real first-run/permission and VoiceOver pass before end-to-end sign-off. No fixes were implemented as part of this audit.

## Closure — 5 October 2026, evening

Everything above is the audit as it was made, and is left as it was. This section records what became of it.

The fixes were begun the same day by the session that wrote this report, following a plan the owner approved: history and the figures moved into SQLite, in a storage process of their own, and each finding fixed with a regression test. That session stopped part-way, before its last edits were run and before anything was written down. The fixes were then reviewed in four areas (storage; privacy and the life of a session; cleanup; the interface), each finding checked against the audited code (this report's logs) and against the code as it stood, and completed. **All fourteen findings held, and all fourteen are fixed.** The review of the first fixes found further defects that they had brought in, listed below; those are fixed too.

### The findings

|       | Held (evidence above)                                         | What was done                                                                                                                                                                                                                                                                                                                                         | What now guards it                                                                         |
| ----- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| QA-01 | `nextLaunchRemainingFiles: 0`                                 | An unstated "Keep" is left out of the settings file when anything else is saved; only a choice states it. The question a time to keep puts now counts what it would list again and what it would delete at once, before anything is opened                                                                                                            | `settings.test.ts`; `history-store.test.ts`; the app scenario on deleting at launch        |
| QA-02 | `sourceStillPresent: false`, `nextLaunchRows: 0`              | The day files are moved into the database in one transaction with a receipt, and a file is removed only once its receipt is committed. A file that cannot be read is kept; a changed one is not moved twice                                                                                                                                           | `history-store.test.ts` (migration cases)                                                  |
| QA-03 | 3 evaluation files from practice; no Stop Saving during setup | Whether a session may be saved is settled when its recording begins: never in the app's own windows, and checked again when the destination is read. The saving banner is shown through the first run, beside the window's buttons                                                                                                                    | `evaluation-sessions.test.ts`; the app scenario on practice                                |
| QA-04 | `recordingsCreatedAfterOptOut: 1`                             | The speech process writes a recording only when it is committed for a session that may be saved. Stop Saving takes back every session not yet saved, in the speech process too, partial files included, even one being written at that moment                                                                                                         | `evaluation-sessions.test.ts`; the app scenario on Stop Saving                             |
| QA-05 | `recoveryEntriesWithText: 1`, `additionalPastes: 1`           | Delete Everything has a path of its own: savings called off first, the session under way cancelled without keeping its text, recovery emptied, Undo and Retry withdrawn, recordings let go, late results, pastes and callbacks refused, a result still on its way not kept. Dictation waits until every deletion is over. The dialog says all of this | `session-controller.test.ts`; `stt-host.test.ts`; `questions.test.ts`; three app scenarios |
| QA-06 | `rowsAfterRestart: 1`                                         | Each accepted write is kept until it is written (by the storage process, and a copy in main), and tried again on its own; the warning stays while any waits                                                                                                                                                                                           | `storage-host.test.ts`; `history-store.test.ts`                                            |
| QA-07 | 307 bytes unaccounted; Delete disabled; 0 failures said       | Every file the history owns is counted, readable or not; Delete is offered while any is there; what would not go is said per file; the Delete All question speaks of files when no dictation is listed                                                                                                                                                | `history-store.test.ts`; `questions.test.ts`                                               |
| QA-08 | `-15 → 15`, `$500 → €500`, `5% → 5` accepted                  | Cleanup reads quantities with their sign, currency, per cent, degrees, primes and ranges; a change of any of them falls back to the rules-only text; explicit corrections ("5, no, 6") pass                                                                                                                                                           | `guard.test.ts`                                                                            |
| QA-09 | one slow comparison: `tooLong` for everything after           | Speeds are measured per server, model and digest; a comparison on the Cleanup page is never refused by a prediction; a measurement stands five minutes; a model measured as slow is measured again after 30 s, and less often while it stays slow                                                                                                     | `refiner.test.ts`                                                                          |
| QA-10 | latest choice `null`, saved `model-A`                         | Each choice is numbered; an older one that finishes later is answered "superseded" and changes nothing; a change of address supersedes too                                                                                                                                                                                                            | `hub-mutations.test.ts`; the app scenario on the latest choice                             |
| QA-11 | B selected, only A tested, success shown                      | "Heard you" belongs to the microphone in use (the one chosen while it is there, or the system's default) and goes when that changes; a late word from an earlier check is not taken; the step stays as it is, so the keyboard stays where it was                                                                                                      | `async-controls.test.ts`                                                                   |
| QA-12 | 0 new requests                                                | A change of server or model starts the comparison again; a result made under facts that have since changed is asked for again once it is over; a passing "not running" never cuts one off                                                                                                                                                             | `async-controls.test.ts`; the app scenario on changing the model                           |
| QA-13 | backend 60 %, slider 80 %                                     | The slider takes the value main says is in force, after a refusal too; an older answer cannot overwrite a newer edit                                                                                                                                                                                                                                  | `async-controls.test.ts`                                                                   |
| QA-14 | 0 Cancel Dictation items                                      | The menu offers Cancel Dictation by the pill's own rule (hands-free, or processing past a second, while loading or tidying too); VoiceOver is told it is there; a menu item pressed after its session is over does nothing                                                                                                                            | `pill-view.test.ts`; the app scenario, which reads the menu the app built                  |

The harness observation (the two History failures of the first run) is answered as the report suggested: the quiet app tests now say explicitly whether the keyboard is in one of the app's own windows (`own-window on`, `off` or `auto`), and the scenarios for the app's own windows set it themselves.

### What the first fixes brought in, found in review, and fixed

| What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | What was done                                                                                                                                                                                                       | Test                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| One write that kept failing held back every later one: with a counts database that could not be opened, no dictation was listed again; a write refused for its content was tried for ever                                                                                                                                                                                                                                                                                                                               | Dictations and counts wait in separate lanes; a write the disk will not take is held and listed, and does not hold back the next; one refused for its content is dropped and said; retries with backoff (`p-retry`) | `storage-host.test.ts` (real stores behind a stand-in process)     |
| A storage process that stopped took the history held in memory with it, without a word                                                                                                                                                                                                                                                                                                                                                                                                                                  | The History page says how many dictations were lost; listing goes on                                                                                                                                                | `storage-host.test.ts`; an app scenario that ends the real process |
| Choosing 7 or 30 days to list a preserved history again deleted older dictations the question had not counted                                                                                                                                                                                                                                                                                                                                                                                                           | The question counts them, and says how many come back                                                                                                                                                               | `history-store.test.ts`; `questions.test.ts`                       |
| A short Cleaned dictation waited up to the whole ceiling for a model that was loading; a long one waited 4 s every 30 s for nothing                                                                                                                                                                                                                                                                                                                                                                                     | A text keeps its own allowance; one too long for any model of the usual speed is refused at once                                                                                                                    | `refiner.test.ts`                                                  |
| With "Save every dictation" on, Undo and Retry saved the recording without its text, and the sessions piled up                                                                                                                                                                                                                                                                                                                                                                                                          | What is saved is decided when the session's recording is let go, from how it ended last                                                                                                                             | `evaluation-sessions.test.ts`                                      |
| After Delete Everything a late recognition result was kept in main's memory; two deletions at once let dictation start in the middle of the second                                                                                                                                                                                                                                                                                                                                                                      | Late results for deleted sessions are not kept; deletions are counted                                                                                                                                               | `stt-host.test.ts`; `session-controller.test.ts`                   |
| Try it could hang without an answer, and a passing "not running" restarted a comparison under way                                                                                                                                                                                                                                                                                                                                                                                                                       | As QA-12 above                                                                                                                                                                                                      | `async-controls.test.ts`                                           |
| The first run's "Use Cleaned" could leave Verbatim on without a word                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The mode chosen is the mode set; a model that cannot be used leaves the rules only, and Home says why                                                                                                               | by reading                                                         |
| The test for QA-14 could not fail: it fed the menu the pill's own value                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The control line reports the labels of the menu the app built                                                                                                                                                       | the app scenario                                                   |
| The microphone step was put together again on every change of device, and the keyboard was lost; any device at all (a speaker) restarted the check                                                                                                                                                                                                                                                                                                                                                                      | As QA-11 above                                                                                                                                                                                                      | `async-controls.test.ts`                                           |
| During the first run the saving banner lay under the window's buttons                                                                                                                                                                                                                                                                                                                                                                                                                                                   | It starts beside them                                                                                                                                                                                               | by reading                                                         |
| Smaller ones: the counts database made at every launch (Privacy showed 33 KB counted); every storage answer read the leftover day files again; the storage process's output was lost; unfinished day files of the old format stayed; "Delete all 0 dictations"; a storage process that would not start was kept, and quitting could wait a minute for a hung one; Stop Saving took back twice; `15° → 15` accepted; practice counted in the word figures; the storage benchmark printed queue figures it never measured | Each fixed                                                                                                                                                                                                          | store, host and guard tests                                        |

Not changed, on purpose: History's Delete All leaves the last dictations to Paste Last and Copy Last, which are the safety net and not the history; its dialog now says so, and Delete Everything deletes them. A 5-second wait on the speech process can say that a recording could not be removed while the process is still busy with a decode, which then removes it; rare, and left.

### This report's remaining risks

- **5 (renderer crash):** not reproduced, and not addressed.
- **6 (network accounting):** fixed. A request that may be sent on is followed one step at a time, and every host on the way is listed; Ollama's requests, which are never sent on, are left as they were (`network-ledger.test.ts`).
- **8 (the dark practice preview):** does not reproduce. Today's pictures draw the resting pill in both appearances, over the preview's backdrop of light and dark.
- **1–4, 7 and 9** are unchanged: they need a person, a voice, hardware or time.

### Packages

`birpc` (requests to the storage process and their answers) and `p-retry` (writes tried again) replace hand-written plumbing, at the owner's request. Both MIT and bundled. The About page lists the main components; a test checks that every bundled package, and everything it brings, is under a licence that asks for no more than its notice.

### Verification

- `npm run check`: 1,000 TypeScript tests in 57 files and 123 Swift tests pass. Every new test was run with its fix taken out, and failed.
- `npm run test:app`: 91 of 91 on the built output and 91 of 91 on the signed package, 67 pastes counted and no microphone stream left open each time. The three app-level checks that this report's probes made are maintained scenarios now (`QA regression:`), and pass. One earlier built run timed out three times waiting for the window to show the first run; those scenarios pass alone, in sequence, on the package and in the next full run, and the cause is not known.
- `npm run pack`: every check passes, and the packaged smoke now has the storage process keep a dictation inside the signed app.
- With 100,000 saved dictations, the newest 50 are listed in 2 ms and a write is taken in 3 ms (95th percentile); twenty dictations timed while that history is searched and swept give release to paste of 402 ms median and 448 ms at the 95th percentile, against the 1.0 s gate. The figures are in `docs/benchmarks.md`.
- Still to be done by a person, as before: the keyboard and paste tests on an idle Mac, a first run with real permissions, microphones that come and go, the menu itself, and VoiceOver.
