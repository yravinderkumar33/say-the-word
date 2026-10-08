import AppKit
import ApplicationServices
import FlowHelperCore
import Foundation

/// Where a paste may go: the app, window and focused element at one moment.
struct TargetSnapshot {
    let pid: pid_t
    /// The app's bundle id, or nil for something that has none (a command-line program).
    let bundleId: String?
    let window: AXUIElement?
    /// Nil when the app does not expose a focused element (a dormant Chromium tree, for example).
    let element: AXUIElement?
    /// Why the focused element counts as a password field (`element` or `secureInput`),
    /// or nil when it does not.
    let secureReason: String?
    /// Diagnostic history: this holder was seen keeping Secure Event Input on while
    /// another app was in front. It never overrides the current field's secure reason.
    let secureInputStuck: Bool

    var secure: Bool { secureReason != nil }
}

enum TargetComparison {
    case same
    /// What differs: `unknownTarget`, `nothingFrontmost`, `app`, `appNotAnswering`,
    /// `window` or `element`. It names a kind of difference only, never an app or its
    /// contents.
    case changed(String)
    /// The focus is now in a password field; the value says what marked it as one.
    case secure(String)
}

/// Records paste destinations and checks whether focus is still where it was.
/// Used from the main thread only.
final class TargetStore {
    private static let capacity = 8

    /// A hung app must not hang the helper, so every accessibility call is bounded.
    private static let messagingTimeout: Float = 0.3

    private var snapshots: [Int: TargetSnapshot] = [:]
    private var order: [Int] = []
    private var nextId = 1
    let secureInput = SecureInputWatch()

    init() {
        // Set on the system-wide element, the timeout is the process's default: every
        // element that has no timeout of its own uses it.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), Self.messagingTimeout)
    }

    /// Records the current destination and returns its id, or nil if nothing is frontmost.
    func capture() -> (id: Int, snapshot: TargetSnapshot)? {
        guard let snapshot = current() else { return nil }
        let id = nextId
        nextId += 1
        snapshots[id] = snapshot
        order.append(id)
        if order.count > Self.capacity {
            snapshots.removeValue(forKey: order.removeFirst())
        }
        return (id, snapshot)
    }

    /// Compares a recorded destination with where focus is now.
    ///
    /// App and window must match. The focused element must match when both snapshots
    /// have one; a snapshot without an element is compared on app and window alone.
    ///
    /// Whether the recorded app is still in front is asked of the app itself, every
    /// time. `NSWorkspace` learns which app is in front only when the helper's run loop
    /// turns: on 2026-10-04 it named Safari a second and a half after Finder had come
    /// forward, while the helper was busy with a slow clipboard. The app's own answer is
    /// true at the moment it is given.
    ///
    /// If the app does not answer: after a wait (`afterWait`) there is nothing else to
    /// go by, and the paste is refused; otherwise what `NSWorkspace` says, which is
    /// fresh at the start of a request, decides as it used to.
    func compare(targetId: Int, afterWait: Bool = false) -> TargetComparison {
        guard let saved = snapshots[targetId] else { return .changed("unknownTarget") }
        switch isFrontmost(saved.pid) {
        case true?: break
        case false?: return .changed("app")
        case nil: if afterWait { return .changed("appNotAnswering") }
        }
        guard let now = current() else { return .changed("nothingFrontmost") }
        if let reason = now.secureReason { return .secure(reason) }
        guard now.pid == saved.pid else { return .changed("app") }
        if let before = saved.window, let after = now.window, CFEqual(before, after) == false {
            return .changed("window")
        }
        if let before = saved.element, let after = now.element, CFEqual(before, after) == false {
            return .changed("element")
        }
        return .same
    }

    /// Reads the focused element through the frontmost app's own accessibility element.
    ///
    /// The system-wide element is not used: on macOS 26 its focused-element and
    /// focused-application queries fail with `cannotComplete` from a helper process,
    /// while the per-app queries work.
    func current() -> TargetSnapshot? {
        guard let frontmost = NSWorkspace.shared.frontmostApplication else { return nil }
        let pid = frontmost.processIdentifier
        // -1 is what an app that Launch Services cannot describe reports.
        guard pid > 0 else { return nil }
        let bundleId = Self.bundleId(of: frontmost)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)

        // The elements read from are also given the timeout as their own, which bounds
        // their reads whatever the default is.
        let element = copyElement(app, kAXFocusedUIElementAttribute)
        if let element { AXUIElementSetMessagingTimeout(element, Self.messagingTimeout) }
        let window = element.flatMap { copyElement($0, kAXWindowAttribute) }
            ?? copyElement(app, kAXFocusedWindowAttribute)

        let held = secureInput.sample(frontmost: pid, bundleId: bundleId)
        let secureReason = SecureFieldPolicy.reason(
            elementIsSecure: element.map(isSecureField) ?? false,
            secureInputEnabled: held != nil,
            secureInputHolderPid: held?.holder,
            frontmostPid: pid,
            bundleId: bundleId
        )
        let stuck = SecureFieldPolicy.isStuck(
            secureInputEnabled: held != nil,
            secureInputHolderPid: held?.holder,
            secureInputLeftOn: held?.leftOn ?? false,
            frontmostPid: pid
        )
        return TargetSnapshot(
            pid: pid,
            bundleId: bundleId,
            window: window,
            element: element,
            secureReason: secureReason,
            secureInputStuck: stuck
        )
    }

    /// Whether the app is in front, as the app itself says (its `AXFrontmost`). Unlike
    /// `NSWorkspace`, this does not depend on the helper's run loop having turned. Nil
    /// when the app does not answer in time.
    func isFrontmost(_ pid: pid_t) -> Bool? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, Self.messagingTimeout)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXFrontmostAttribute as CFString, &value) == .success
        else { return nil }
        return value as? Bool
    }

    /// The app's bundle id. Launch Services has been seen to answer nothing for an app
    /// that had just come to the front (2026-10-04, TextEdit), so when it does, the id
    /// is read from the bundle the process was started from.
    static func bundleId(of app: NSRunningApplication) -> String? {
        if let bundleId = app.bundleIdentifier { return bundleId }
        var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        guard proc_pidpath(app.processIdentifier, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        var url = URL(fileURLWithPath: String(cString: buffer))
        while url.path != "/" {
            if url.pathExtension == "app" { return Bundle(url: url)?.bundleIdentifier }
            url.deleteLastPathComponent()
        }
        return nil
    }

    private func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
              let value, CFGetTypeID(value) == AXUIElementGetTypeID()
        else { return nil }
        return (value as! AXUIElement)
    }

    private func copyString(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
            return nil
        }
        return value as? String
    }

    /// Judged by the element itself, never by the global Secure Event Input state:
    /// terminals switch that on for ordinary typing.
    private func isSecureField(_ element: AXUIElement) -> Bool {
        if copyString(element, kAXSubroleAttribute) == (kAXSecureTextFieldSubrole as String) {
            return true
        }
        return copyString(element, kAXRoleAttribute)?.contains("Secure") ?? false
    }
}
