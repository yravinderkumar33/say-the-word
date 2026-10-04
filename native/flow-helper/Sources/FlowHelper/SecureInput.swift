import Carbon.HIToolbox
import Foundation
import IOKit

/// Reads the state of macOS Secure Event Input.
enum SecureInput {
    static var isEnabled: Bool {
        IsSecureEventInputEnabled()
    }

    /// The process that switched Secure Event Input on, from the I/O Registry, or nil
    /// when it is off or cannot be read.
    static func holderPid() -> pid_t? {
        let root = IORegistryGetRootEntry(kIOMainPortDefault)
        defer { IOObjectRelease(root) }
        guard let property = IORegistryEntryCreateCFProperty(
            root, "IOConsoleUsers" as CFString, kCFAllocatorDefault, 0
        )?.takeRetainedValue(),
            let users = property as? [[String: Any]]
        else { return nil }

        for user in users {
            if let pid = user["kCGSSessionSecureInputPID"] as? Int {
                return pid_t(pid)
            }
        }
        return nil
    }
}

/// Follows Secure Event Input over time, so that one left switched on (see
/// `SecureFieldPolicy`) can be told from one a password field has just switched on.
/// Sampled once a second and at every capture. Main thread only.
final class SecureInputWatch {
    private var holder: pid_t?
    private var since: Date?

    func sample(now: Date = Date()) {
        guard SecureInput.isEnabled else {
            holder = nil
            since = nil
            return
        }
        let current = SecureInput.holderPid()
        if since == nil || current != holder {
            holder = current
            since = now
        }
    }

    /// The holder and how long it has held Secure Event Input, or nil while it is off.
    func state(now: Date = Date()) -> (holder: pid_t?, heldFor: TimeInterval)? {
        sample(now: now)
        guard let since else { return nil }
        return (holder, now.timeIntervalSince(since))
    }
}
