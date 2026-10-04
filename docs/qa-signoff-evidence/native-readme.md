# Native fix verification — 4 October 2026

Run from the repository root on macOS:

```sh
python3 docs/qa-signoff-evidence/native-recheck.py
```

The script imports the **current production Swift sources** into temporary scripts. It posts no keys, changes no focus, touches no microphone, and never accesses the general clipboard. Source extracts and compiler caches are deleted afterward. It exercises the real pure policy, matcher, and paste-sequencing code; it does not create a browser password input or execute a real paste.

Current expected output (the script asserts every line):

```text
oneHourPasswordRefused=true
backgroundHoldObserved=true laterPasswordRefused=true
newHoldBetweenSamplesRefused=true
ordinaryTerminalRefused=false secureTerminalRefused=true
firstEscapeCancelled=true
newHandsFreeEscapeCancelled=true swallowed=true
slowReadOutcome=expired detail=clipboardRead clipboardMutated=false keysPosted=false
PASS: all executed native policy checks passed.
```

Exit 0 means every executed assertion passed; exit 1 means a native regression assertion failed; exit 2 means a compiler/runtime/environment problem prevented reliable results. This is different from the original audit's defect-reproduction script, whose exit 0 meant a defect reproduced.

The recheck above passed on 4 October 2026 after the R1 repair. The targeted Swift command `swift test --package-path native/flow-helper --filter 'Secure(FieldPolicy|InputHistory)Tests'` also passed all 26 tests; it required normal compiler-cache access after the initial sandboxed command failed before compilation. An isolated temporary-source mutation that restored the removed bypass produced `laterPasswordRefused=false` and `newHoldBetweenSamplesRefused=false`, confirming that the recheck detects both R1 failures. No production source was mutated for that check.

## Verdicts

- **F01 / R1: the stale-history paste exception is removed.** Continuous foreground Secure Input remains refused after one hour. The same named holder is also refused after being observed behind another app and returning to an ambiguous current field, even when a same-PID disable/re-enable could have happened between samples. `SecureInputHistory.leftOn` and `SecureFieldPolicy.isStuck` are diagnostics only: they never override the current Secure Input signal. Ordinary fields with a stuck signal now use the existing Copy/recovery path. The intentional terminal exception remains; an explicitly secure accessibility element is still refused even in a terminal. These are modeled policy traces, not real browser or OS transitions, and do not claim a physical password-field paste test.
- **F05: fixed for the reported late-paste path.** A modeled clipboard read lasting 6.5 seconds, beyond both the helper's four-second expiry and the bridge's six-second response timeout, produces `expired/clipboardRead`; no clipboard mutation or key press is executed. The bridge carries the expiry and the production paste sequence checks it after a slow read, after a slow destination check, and before posting the keys.
- **F06: the requested complete-snapshot rule is implemented.** A missing format returns no snapshot; change counts are checked, format order is preserved, and restoration reports the actual write result. The deliberate fallback can leave the dictated text on the clipboard instead of the prior contents and is now reported to the UI. That fallback is documented, not proof that arbitrary clipboard contents are preserved.
- **F07: fixed.** The original sequence of cancelling while Escape stays held, starting a new hands-free session, releasing the old Escape, and pressing it again now emits cancel and swallows the new press. This is a pure matcher test; a physical key was not used.

For F01, [Apple's Secure Event Input guidance](https://developer.apple.com/library/archive/technotes/tn2150/_index.html) asks applications to disable the mode when leaving the foreground and enable it again when secure input is needed. It does not establish that a field is nonsecure after a stale hold was observed. The review's conclusion about the unsafe inference comes from the local policy and its input traces.

## Optional private clipboard probe

```sh
python3 docs/qa-signoff-evidence/native-recheck.py --pasteboard
```

This adds one unreadable advertised format to a fresh UUID-named private pasteboard and expects `missingFormatSnapshotAccepted=false`. It never reads or writes `NSPasteboard.general`. The initial sandboxed recheck could not access the private pasteboard (`privatePasteboardUnavailable=true`, exit 2), so it produced **no new live clipboard result**. The parent's full Swift test run covers the production clipboard regression suite; distinguish its executed/skipped status from this standalone probe.

No focus-taking integration test, physical keyboard check, real password-field test, hardware-disconnect test, or permission change was performed by this evidence script.
