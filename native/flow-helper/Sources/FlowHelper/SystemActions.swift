import AppKit
import ApplicationServices
import Carbon.HIToolbox
import FlowHelperCore
import Foundation

/// The real implementation of the helper's requests. Called on the main thread.
final class SystemActions: HelperActions {
    private let tap: EventTap
    private let targets: TargetStore
    private let paster: PasteTransaction
    private let isTrusted: () -> Bool

    init(tap: EventTap, targets: TargetStore, paster: PasteTransaction, isTrusted: @escaping () -> Bool) {
        self.tap = tap
        self.targets = targets
        self.paster = paster
        self.isTrusted = isTrusted
    }

    func configure(bindings: [Binding]) -> [String: Any] {
        tap.configure(bindings)
        return ["bindings": bindings.count]
    }

    func armEscape(_ armed: Bool) -> [String: Any] {
        tap.armEscape(armed)
        return [:]
    }

    func installTap() -> [String: Any] {
        let trusted = isTrusted()
        return ["tapInstalled": trusted && tap.install(), "accessibilityTrusted": trusted]
    }

    func captureTarget() -> [String: Any] {
        guard let (id, snapshot) = targets.capture() else {
            // Nothing is frontmost. An id that matches nothing makes a later paste refuse.
            return ["targetId": -1, "secure": false, "hasElement": false]
        }
        var result: [String: Any] = [
            "targetId": id,
            "secure": snapshot.secure,
            "hasElement": snapshot.element != nil,
            "hasWindow": snapshot.window != nil,
        ]
        if let reason = snapshot.secureReason { result["secureReason"] = reason }
        if snapshot.secureInputStuck { result["secureInputStuck"] = true }
        if let bundleId = snapshot.bundleId { result["bundleId"] = bundleId }
        // Something with no bundle id can be frontmost (a command-line program that
        // opened a window, a system agent). Its process name is what there is to go on.
        let app = NSRunningApplication(processIdentifier: snapshot.pid)
        if let name = app?.localizedName ?? Self.processName(snapshot.pid) { result["appName"] = name }
        return result
    }

    private static func processName(_ pid: pid_t) -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
        return String(cString: buffer)
    }

    func paste(
        pasteId: Int, text: String, targetId: Int?, restoreDelayMs: Int, expiresAtMs: Double?
    ) -> [String: Any] {
        let result = paster.paste(
            pasteId: pasteId,
            text: text,
            targetId: targetId,
            restoreDelayMs: restoreDelayMs,
            expiresAtMs: expiresAtMs
        )
        var reply: [String: Any] = ["outcome": result.outcome]
        if let detail = result.detail { reply["detail"] = detail }
        return reply
    }

    func checkPermissions() -> [String: Any] {
        [
            "accessibilityTrusted": isTrusted(),
            "postEventAccess": PasteTransaction.mayPostEvents().allowed,
            "tapInstalled": tap.isInstalled,
            "secureInput": SecureInput.isEnabled,
        ]
    }

    func promptAccessibility() -> [String: Any] {
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        return ["accessibilityTrusted": AXIsProcessTrustedWithOptions(options)]
    }
}
