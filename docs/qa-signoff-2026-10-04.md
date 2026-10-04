# QA fix verification — 4 October 2026

## Closure implementation

**Current verdict: R1–R3 are closed within the audited code scope. All thirteen original findings are accepted within that scope. Full code checks, signed-package validation, and both 52-scenario quiet-app suites pass. End-to-end keyboard/paste sign-off remains pending an Accessibility-trusted execution host and an available Mac.**

The user requested fixes after the initial review below. The changes preserve the existing uncommitted work on top of `b67c299` and address the three residual code gaps:

| Gap      | Repair                                                                                                                                                                                                                                                                                                                                                            | New evidence                                                                                                                                                                                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1 / F01 | Secure Input background history is diagnostic only and can never authorize automatic paste. A current ambiguous signal for the foreground app refuses paste and offers the existing Copy/recovery path. The documented terminal exception remains; an explicit secure element is always refused.                                                                  | Hour-long foreground, background→return password, and missed same-PID hold-transition traces all refuse. Ordinary terminal typing stays allowed; a secure terminal element refuses. An isolated restoration of the old bypass makes the two new traces fail again. |
| R2 / F03 | Local approval requires a valid completed Ollama reply with terminal `done:true`. Empty, malformed, unfinished and truncated UTF-8-tail responses cannot grant approval. Remote metadata blocks immediately, even before completion. A valid length-limited warm-up is accepted.                                                                                  | Client regressions and current-source pipeline probes confirm zero transcript requests for each refused warm-up, with successful cleanup after a valid length-limited reply.                                                                                       |
| R3 / F03 | Metadata, completed warm replies and pending warm-ups use server, canonical model name and digest. Missing digests fail closed. Identity is resolved before approval is used, after warming and before text is sent. Replacements warm independently; retries remain inside the original deadline. Cancelled pending warm-ups cannot obstruct an immediate retry. | Cached replacement and replacement during warm-up both send `one:warm`, `two:warm`, with no transcript to the remote replacement. Regressions also cover aliases, server changes, late replies, cancellation and repeated replacements.                            |

Independent cross-review found and closed the UTF-8 tail and cancelled-warm reuse cases. No additional locality or deadline blocker remained in that review. The native and pipeline evidence scripts now assert **closure**, not reproduction of the old defects; zero exit status means their regression assertions pass.

## Verification after these changes

