import FlowHelperCore
import Foundation
import Testing

struct JSONLinesTests {
    @Test func encodesAnObjectAsOneLineWithSortedKeys() throws {
        let line = try #require(JSONLines.encode(["text": "first\nsecond", "id": 7]))

        #expect(line == #"{"id":7,"text":"first\nsecond"}"#)
        #expect(line.contains("\n") == false, "A raw newline would split one message into two.")
    }

    @Test func encodesBooleansAsJSONBooleans() throws {
        let line = try #require(JSONLines.encode(["ok": true, "restored": false]))

        #expect(line == #"{"ok":true,"restored":false}"#)
    }

    @Test func decodesAnObject() throws {
        let object = try #require(JSONLines.decode(#"{"id":3,"type":"ping","nested":{"a":[1,2]}}"#))

        #expect(object["id"] as? Int == 3)
        #expect(object["type"] as? String == "ping")
        let nested = try #require(object["nested"] as? [String: Any])
        #expect(nested["a"] as? [Int] == [1, 2])
    }

    @Test(arguments: ["", "not json", "[1,2,3]", "42", #""text""#, #"{"unterminated": "#])
    func decodeRejectsAnythingThatIsNotAnObject(line: String) {
        #expect(JSONLines.decode(line) == nil)
    }

    @Test func integerAcceptsWholeNumbers() {
        #expect(JSONLines.integer(JSONLines.decode(#"{"id":12}"#)?["id"]) == 12)
        #expect(JSONLines.integer(JSONLines.decode(#"{"id":-4}"#)?["id"]) == -4)
    }

    @Test(arguments: [#"{"id":true}"#, #"{"id":"7"}"#, #"{"id":1.5}"#, #"{"id":null}"#, "{}"])
    func integerRejectsEverythingElse(line: String) throws {
        let object = try #require(JSONLines.decode(line))

        #expect(JSONLines.integer(object["id"]) == nil)
    }
}
