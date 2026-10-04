import Carbon.HIToolbox
import CoreGraphics
import FlowHelperCore
import Foundation
import IOKit

/// Reads the state of macOS Secure Event Input.
enum SecureInput {
    static var isEnabled: Bool {
        IsSecureEventInputEnabled()
    }

    /// The process the system names for Secure Event Input, from the I/O Registry, or
    /// nil when it is off or cannot be read. That is the app that was in front when it
    /// was switched on, which need not be the process that switched it on.
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

/// Samples Secure Event Input, retaining diagnostic history about possibly stale
/// holds. History cannot establish whether the current field is safe. Read once a
/// second and at every capture. Main thread only.
final class SecureInputWatch {
    private var history = SecureInputHistory()

    /// Takes a reading, given the app in front. Returns the holder and whether earlier
    /// samples saw it holding in the background, or nil while Secure Event Input is off.
    @discardableResult
    func sample(frontmost: pid_t?, bundleId: String?) -> (holder: pid_t?, leftOn: Bool)? {
        let enabled = SecureInput.isEnabled
        let holder = enabled ? SecureInput.holderPid() : nil
        // Who is in front only matters while there is a hold to judge.
        let witness = enabled
            ? SecureInputHistory.witness(
                frontmostPid: frontmost, bundleId: bundleId, sessionAway: Self.sessionIsAway
            )
            : nil
        history.observe(
            enabled: enabled,
            holder: holder,
            frontmost: witness,
            // Stands still while the Mac sleeps, so a nap is never taken for proof.
            at: ProcessInfo.processInfo.systemUptime
        )
        return enabled ? (holder, history.leftOn) : nil
    }

    /// True while nobody can be using an app: the screen is locked, or another user has
    /// the console. If the session cannot be read, it is taken to be away.
    private static var sessionIsAway: Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
        if (session["CGSSessionScreenIsLocked"] as? Bool) == true { return true }
        if (session[kCGSessionOnConsoleKey as String] as? Bool) == false { return true }
        return false
    }
}
