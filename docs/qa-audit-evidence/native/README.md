# Native QA reproduction evidence

These probes reproduce defects found during the 2026-10-04 audit. **Exit 0 means the recorded defect reproduced, not that the app passed a correctness test.** After a fix, a missing defect signature is expected and should be investigated.

Run from the repository root on macOS with Python 3 and the project's Swift toolchain:

```sh
python3 docs/qa-audit-evidence/native/run-native-probes.py
```

Expected output:

```text
[secure]
passwordFocusedFor=59.0 refused=true
passwordFocusedFor=60.0 refused=true
passwordFocusedFor=61.0 refused=false
Recorded defect reproduced.
[escape]
firstEscapeCancelled=true
newHandsFreeEscapeCancelled=false swallowed=false
Recorded defect reproduced.
```

- **Password refusal expires:** `SecureFieldPolicy` stops refusing a field after 60 seconds of Secure Input, even when the same browser still owns it and the accessibility tree exposes no element. This is a pure policy reproduction, not a live browser test.
- **Escape rearming is lost:** cancel a hands-free session while holding Escape; start another with Fn+Space before releasing the old Escape; release all keys; the next Escape no longer cancels or gets swallowed. These are calls into the pure matcher, not system key events.

The optional clipboard probe uses **only a fresh UUID-named private pasteboard**:

```sh
python3 docs/qa-audit-evidence/native/run-native-probes.py --pasteboard
```

Expected output (elapsed time varies):

```text
[clipboard]
nilReadSnapshotAccepted=true declaredTypes=2 savedTypes=1
slowSnapshotAccepted=true elapsedMs=605
Recorded defect reproduced.
```

- **Incomplete snapshots are accepted:** one of two advertised formats returns no data, but the snapshot is accepted with only one format. Production restoration would clear the clipboard and restore that partial snapshot.
- **The snapshot budget does not bound a provider read:** one lazy provider waits 600 ms. Its snapshot is accepted despite the production 250 ms budget. A provider taking longer than the bridge's six-second timeout can therefore allow a late paste; that consequence is supported by control-flow inspection, not by posting an actual paste in this probe.

A sandbox can prevent access even to a private pasteboard. In that case the probe exits 2 and explicitly reports that it obtained no result; this is not a reproduction. Run it with normal local macOS pasteboard access if needed. The audit run used automatically approved sandbox access to this private pasteboard.

`run-native-probes.py` reads current production files on every run. It embeds the complete `SecureFieldPolicy`, `KeyCodes`, and `BindingMatcher` sources into temporary Swift scripts. For clipboard testing it extracts the production snapshot method and both budget constants; only the method's `private` visibility is removed so the harness can call it. The algorithm is unchanged. Generated sources and Swift module caches are created in a temporary directory and deleted afterward.

**No probe reads or writes the general clipboard, posts keyboard events, changes app focus, opens the microphone, or edits production files.** The private pasteboard is released at the end of its run. No transcript or user clipboard content is used or printed.