| Check                            | Result                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run check`                  | Passed: typecheck, ESLint, Prettier, 626 TypeScript tests in 31 files and 115 Swift tests in 10 suites         |
| `npm run build`                  | Passed, including native helper and all build assertions                                                       |
| Native closure probe             | Passed; no keys, focus changes, real microphone or general clipboard access                                    |
| Pipeline closure probe           | All nine scenarios passed; rejected warm-up cases sent zero transcripts                                        |
| Fresh signed development package | Built in `dist/.qa-security-fixes/mac-arm64/Whisper Flow Dev.app`                                              |
| Packaged build comparison        | All 11 `out/` assets match the new ASAR byte for byte                                                          |
| Package checks and quiet smoke   | Passed signatures, hardened runtime, microphone entitlement, helper protocol 3 and four signed speech binaries |
| Smoke transcription              | 2.9-second synthetic fixture, 192 ms decode, 0% word error rate; model load 1,061 ms                           |
| Built quiet-app suite            | 52 passed, 0 failed; 41 intercepted pastes; 0 open microphone streams                                          |
| Packaged quiet-app suite         | 52 passed, 0 failed; 41 intercepted pastes; 0 open microphone streams                                          |

The one-minute synthetic dictation used three chunks: release-to-text was 979 ms in the built app and 971 ms in the new package, one observation each. These are regression observations rather than new percentile performance gates.

Reproduce the package suite with `node scripts/test-app.mjs --packaged --package-dir dist/.qa-security-fixes/mac-arm64`. The default package remains running from `dist/mac-arm64`, so it was neither replaced nor stopped. The separately staged package contains the fixes; the running copy does not pick them up automatically.

The package smoke still reports `accessibilityTrusted=false` for this execution host. No real keyboard/paste run, physical-key or hardware test was attempted. The prior release-hardening and personal voice/hardware qualification gates below remain separate from closing R1–R3. This is a scoped code-fix acceptance, not public-release or unrestricted end-to-end sign-off.

## Historical review before the closure changes

Everything below records the earlier review and its **pre-fix** observations. Its open statuses, source line numbers, test counts and probe exit meanings are historical; the closure status above supersedes them.

**Verdict: sign-off withheld. Eleven of the original thirteen findings are accepted as fixed within the audited scope. F01 and F03 remain partially resolved, with three residual security cases below.**

This review covers the uncommitted fixes on top of `b67c299`, not just the prior implementation log. Production code and user settings were not changed. The original audit remains historical evidence; this document is the follow-up verdict. Passing existing suites does not close a separately reproduced failure.

## Remaining blockers

### R1 / F01 — A previously stale Secure Input signal exempts later password fields

**Priority: P1.** Locations: `native/flow-helper/Sources/FlowHelperCore/SecureFieldPolicy.swift:84`, `SecureInputHistory.swift:66`, and the one-second observation interval in `native/flow-helper/Sources/FlowHelper/main.swift:75`.

The original 60-second expiry is fixed: a continuously focused password field remains protected after an hour. The replacement rule nevertheless sets `leftOn` after the named holder is observed behind another app for five seconds, and keeps that exemption until an observed disable or owner change. On returning to the holder, a new password field without an accessible secure role inherits the exemption. A disable/re-enable by the same PID entirely between samples is also indistinguishable from the exempted hold.

Executed against current production policy/history sources:

```text
oneHourPasswordRefused=true
stickyHold=true laterPasswordRefused=false
newHoldBetweenSamplesRefused=false
```

These are policy/input-sequence reproductions, not an actual browser password paste. The implementation log already acknowledges the tradeoff. Historical evidence that a signal was stale does not independently establish that the current field is safe; this remains incompatible with unconditional password-field protection.

**Required for closure:** keep automatic paste refused while Secure Input is ambiguous and no independent current-field evidence is available, offering Copy/recovery instead. Alternatively, treat bypass as an explicit, accurately described product exception rather than a completed safety guarantee. Add regressions for return-to-app password focus and a missed same-PID hold transition.

### R2 / F03 — Empty or unfinished warm-up is accepted as a local reply

**Priority: P1 under the local-only privacy requirement.** Locations: `src/main/cleanup/ollama-client.ts:306` and `:329`; positive warm evidence is recorded in `src/main/cleanup/refiner.ts:136`.

`chat()` returns normally at a clean HTTP 200 EOF even if the response is empty, or contains only a `done:false` chunk. Its default `remote:false` then becomes a successful `WarmReply`, and the refiner records that the model answered locally. The next transcript request proceeds. In the probe, that request's response reveals remote execution and the model is blocked only after receiving the transcript.

Executed controlled responses using synthetic text:

```text
baseline-remote: warmRequests=1, transcriptRequests=0
empty-warm: warmRequests=1, transcriptRequests=1
incomplete-warm: warmRequests=1, transcriptRequests=1
```

The original explicit remote warm-up is now correctly blocked. The remaining case concerns normally ended but protocol-incomplete responses; it is not a claim that every broken TCP connection is accepted, since transport errors can throw.

**Required for closure:** grant positive locality only after a valid complete Ollama reply with a terminal `done:true`. Keep immediate blocking when remote metadata appears, even in an incomplete reply. Do not require `done_reason:"stop"` specifically: a one-token warm-up can legitimately finish because of its length limit. Empty, malformed, and incomplete replies must fall back without sending the transcript.

### R3 / F03 — A replacement model inherits another digest's warm-up approval

**Priority: P1 under the same F03 threat model.** Locations: `src/main/cleanup/refiner.ts:149` and `:194`; `src/main/cleanup/local-only.ts:85` recognizes digest changes but returns only a boolean locality verdict to the refiner.

Warm-up evidence is keyed by URL and model name for five minutes. After a local model is warmed, replacing that name with a different digest does not invalidate its approval. The gate reads the changed digest and its details, but the refiner still sends the replacement its first transcript without obtaining that replacement's first reply.

Executed request order:

```text
one:warm
two:transcript
warmRequests=1, transcriptRequests=1
```

This requires the replacement's list/details metadata to appear local while its own response discloses remote execution—the same condition the F03 defense was introduced to cover. Normal cloud metadata is still rejected. These synthetic responses demonstrate the remaining trust gap; they do not establish that ordinary Ollama model updates leak data.

**Required for closure:** bind completed and in-flight warm-up evidence to server, canonical model name, and digest. Invalidate/re-warm when the verified identity changes, then recheck identity before sending text. Add a regression for replacement during the warm cache lifetime.

## Original finding disposition

| Finding                            | Verdict                         | Evidence / qualification                                                                                                                                           |
| ---------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F01 — password expiry              | Partial; R1 open                | Original one-minute failure is gone; background-history exception remains                                                                                          |
| F02 — redirects                    | Accepted                        | Centralized manual redirect handling; all five client entry points rejected redirect responses in independent probes; suite includes actual local-server scenarios |
| F03 — warm-up locality             | Partial; R2/R3 open             | Original remote reply now prevents any transcript; empty/incomplete and replacement cases still authorize one                                                      |
| F04 — processing Undo              | Accepted                        | Session controller owns recording lifetime; failed/late attempts preserve recovery; expanded suite exercises Undo after transcription                              |
| F05 — late paste                   | Accepted                        | Current-source sequence with a simulated 6.5-second read returns expired with no clipboard mutation or key posting                                                 |
| F06 — partial clipboard snapshot   | Accepted within requested scope | Missing formats reject the snapshot; format order/change count/restoration result handled; private-pasteboard Swift tests executed and passed                      |
| F07 — Escape rearming              | Accepted                        | Original matcher sequence now cancels and swallows the new Escape                                                                                                  |
| F08 — settings save failure        | Accepted                        | Original diagnostic now leaves memory and persisted mode both verbatim on EISDIR; UI failure handling inspected                                                    |
| F09 — model corruption             | Accepted                        | Original diagnostic: ready=false, repairFetchCalls=1, actualChecksumMatches=true                                                                                   |
| F10 — stalled download write error | Accepted                        | Original failure now surfaces by the 200 ms observation; stream is cancelled. Its old later close call is stale and cannot close the already-cancelled stream      |
| F11 — optional capabilities        | Accepted                        | Compatible model lacking tags capabilities is offered using show metadata                                                                                          |
| F12 — stale status                 | Accepted                        | Latest-only generation plus settings snapshot; regression coverage and tray refresh wiring inspected                                                               |
| F13 — inaccurate copy              | Accepted                        | Hub, README and microphone prompt updated; evaluation storage notice and stop action wired                                                                         |

F06 retains the documented fallback: when the prior clipboard cannot be copied completely, it is not restored and the UI explains that the clipboard holds the dictation. This accepts the specified all-or-nothing snapshot repair, not a guarantee that arbitrary clipboard contents are preserved.

## Fresh verification

| Check                                         | Result                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `npm run check`                               | Passed: typecheck, lint, format, 578 TypeScript tests in 31 files, 112 Swift tests in 10 suites                              |
| `npm run build`                               | Passed, including helper, worklet, preloads and build assertions                                                             |
| Complete `out/` comparison with packaged ASAR | All 11 build files identical                                                                                                 |
| Quiet `node scripts/check-pack.mjs`           | Passed: signatures, hardened runtime, microphone entitlement, protocol 3 helper, four signed speech binaries, packaged smoke |
| Packaged smoke transcription                  | Synthetic 2.9-second fixture, 129 ms decode, 0% word error rate                                                              |
| Built app suite                               | 49 passed, 0 failed; 37 intercepted pastes; 0 open microphone streams                                                        |
| Packaged app suite                            | 49 passed, 0 failed; 37 intercepted pastes; 0 open microphone streams                                                        |
| Independent storage probes                    | F08/F09 pass; F10 immediate rejection confirmed                                                                              |
| Independent pipeline probes                   | Original redirect, remote warm-up and model-list cases pass; R2/R3 reproduce                                                 |
| Independent native probes                     | Original continuous-password, paste-expiry and Escape cases pass; R1 reproduces                                              |

The standalone native probe exits 1 deliberately for R1. The pipeline probe exits 0 when its assertions successfully confirm the recorded residual defects. These meanings are documented beside the scripts; neither result should be confused with a clean product regression run.

The old audit probes are historical defect detectors, not all suitable unchanged after the refactor. Removed Swift parameters/extracted methods break the old extraction harness, successful stream cancellation invalidates its old cleanup step, and audio intentionally stays retained during the old Undo probe's wait. None of those obsolete expectations was counted as a new application defect.

## Sign-off limits and release gates

The fresh packaged smoke reports `accessibilityTrusted=false` for the helper started by this execution host. Real keyboard/paste testing was therefore not repeated: it cannot validate the required path here, and the revised project safeguards explicitly avoid disrupting active use. No application was quit, foreground window taken over, real microphone used, or security permission changed for this recheck.

The prior implementation log records 22/22 helper checks, but only 2/11 full E2E checks on its final package before user activity stopped that run. Those are historical results, not fresh verification in this review. Full E2E on a trusted, free Mac remains outstanding, as do physical Fn/Globe, real first permission grant/revocation, microphone disconnect, lid close and personal voice-quality checks. The new Hub buttons were inspected through their rendering/preload/IPC paths and service-level regression coverage; this review did not independently click them in a real setup flow.

Public distribution also retains previously acknowledged work: notarization is disabled in the release configuration, development Electron fuses remain enabled, the development dependency advisory is not closed, and the known system-panel destination and fixed clipboard-restoration risks remain. These are separate from acceptance of the eleven repaired findings.

**Closure criterion:** fix R1–R3, run their focused regression tests plus the current full checks/app suite, then complete the real keyboard/paste run from a trusted execution host before claiming end-to-end sign-off. Release hardening and hardware/voice qualification remain separate release gates.

## Reusable evidence

- [Pipeline reproduction and commands](qa-signoff-evidence/pipeline-readme.md)
- [Native reproduction and commands](qa-signoff-evidence/native-readme.md)
- [Original audit](qa-audit-2026-10-04.md)

The new probes import current production code, use synthetic fixtures and temporary files, and do not transmit user text or use the general clipboard. No functional fixes were made during this review.
