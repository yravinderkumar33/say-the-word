import FlowHelperCore
import Testing

/// Stands in for the system: records which steps ran, and lets a step take time.
private final class FakeSystem {
    var calls: [String] = []
    var nowMs: Double = 1_000_000
    var allowed = true
    var keysCanBeMade = true
    /// What the destination check answers, one answer per call; nil once they run out.
    var refusals: [(outcome: String, detail: String?)?] = []
    var clipboardReadTakesMs: Double = 5
    var writingTakesMs: Double = 20
    /// How long the check of the destination takes when it follows a wait.
    var recheckTakesMs: Double = 0
    /// For each check of the destination: whether it was told that it follows a wait.
    var checkedAfterWait: [Bool] = []

    var steps: PasteSteps {
        PasteSteps(
            now: { self.nowMs },
            postAccess: {
                self.calls.append("postAccess")
                return (self.allowed, self.allowed ? "trusted" : "trusted=false preflight=false")
            },
            prepareKeys: {
                self.calls.append("prepareKeys")
                return self.keysCanBeMade
            },
            refusal: { afterWait in
                self.calls.append("refusal")
                self.checkedAfterWait.append(afterWait)
                if afterWait { self.nowMs += self.recheckTakesMs }
                return self.refusals.isEmpty ? nil : self.refusals.removeFirst()
            },
            settleEarlierPaste: { self.calls.append("settleEarlierPaste") },
            saveClipboard: {
                self.calls.append("saveClipboard")
                self.nowMs += self.clipboardReadTakesMs
            },
            writeText: {
                self.calls.append("writeText")
                self.nowMs += self.writingTakesMs
            },
            pressKeys: { self.calls.append("pressKeys") },
            takeTextBack: { self.calls.append("takeTextBack") },
            scheduleRestore: { self.calls.append("scheduleRestore") }
        )
    }

    /// The app stops waiting this long from now.
    func expiry(in ms: Double) -> Double { nowMs + ms }

    var touchedTheClipboard: Bool { calls.contains("writeText") }
    var pressedKeys: Bool { calls.contains("pressKeys") }
}

struct PasteSequenceTests {
    private let system = FakeSystem()

    @Test func aPasteRunsItsStepsInOrder() {
        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "pasted")
        #expect(result.detail == nil)
        #expect(system.calls == [
            "postAccess", "prepareKeys", "refusal", "settleEarlierPaste",
            "saveClipboard", "writeText", "pressKeys", "scheduleRestore",
        ])
    }

    @Test func aRequestReadAfterTheAppStoppedWaitingTouchesNothing() {
        let result = PasteSequence.run(system.steps, expiresAtMs: system.nowMs)

        #expect(result.outcome == "expired")
        #expect(result.detail == "onArrival")
        #expect(system.calls.isEmpty)
    }

    @Test func aClipboardReadThatOutlastsTheAppsWaitEndsThePasteBeforeAnythingIsWritten() {
        // Another app takes seven seconds to hand over what is on the clipboard; the
        // app gave up after four and has told the user the paste failed.
        system.clipboardReadTakesMs = 7_000

        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "expired")
        #expect(result.detail == "clipboardRead")
        #expect(system.touchedTheClipboard == false)
        #expect(system.pressedKeys == false)
        #expect(system.calls.last == "saveClipboard")
    }

    @Test func aSlowClipboardReadWithinTheTimeHasTheDestinationCheckedAgain() {
        system.clipboardReadTakesMs = 600
        system.refusals = [nil, ("targetChanged", "app")]

        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "targetChanged")
        #expect(result.detail == "app")
        #expect(system.touchedTheClipboard == false)
        #expect(system.pressedKeys == false)
    }

    @Test func aSlowClipboardReadWithinTheTimeStillPastesWhenFocusHasNotMoved() {
        system.clipboardReadTakesMs = 600

        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "pasted")
        #expect(system.calls.filter { $0 == "refusal" }.count == 2)
    }

    @Test func theCheckAfterASlowReadIsToldThatWhatItKnowsMayBeOld() {
        system.clipboardReadTakesMs = 600

        _ = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        // The first check runs on fresh knowledge of the app in front; the second
        // follows a wait and must ask afresh.
        #expect(system.checkedAfterWait == [false, true])
    }

    @Test func timeRunningOutWhileTheDestinationIsCheckedAgainLeavesTheClipboardAlone() {
        // The clipboard comes back just inside the time, and the app in front is then
        // slow to say whether it still is.
        system.clipboardReadTakesMs = 3_900
        system.recheckTakesMs = 1_500

        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "expired")
        #expect(result.detail == "destinationCheck")
        #expect(system.touchedTheClipboard == false)
        #expect(system.calls.contains("takeTextBack") == false)
        #expect(system.pressedKeys == false)
    }

    @Test func aQuickClipboardReadChecksTheDestinationOnce() {
        _ = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(system.calls.filter { $0 == "refusal" }.count == 1)
    }

    @Test func timeRunningOutAfterTheTextIsWrittenTakesItBackAndPressesNothing() {
        system.writingTakesMs = 5_000

        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "expired")
        #expect(result.detail == "beforeKeys")
        #expect(system.pressedKeys == false)
        #expect(system.calls.suffix(2) == ["writeText", "takeTextBack"])
    }

    @Test func withoutPermissionToPostKeysNothingIsTouched() {
        system.allowed = false

        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "noPostAccess")
        #expect(result.detail == "trusted=false preflight=false")
        #expect(system.calls == ["postAccess"])
    }

    @Test func aKeyPressThatCannotBeMadeLeavesTheClipboardAlone() {
        system.keysCanBeMade = false

        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "noPostAccess")
        #expect(result.detail == "keyEvent")
        #expect(system.calls == ["postAccess", "prepareKeys"])
    }

    @Test func aRefusedDestinationLeavesTheClipboardAlone() {
        system.refusals = [("secureField", "element")]

        let result = PasteSequence.run(system.steps, expiresAtMs: system.expiry(in: 4_000))

        #expect(result.outcome == "secureField")
        #expect(result.detail == "element")
        #expect(system.calls == ["postAccess", "prepareKeys", "refusal"])
    }

    @Test func aRequestWithNoExpiryIsNeverCalledOffForTime() {
        system.clipboardReadTakesMs = 60_000

        let result = PasteSequence.run(system.steps, expiresAtMs: nil)

        #expect(result.outcome == "pasted")
    }
}
