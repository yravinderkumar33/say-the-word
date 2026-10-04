import AppKit
import ApplicationServices
import FlowHelperCore
import Foundation

/// Command-line tools for testing the helper. They exist so that automated tests can
/// drive the real event tap, and so the Globe-key behaviour can be observed.
///
/// They are refused unless FLOW_HELPER_TEST_TOOLS=1 is set, and macOS lets them do
/// anything only when the calling terminal or app already holds Accessibility.
enum TestTools {
    static var isEnabled: Bool {
        ProcessInfo.processInfo.environment["FLOW_HELPER_TEST_TOOLS"] == "1"
    }

    /// For the test of a first launch: with `FLOW_HELPER_GRANT_AFTER_MS` set, the helper
    /// behaves for that long after it starts as if Accessibility had not been granted
    /// yet. Returns the moment from which the real answer is given.
    static func pretendedGrantTime(startedAt: Date = Date()) -> Date {
        guard isEnabled,
              let text = ProcessInfo.processInfo.environment["FLOW_HELPER_GRANT_AFTER_MS"],
              let milliseconds = Double(text), milliseconds > 0
        else { return startedAt }
        return startedAt.addingTimeInterval(milliseconds / 1_000)
    }

    /// Posts key events as if they came from the keyboard.
    ///
    /// `script` is a comma-separated list of steps: `63:down`, `63:up`, `wait:300`.
    /// Modifier keys are posted as `flagsChanged` events, other keys as key down/up.
    ///
    /// Events are spaced a few milliseconds apart, and the tool waits a moment after
    /// the last one. Posted in one burst from a process that then exits at once, the
    /// final event was sometimes never delivered: a chord's last "key up" went missing,
    /// and everything listening believed the key was still held.
    static func postKeys(_ script: String) -> Int32 {
        guard CGPreflightPostEventAccess() else {
            FileHandle.standardError.write(Data("post-keys: no permission to post key events\n".utf8))
            return 2
        }
        let source = CGEventSource(stateID: .hidSystemState)
        var flags: UInt64 = 0

        for step in script.split(separator: ",") {
            let parts = step.split(separator: ":")
            guard parts.count == 2, let value = Int(parts[0] == "wait" ? parts[1] : parts[0]) else {
                FileHandle.standardError.write(Data("post-keys: bad step \(step)\n".utf8))
                return 64
            }
            if parts[0] == "wait" {
                usleep(UInt32(value) * 1000)
                continue
            }
            let isDown = parts[1] == "down"
            guard isDown || parts[1] == "up",
                  let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(value), keyDown: isDown)
            else {
                FileHandle.standardError.write(Data("post-keys: bad step \(step)\n".utf8))
                return 64
            }
            if KeyCode.isModifier(value) {
                let bit = genericFlag(for: value)
                flags = isDown ? flags | bit : flags & ~bit
                event.type = .flagsChanged
            }
            event.flags = CGEventFlags(rawValue: flags)
            event.post(tap: .cghidEventTap)
            usleep(postGapMicroseconds)
        }
        usleep(lingerMicroseconds)
        return 0
    }

    /// Between two key events. A fast typist's keys are further apart than this.
    private static let postGapMicroseconds: UInt32 = 4_000
    /// After the last event, before the process (and its connection to the window server) goes.
    private static let lingerMicroseconds: UInt32 = 60_000

    /// Prints the key events around the Globe key for `seconds`, to study how macOS
    /// treats it. Ordinary keys are reported only as "other", never by key code.
    static func census(seconds: Int) -> Int32 {
        let mask = (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: CGEventMask(mask),
            callback: censusCallback,
            userInfo: nil
        ) else {
            FileHandle.standardError.write(Data("census: could not create an event tap (no permission)\n".utf8))
            return 2
        }
        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: port, enable: true)
        print("census: listening for \(seconds) s")
        CFRunLoopRunInMode(.defaultMode, CFTimeInterval(seconds), false)
        print("census: done")
        return 0
    }

    /// Prints the role and text of the focused element as JSON, so a test can check
    /// what a paste actually put into the target app.
    static func focusedValue() -> Int32 {
        let front = NSWorkspace.shared.frontmostApplication
        let bundleId = front?.bundleIdentifier ?? ""
        var focused: CFTypeRef?
        guard let pid = front?.processIdentifier,
              AXUIElementCopyAttributeValue(
                  AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute as CFString, &focused
              ) == .success,
              let focused, CFGetTypeID(focused) == AXUIElementGetTypeID()
        else {
            print(JSONLines.encode(["found": false, "bundleId": bundleId]) ?? "{}")
            return 1
        }
        let element = focused as! AXUIElement
        var role: CFTypeRef?
        var value: CFTypeRef?
        AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &role)
        AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
        print(JSONLines.encode([
            "found": true,
            "bundleId": bundleId,
            "role": (role as? String) ?? "",
            "value": (value as? String) ?? "",
        ]) ?? "{}")
        return 0
    }

    private static func genericFlag(for keyCode: Int) -> UInt64 {
        switch keyCode {
        case KeyCode.function: 0x0080_0000
        case KeyCode.leftCommand, KeyCode.rightCommand: 0x0010_0000
        case KeyCode.leftOption, KeyCode.rightOption: 0x0008_0000
        case KeyCode.leftControl, KeyCode.rightControl: 0x0004_0000
        case KeyCode.leftShift, KeyCode.rightShift: 0x0002_0000
        default: 0
        }
    }
}

private func censusCallback(
    proxy _: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo _: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
    let reportable = KeyCode.isModifier(keyCode)
        || keyCode == KeyCode.globeEmoji || keyCode == KeyCode.globeDictation
    let kind = switch type {
    case .flagsChanged: "flagsChanged"
    case .keyDown: "keyDown"
    case .keyUp: "keyUp"
    default: "other(\(type.rawValue))"
    }
    let key = reportable ? String(keyCode) : "other"
    let time = Double(event.timestamp) / 1_000_000
    print(String(format: "%.1f %@ key=%@ flags=0x%08llx", time, kind, key, event.flags.rawValue))
    fflush(stdout)
    return Unmanaged.passUnretained(event)
}
