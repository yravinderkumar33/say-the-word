#!/usr/bin/env python3
"""Reproduce native QA findings using extracts from the current production source.

Exit 0 means the recorded defects reproduced; it does not mean the app is correct.
No production files, keyboard events, app focus, or general clipboard are touched.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / "native/flow-helper/Sources"


def source(path: str) -> str:
    return (NATIVE / path).read_text()


def secure_probe() -> str:
    return source("FlowHelperCore/SecureFieldPolicy.swift") + r'''

for elapsed in [59.0, 60.0, 61.0] {
    let secure = SecureFieldPolicy.isSecure(
        elementIsSecure: false,
        secureInputEnabled: true,
        secureInputHolderPid: 501,
        secureInputHeldFor: elapsed,
        frontmostPid: 501,
        bundleId: "com.google.Chrome"
    )
    print("passwordFocusedFor=\(elapsed) refused=\(secure)")
}
'''


def escape_probe() -> str:
    return (
        source("FlowHelperCore/KeyCodes.swift")
        + "\n"
        + source("FlowHelperCore/BindingMatcher.swift")
        + r'''

var matcher = BindingMatcher(bindings: [
    Binding(id: "ptt", chords: [[63]]),
    Binding(id: "handsFree", chords: [[63, 49]])
])
// The first hands-free session has no keys held.
matcher.armEscape(true)
let first = matcher.keyDown(keyCode: 53, isRepeat: false)
print("firstEscapeCancelled=\(first.events.contains(.cancel))")
matcher.armEscape(false)
// Start another session before releasing that Escape.
_ = matcher.modifierChanged(keyCode: 63, isDown: true)
matcher.armEscape(true)
_ = matcher.keyDown(keyCode: 49, isRepeat: false)
_ = matcher.keyUp(keyCode: 49)
_ = matcher.modifierChanged(keyCode: 63, isDown: false)
// The old Escape release must not disarm the newer session.
_ = matcher.keyUp(keyCode: 53)
let second = matcher.keyDown(keyCode: 53, isRepeat: false)
print("newHandsFreeEscapeCancelled=\(second.events.contains(.cancel)) swallowed=\(second.swallow)")
'''
    )


def clipboard_probe() -> str:
    production = source("FlowHelper/PasteTransaction.swift")
    constants = []
    for name in ("snapshotByteBudget", "snapshotTimeBudget"):
        match = re.search(rf"^    private static let {name}\b[^\n]*", production, re.M)
        if not match:
            raise RuntimeError(f"Production constant {name} not found; update extractor.")
        constants.append(match.group(0))
    start = production.index("    private func snapshot(")
    end = production.index("    /// The Cmd+V key press", start)
    # The method body is unchanged; only visibility permits calling the extract.
    method = production[start:end].replace("private func snapshot(", "func snapshot(", 1)
    return (
        "import AppKit\nimport Foundation\n\nfinal class SnapshotHarness {\n"
        + "\n".join(constants)
        + "\n"
        + method
        + r'''
}

final class EmptyProvider: NSObject, NSPasteboardItemDataProvider {
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem,
                    provideDataForType type: NSPasteboard.PasteboardType) {}
}

final class SlowProvider: NSObject, NSPasteboardItemDataProvider {
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem,
                    provideDataForType type: NSPasteboard.PasteboardType) {
        Thread.sleep(forTimeInterval: 0.6)
        item.setData(Data([1]), forType: type)
    }
}

let harness = SnapshotHarness()
// Only this UUID-named pasteboard is used, never NSPasteboard.general.
let pb = NSPasteboard(name: NSPasteboard.Name("app.whisperflow.qa.snapshot." + UUID().uuidString))
defer { pb.releaseGlobally() }
let missingType = NSPasteboard.PasteboardType("app.whisperflow.qa.missing")

let item = NSPasteboardItem()
let provider = EmptyProvider()
item.setData(Data([1, 2, 3]), forType: .string)
item.setDataProvider(provider, forTypes: [missingType])
pb.clearContents()
guard pb.writeObjects([item]) else {
    fputs("Private pasteboard unavailable, possibly restricted by the sandbox. No result.\n", stderr)
    exit(2)
}
let partial = harness.snapshot(pb)
print("nilReadSnapshotAccepted=\(partial != nil) declaredTypes=\(item.types.count) savedTypes=\(partial?.first?.count ?? -1)")

let slowItem = NSPasteboardItem()
let slowProvider = SlowProvider()
slowItem.setDataProvider(slowProvider, forTypes: [missingType])
pb.clearContents()
guard pb.writeObjects([slowItem]) else {
    fputs("Private pasteboard unavailable. No result.\n", stderr)
    exit(2)
}
let began = Date()
let slow = harness.snapshot(pb)
print("slowSnapshotAccepted=\(slow != nil) elapsedMs=\(Int(Date().timeIntervalSince(began) * 1000))")
'''
    )


def run_probe(directory: Path, name: str, content: str, expected: list[str]) -> None:
    path = directory / f"{name}.swift"
    path.write_text(content)
    result = subprocess.run(
        ["swift", "-module-cache-path", str(directory / "module-cache"), str(path)],
        text=True,
        capture_output=True,
        timeout=60,
        check=False,
    )
    print(f"[{name}]", flush=True)
    print(result.stdout, end="", flush=True)
    if result.stderr:
        print(result.stderr, end="", flush=True)
    if result.returncode:
        raise SystemExit(result.returncode)
    for signature in expected:
        if signature not in result.stdout:
            raise SystemExit(
                f"Recorded defect signature missing: {signature!r}. "
                "The implementation may have changed; inspect the output."
            )
    print("Recorded defect reproduced.", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pasteboard",
        action="store_true",
        help="Run only the private named-pasteboard probe; macOS pasteboard access required.",
    )
    args = parser.parse_args()
    if shutil.which("swift") is None:
        raise SystemExit("Swift is required (the project's normal macOS Swift toolchain).")
    # Source extracts and compiler caches are temporary and removed after the run.
    with tempfile.TemporaryDirectory(prefix="whisper-flow-native-audit-") as temp:
        directory = Path(temp)
        if args.pasteboard:
            run_probe(
                directory,
                "clipboard",
                clipboard_probe(),
                [
                    "nilReadSnapshotAccepted=true declaredTypes=2 savedTypes=1",
                    "slowSnapshotAccepted=true",
                ],
            )
        else:
            run_probe(
                directory,
                "secure",
                secure_probe(),
                [
                    "passwordFocusedFor=59.0 refused=true",
                    "passwordFocusedFor=60.0 refused=true",
                    "passwordFocusedFor=61.0 refused=false",
                ],
            )
            run_probe(
                directory,
                "escape",
                escape_probe(),
                [
                    "firstEscapeCancelled=true",
                    "newHandsFreeEscapeCancelled=false swallowed=false",
                ],
            )


if __name__ == "__main__":
    main()
