import FlowHelperCore
import Testing

/// Records what the dispatcher asked for, in place of real system calls.
final class FakeActions: HelperActions {
    struct Paste: Equatable {
        let pasteId: Int
        let text: String
        let targetId: Int?
        let restoreDelayMs: Int
        var expiresAtMs: Double?
    }

    var configured: [[Binding]] = []
    var armed: [Bool] = []
    var pastes: [Paste] = []
    var calls: [String] = []

    func configure(bindings: [Binding]) -> [String: Any] {
        configured.append(bindings)
        return ["bindings": bindings.count]
    }

    func armEscape(_ armed: Bool) -> [String: Any] {
        self.armed.append(armed)
        return [:]
    }

    func installTap() -> [String: Any] {
        calls.append("installTap")
        return ["tapInstalled": true]
    }

    func captureTarget() -> [String: Any] {
        calls.append("captureTarget")
        return ["targetId": 41, "secure": false]
    }

    func paste(
        pasteId: Int, text: String, targetId: Int?, restoreDelayMs: Int, expiresAtMs: Double?
    ) -> [String: Any] {
        pastes.append(Paste(
            pasteId: pasteId,
            text: text,
            targetId: targetId,
            restoreDelayMs: restoreDelayMs,
            expiresAtMs: expiresAtMs
        ))
        return ["outcome": "pasted"]
    }

    func checkPermissions() -> [String: Any] {
        calls.append("checkPermissions")
        return ["accessibilityTrusted": true]
    }

    func promptAccessibility() -> [String: Any] {
        calls.append("promptAccessibility")
        return ["accessibilityTrusted": false]
    }
}

struct DispatcherTests {
    let actions = FakeActions()
    let sut: Dispatcher

    init() {
        sut = Dispatcher(actions: actions)
    }

    /// Sends a request and returns the decoded reply, failing the test if there is none.
    private func reply(_ line: String, sourceLocation: SourceLocation = #_sourceLocation) throws -> [String: Any] {
        let reply = try #require(sut.reply(to: line), sourceLocation: sourceLocation)
        return try #require(JSONLines.decode(reply), sourceLocation: sourceLocation)
    }

    // MARK: Envelope

