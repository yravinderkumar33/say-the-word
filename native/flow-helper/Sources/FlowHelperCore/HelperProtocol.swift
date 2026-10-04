import Foundation

/// Constants and message builders for the JSON-lines protocol spoken with the app.
/// The TypeScript side of the same contract is `src/shared/helper-protocol.ts`.
public enum HelperProtocol {
    /// Bumped whenever a message changes shape. The app refuses a mismatch.
    public static let version = 2

    public static let helperVersion = "0.1.0"

    /// The first line the helper writes, so the app knows what it is talking to.
    public static func ready(accessibilityTrusted: Bool, tapInstalled: Bool) -> [String: Any] {
        [
            "type": "ready",
            "protocol": version,
            "accessibilityTrusted": accessibilityTrusted,
            "tapInstalled": tapInstalled,
        ]
    }

    public static func success(id: Int, result: [String: Any]) -> [String: Any] {
        ["id": id, "ok": true, "result": result]
    }

    public static func failure(id: Int, error: String) -> [String: Any] {
        ["id": id, "ok": false, "error": error]
    }

    /// A shortcut event. `t` is the key event's time in milliseconds since boot, so the
    /// app can measure holds without depending on how quickly messages are delivered.
    public static func event(_ event: MatcherEvent, t: Double, reason: String = "released") -> [String: Any] {
        switch event {
        case let .bindingDown(id):
            ["type": "bindingDown", "id": id, "t": t]
        case let .bindingUp(id):
            ["type": "bindingUp", "id": id, "t": t, "reason": reason]
        case let .interrupted(id):
            ["type": "interrupted", "id": id, "t": t]
        case .cancel:
            ["type": "cancel", "t": t]
        }
    }

    public static func tapState(installed: Bool, reason: String) -> [String: Any] {
        ["type": "tapState", "installed": installed, "reason": reason]
    }

    /// Sent once the clipboard has been restored, or deliberately left alone.
    public static func pasteSettled(pasteId: Int, restored: Bool) -> [String: Any] {
        ["type": "pasteSettled", "pasteId": pasteId, "restored": restored]
    }
}
