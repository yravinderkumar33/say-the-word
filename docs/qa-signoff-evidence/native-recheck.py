#!/usr/bin/env python3
"""Read-only recheck of native QA fixes using the current production Swift sources.

No system keys, focus changes, microphone access, or general clipboard access.
The optional clipboard probe uses a fresh UUID-named private pasteboard only.
Exit 1 means at least one native regression assertion failed;
exit 0 means every executed policy assertion passed; exit 2 means no reliable result.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]
CORE = ROOT / "native/flow-helper/Sources/FlowHelperCore"


def current_sources(*names: str) -> str:
    return "\n".join((CORE / name).read_text() for name in names)


def pure_probe() -> str:
    return current_sources(
        "SecureInputHistory.swift",
        "SecureFieldPolicy.swift",
        "KeyCodes.swift",
        "BindingMatcher.swift",
        "PasteSequence.swift",
    ) + r'''

func refused(_ history: SecureInputHistory) -> Bool {
    SecureFieldPolicy.isSecure(
        elementIsSecure: false, secureInputEnabled: true,
        secureInputHolderPid: 501,
        frontmostPid: 501, bundleId: "com.google.Chrome"
    )
}
var continuous = SecureInputHistory()
for second in 0 ... 3600 {
    continuous.observe(enabled: true, holder: 501, frontmost: 501, at: Double(second))
}
print("oneHourPasswordRefused=\(refused(continuous))")

var retained = SecureInputHistory()
retained.observe(enabled: true, holder: 501, frontmost: 501, at: 0)
for second in 1 ... 6 {
    retained.observe(enabled: true, holder: 501, frontmost: 777, at: Double(second))
}
// The system hold remains while the user returns to the browser and focuses a
// password field with no exposed AX role. This is a modeled input trace, not a
// browser or OS test. The policy cannot distinguish this from an ordinary field.
retained.observe(enabled: true, holder: 501, frontmost: 501, at: 7)
print("backgroundHoldObserved=\(retained.leftOn) laterPasswordRefused=\(refused(retained))")

// An off/on cycle of this same PID occurring entirely between samples is not
// supplied to observe(): by definition the polling helper never saw it. The
// following reading is consistent with either that new hold or the previous hold.
retained.observe(enabled: true, holder: 501, frontmost: 501, at: 8)
print("newHoldBetweenSamplesRefused=\(refused(retained))")

let ordinaryTerminal = SecureFieldPolicy.isSecure(
    elementIsSecure: false, secureInputEnabled: true,
    secureInputHolderPid: 501,
    frontmostPid: 501, bundleId: "com.apple.Terminal"
)
let secureTerminal = SecureFieldPolicy.isSecure(
    elementIsSecure: true, secureInputEnabled: true,
    secureInputHolderPid: 501,
    frontmostPid: 501, bundleId: "com.apple.Terminal"
)
print("ordinaryTerminalRefused=\(ordinaryTerminal) secureTerminalRefused=\(secureTerminal)")

var matcher = BindingMatcher(bindings: [
    Binding(id: "ptt", chords: [[63]]),
    Binding(id: "handsFree", chords: [[63, 49]])
])
matcher.armEscape(true)
let first = matcher.keyDown(keyCode: 53, isRepeat: false)
matcher.armEscape(false)
_ = matcher.modifierChanged(keyCode: 63, isDown: true)
matcher.armEscape(true)
_ = matcher.keyDown(keyCode: 49, isRepeat: false)
_ = matcher.keyUp(keyCode: 49)
_ = matcher.modifierChanged(keyCode: 63, isDown: false)
_ = matcher.keyUp(keyCode: 53)
let second = matcher.keyDown(keyCode: 53, isRepeat: false)
print("firstEscapeCancelled=\(first.events.contains(.cancel))")
print("newHandsFreeEscapeCancelled=\(second.events.contains(.cancel)) swallowed=\(second.swallow)")

var now = 0.0
var calls: [String] = []
let steps = PasteSteps(
    now: { now }, postAccess: { (true, "ok") }, prepareKeys: { true },
    refusal: { _ in nil }, settleEarlierPaste: {},
    saveClipboard: { now = 6500 }, writeText: { calls.append("write") },
    pressKeys: { calls.append("keys") }, takeTextBack: { calls.append("restore") },
    scheduleRestore: { calls.append("schedule") }
)
let result = PasteSequence.run(steps, expiresAtMs: 4000)
print("slowReadOutcome=\(result.outcome) detail=\(result.detail ?? "") clipboardMutated=\(calls.contains("write")) keysPosted=\(calls.contains("keys"))")
'''


def clipboard_probe() -> str:
    return "import Foundation\n" + current_sources("ClipboardSnapshot.swift") + r'''
final class EmptyProvider: NSObject, NSPasteboardItemDataProvider {
    func pasteboard(_ p: NSPasteboard?, item: NSPasteboardItem,
                    provideDataForType type: NSPasteboard.PasteboardType) {}
}
let pb = NSPasteboard(name: NSPasteboard.Name("app.whisperflow.qa.recheck." + UUID().uuidString))
defer { pb.releaseGlobally() }
let missingType = NSPasteboard.PasteboardType("app.whisperflow.qa.missing")
let item = NSPasteboardItem()
let provider = EmptyProvider()
item.setString("synthetic", forType: .string)
item.setDataProvider(provider, forTypes: [missingType])
pb.clearContents()
guard pb.writeObjects([item]) else {
    print("privatePasteboardUnavailable=true")
    exit(2)
}
let snapshot = ClipboardSnapshot.capture(pb)
print("missingFormatSnapshotAccepted=\(snapshot != nil)")
'''


def run(directory: Path, name: str, code: str) -> str:
    path = directory / f"{name}.swift"
    path.write_text(code)
    result = subprocess.run(
        ["swift", "-module-cache-path", str(directory / "module-cache"), str(path)],
        text=True, capture_output=True, timeout=60, check=False,
    )
    print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="")
    if result.returncode:
        raise SystemExit(2)
    return result.stdout


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pasteboard", action="store_true", help="Also check a private named pasteboard.")
    args = parser.parse_args()
    if shutil.which("swift") is None:
        raise SystemExit("Swift is required.")
    with tempfile.TemporaryDirectory(prefix="whisper-flow-native-recheck-") as temp:
        directory = Path(temp)
        output = run(directory, "pure", pure_probe())
        passed = all(signature in output for signature in [
            "oneHourPasswordRefused=true",
            "backgroundHoldObserved=true laterPasswordRefused=true",
            "newHoldBetweenSamplesRefused=true",
            "ordinaryTerminalRefused=false secureTerminalRefused=true",
            "firstEscapeCancelled=true",
            "newHandsFreeEscapeCancelled=true swallowed=true",
            "slowReadOutcome=expired detail=clipboardRead clipboardMutated=false keysPosted=false",
        ])
        if args.pasteboard:
            clipboard = run(directory, "clipboard", clipboard_probe())
            passed = passed and "missingFormatSnapshotAccepted=false" in clipboard
        if not passed:
            print("FAIL: a native regression assertion failed.")
            raise SystemExit(1)
        print("PASS: all executed native policy checks passed.")


if __name__ == "__main__":
    main()