    @Test func answersPingWithTheRequestId() throws {
        let object = try reply(#"{"id":12,"type":"ping"}"#)

        #expect(object["id"] as? Int == 12)
        #expect(object["ok"] as? Bool == true)
        let result = try #require(object["result"] as? [String: Any])
        #expect(result["pong"] as? Bool == true)
    }

    @Test func reportsAnUnknownRequestTypeAsAFailure() throws {
        let object = try reply(#"{"id":5,"type":"launchMissiles"}"#)

        #expect(object["id"] as? Int == 5)
        #expect(object["ok"] as? Bool == false)
        #expect(object["error"] as? String == "unknown request type: launchMissiles")
    }

    @Test(arguments: [
        "not json",
        #"{"type":"ping"}"#,
        #"{"id":"7","type":"ping"}"#,
        #"{"id":true,"type":"ping"}"#,
        #"{"id":3}"#,
        #"{"id":3,"type":42}"#,
    ])
    func ignoresLinesThatAreNotRequests(line: String) {
        #expect(sut.reply(to: line) == nil, "Without an integer id and a type there is nothing to answer.")
    }

    // MARK: configure

    @Test func configurePassesTheParsedShortcutTableToTheActions() throws {
        let object = try reply(
            #"{"id":1,"type":"configure","bindings":[{"id":"ptt","chords":[[63]]},{"id":"pasteLast","chords":[[55,59,9],[54,59,9]]}]}"#
        )

        #expect(object["ok"] as? Bool == true)
        #expect(actions.configured == [[
            Binding(id: "ptt", chords: [[63]]),
            Binding(id: "pasteLast", chords: [[55, 59, 9], [54, 59, 9]]),
        ]])
    }

    @Test func configureAcceptsAnEmptyTable() throws {
        let object = try reply(#"{"id":1,"type":"configure","bindings":[]}"#)

        #expect(object["ok"] as? Bool == true)
        #expect(actions.configured == [[]])
    }

    @Test(arguments: [
        #"{"id":1,"type":"configure"}"#,
        #"{"id":1,"type":"configure","bindings":"ptt"}"#,
        #"{"id":1,"type":"configure","bindings":[{"chords":[[63]]}]}"#,
        #"{"id":1,"type":"configure","bindings":[{"id":"","chords":[[63]]}]}"#,
        #"{"id":1,"type":"configure","bindings":[{"id":"ptt","chords":[]}]}"#,
        #"{"id":1,"type":"configure","bindings":[{"id":"ptt","chords":[[]]}]}"#,
        #"{"id":1,"type":"configure","bindings":[{"id":"ptt","chords":[["fn"]]}]}"#,
        #"{"id":1,"type":"configure","bindings":[{"id":"ptt","chords":[[63,63]]}]}"#,
        #"{"id":1,"type":"configure","bindings":[{"id":"ptt","chords":[[999]]}]}"#,
        #"{"id":1,"type":"configure","bindings":[{"id":"ptt","chords":[[1,2,3,4,5]]}]}"#,
    ])
    func configureRejectsAMalformedTableWithoutApplyingAnyOfIt(line: String) throws {
        let object = try reply(line)

        #expect(object["ok"] as? Bool == false)
        #expect(actions.configured.isEmpty)
    }

    // MARK: armEscape

    @Test(arguments: [true, false])
    func armEscapePassesTheFlagThrough(armed: Bool) throws {
        let object = try reply(#"{"id":2,"type":"armEscape","armed":\#(armed)}"#)

        #expect(object["ok"] as? Bool == true)
        #expect(actions.armed == [armed])
    }

    @Test func armEscapeRequiresABoolean() throws {
        let object = try reply(#"{"id":2,"type":"armEscape","armed":"yes"}"#)

        #expect(object["ok"] as? Bool == false)
        #expect(actions.armed.isEmpty)
    }

    // MARK: paste

    @Test func pastePassesItsFieldsThrough() throws {
        let object = try reply(#"{"id":3,"type":"paste","pasteId":9,"text":"Hello.","targetId":41,"restoreDelayMs":750}"#)

        let result = try #require(object["result"] as? [String: Any])
        #expect(result["outcome"] as? String == "pasted")
        #expect(actions.pastes == [FakeActions.Paste(pasteId: 9, text: "Hello.", targetId: 41, restoreDelayMs: 750)])
    }

    @Test func pasteDefaultsToAHalfSecondRestoreAndNoTarget() throws {
        _ = try reply(#"{"id":3,"type":"paste","pasteId":9,"text":"Hello."}"#)

        #expect(actions.pastes == [FakeActions.Paste(pasteId: 9, text: "Hello.", targetId: nil, restoreDelayMs: 500)])
    }

    @Test func pastePassesOnWhenTheAppStopsWaiting() throws {
        _ = try reply(#"{"id":3,"type":"paste","pasteId":9,"text":"Hello.","expiresAt":1791100000123}"#)

        #expect(actions.pastes.first?.expiresAtMs == 1_791_100_000_123)
    }

    @Test func pasteWithoutAnExpiryHasNone() throws {
        _ = try reply(#"{"id":3,"type":"paste","pasteId":9,"text":"Hello.","expiresAt":null}"#)

        #expect(actions.pastes.count == 1)
        #expect(actions.pastes.first?.expiresAtMs == nil)
    }

    @Test func pasteKeepsNewlinesAndUnicodeIntact() throws {
        _ = try reply(#"{"id":3,"type":"paste","pasteId":1,"text":"Line one\nLine two — café 你好"}"#)

        #expect(actions.pastes.first?.text == "Line one\nLine two — café 你好")
    }

    @Test(arguments: [
        #"{"id":3,"type":"paste","text":"Hello."}"#,
        #"{"id":3,"type":"paste","pasteId":"9","text":"Hello."}"#,
        #"{"id":3,"type":"paste","pasteId":9}"#,
        #"{"id":3,"type":"paste","pasteId":9,"text":""}"#,
        #"{"id":3,"type":"paste","pasteId":9,"text":42}"#,
        #"{"id":3,"type":"paste","pasteId":9,"text":"Hello.","targetId":"41"}"#,
        #"{"id":3,"type":"paste","pasteId":9,"text":"Hello.","restoreDelayMs":-1}"#,
        #"{"id":3,"type":"paste","pasteId":9,"text":"Hello.","restoreDelayMs":999999}"#,
        #"{"id":3,"type":"paste","pasteId":9,"text":"Hello.","expiresAt":"soon"}"#,
        #"{"id":3,"type":"paste","pasteId":9,"text":"Hello.","expiresAt":true}"#,
    ])
    func pasteRejectsMalformedRequestsWithoutPasting(line: String) throws {
        let object = try reply(line)

        #expect(object["ok"] as? Bool == false)
        #expect(actions.pastes.isEmpty)
    }

    @Test func pasteRejectsTextBeyondTheLimit() throws {
        let tooLong = String(repeating: "a", count: Dispatcher.maxPasteCharacters + 1)

        let object = try reply(#"{"id":3,"type":"paste","pasteId":9,"text":"\#(tooLong)"}"#)

        #expect(object["ok"] as? Bool == false)
        #expect(actions.pastes.isEmpty)
    }

    // MARK: Requests with no fields

    @Test(arguments: ["installTap", "captureTarget", "checkPermissions", "promptAccessibility"])
    func routesFieldlessRequestsToTheirAction(type: String) throws {
        let object = try reply(#"{"id":4,"type":"\#(type)"}"#)

        #expect(object["ok"] as? Bool == true)
        #expect(actions.calls == [type])
    }

    @Test func returnsTheActionsResultUnchanged() throws {
        let object = try reply(#"{"id":4,"type":"captureTarget"}"#)

        let result = try #require(object["result"] as? [String: Any])
        #expect(result["targetId"] as? Int == 41)
        #expect(result["secure"] as? Bool == false)
    }
}
