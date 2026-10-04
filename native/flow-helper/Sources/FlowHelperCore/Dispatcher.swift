import Foundation

/// The OS-facing work a request can ask for. The executable implements this with real
/// system calls; tests use a fake. Each method returns the reply's `result` object.
public protocol HelperActions {
    func configure(bindings: [Binding]) -> [String: Any]
    func armEscape(_ armed: Bool) -> [String: Any]
    func installTap() -> [String: Any]
    func captureTarget() -> [String: Any]
    func paste(pasteId: Int, text: String, targetId: Int?, restoreDelayMs: Int) -> [String: Any]
    func checkPermissions() -> [String: Any]
    func promptAccessibility() -> [String: Any]
}

/// Turns one request line into one reply line.
///
/// A request is a JSON object with an integer `id` and a string `type`. Anything else
/// on stdin is ignored rather than answered, because there is no id to answer to.
/// Requests are validated here, so the actions only ever see well-formed input.
public struct Dispatcher {
    /// Longest transcript accepted in one paste. A 20-minute dictation is far below this.
    public static let maxPasteCharacters = 200_000
    public static let maxBindings = 32
    public static let maxChordsPerBinding = 8
    public static let maxKeysPerChord = 4

    private let actions: any HelperActions

    public init(actions: any HelperActions) {
        self.actions = actions
    }

    public func reply(to line: String) -> String? {
        guard let request = JSONLines.decode(line),
              let id = JSONLines.integer(request["id"]),
              let type = request["type"] as? String
        else { return nil }

        switch handle(type: type, request: request) {
        case let .success(result):
            return JSONLines.encode(HelperProtocol.success(id: id, result: result))
        case let .failure(error):
            return JSONLines.encode(HelperProtocol.failure(id: id, error: error.message))
        }
    }

    struct RequestError: Error {
        let message: String
    }

    private func handle(type: String, request: [String: Any]) -> Result<[String: Any], RequestError> {
        switch type {
        case "ping":
            return .success(["pong": true])

        case "configure":
            guard let bindings = Self.parseBindings(request["bindings"]) else {
                return .failure(RequestError(message: "configure: bindings are missing or malformed"))
            }
            return .success(actions.configure(bindings: bindings))

        case "armEscape":
            guard let armed = request["armed"] as? Bool else {
                return .failure(RequestError(message: "armEscape: armed must be true or false"))
            }
            return .success(actions.armEscape(armed))

        case "installTap":
            return .success(actions.installTap())

        case "captureTarget":
            return .success(actions.captureTarget())

        case "paste":
            guard let pasteId = JSONLines.integer(request["pasteId"]) else {
                return .failure(RequestError(message: "paste: pasteId must be an integer"))
            }
            guard let text = request["text"] as? String, text.isEmpty == false else {
                return .failure(RequestError(message: "paste: text must be a non-empty string"))
            }
            guard text.count <= Self.maxPasteCharacters else {
                return .failure(RequestError(message: "paste: text is too long"))
            }
            let targetId: Int?
            if request["targetId"] == nil || request["targetId"] is NSNull {
                targetId = nil
            } else if let value = JSONLines.integer(request["targetId"]) {
                targetId = value
            } else {
                return .failure(RequestError(message: "paste: targetId must be an integer"))
            }
            let delay = JSONLines.integer(request["restoreDelayMs"]) ?? 500
            guard (0 ... 60_000).contains(delay) else {
                return .failure(RequestError(message: "paste: restoreDelayMs is out of range"))
            }
            return .success(actions.paste(pasteId: pasteId, text: text, targetId: targetId, restoreDelayMs: delay))

        case "checkPermissions":
            return .success(actions.checkPermissions())

        case "promptAccessibility":
            return .success(actions.promptAccessibility())

        default:
            return .failure(RequestError(message: "unknown request type: \(type)"))
        }
    }

    /// Accepts `[{ "id": "ptt", "chords": [[63]] }, …]`. Returns nil if anything is off,
    /// so a malformed table is rejected whole rather than half applied.
    static func parseBindings(_ value: Any?) -> [Binding]? {
        guard let list = value as? [[String: Any]], list.count <= maxBindings else { return nil }
        var bindings: [Binding] = []
        for item in list {
            guard let id = item["id"] as? String, id.isEmpty == false,
                  let rawChords = item["chords"] as? [[Any]],
                  rawChords.isEmpty == false, rawChords.count <= maxChordsPerBinding
            else { return nil }

            var chords: [Set<Int>] = []
            for rawChord in rawChords {
                let keys = rawChord.compactMap { JSONLines.integer($0) }
                guard keys.count == rawChord.count,
                      (1 ... maxKeysPerChord).contains(keys.count),
                      keys.allSatisfy({ (0 ... 255).contains($0) }),
                      Set(keys).count == keys.count
                else { return nil }
                chords.append(Set(keys))
            }
            bindings.append(Binding(id: id, chords: chords))
        }
        return bindings
    }
}
