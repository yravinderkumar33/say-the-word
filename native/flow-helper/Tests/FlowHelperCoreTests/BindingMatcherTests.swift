import FlowHelperCore
import Testing

struct BindingMatcherTests {
    static let fn = KeyCode.function
    static let space = KeyCode.space
    static let escape = KeyCode.escape
    static let command = KeyCode.leftCommand
    static let control = KeyCode.leftControl
    static let letterV = 9
    static let leftArrow = 123

    static let bindings = [
        Binding(id: "ptt", chords: [[fn]]),
        Binding(id: "handsfree", chords: [[fn, space]]),
        Binding(id: "command", chords: [[fn, control]]),
        Binding(id: "pasteLast", chords: [[command, control, letterV]]),
    ]

    var sut = BindingMatcher(bindings: BindingMatcherTests.bindings)

    // MARK: Push-to-talk

    @Test mutating func holdingFnStartsAndEndsPushToTalk() {
        let down = sut.modifierChanged(keyCode: Self.fn, isDown: true)
        let up = sut.modifierChanged(keyCode: Self.fn, isDown: false)

        #expect(down == MatcherDecision(events: [.bindingDown("ptt")], swallow: true))
        #expect(up == MatcherDecision(events: [.bindingUp("ptt")], swallow: true))
    }

    @Test mutating func aRepeatedFnDownIsNotASecondPress() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        let again = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        #expect(again == MatcherDecision(swallow: true))
    }

    @Test mutating func fnPressedWithAnotherModifierHeldDoesNotStartPushToTalk() {
        _ = sut.modifierChanged(keyCode: KeyCode.leftShift, isDown: true)

        let down = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        #expect(down.events.isEmpty, "Push-to-talk needs Fn alone at the moment it is pressed.")
    }

    // MARK: Chords

    @Test mutating func spaceWhileHoldingFnStartsHandsFreeAndIsSwallowed() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        let down = sut.keyDown(keyCode: Self.space, isRepeat: false)
        let up = sut.keyUp(keyCode: Self.space)

        #expect(down == MatcherDecision(events: [.bindingDown("handsfree")], swallow: true))
        #expect(up == MatcherDecision(events: [.bindingUp("handsfree")], swallow: true))
    }

    @Test mutating func autoRepeatOfASwallowedKeyIsSwallowedSilently() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)
        _ = sut.keyDown(keyCode: Self.space, isRepeat: false)

        let repeated = sut.keyDown(keyCode: Self.space, isRepeat: true)

        #expect(repeated == MatcherDecision(swallow: true))
    }

    @Test mutating func spaceAloneIsOrdinaryTyping() {
        let down = sut.keyDown(keyCode: Self.space, isRepeat: false)
        let up = sut.keyUp(keyCode: Self.space)

        #expect(down == MatcherDecision())
        #expect(up == MatcherDecision())
    }

    @Test mutating func releasingFnEndsEveryBindingThatUsesIt() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)
        _ = sut.keyDown(keyCode: Self.space, isRepeat: false)

        let up = sut.modifierChanged(keyCode: Self.fn, isDown: false)

        #expect(up.events == [.bindingUp("ptt"), .bindingUp("handsfree")])
    }

    @Test mutating func controlWhileHoldingFnStartsCommandOnTopOfPushToTalk() {
        let fnDown = sut.modifierChanged(keyCode: Self.fn, isDown: true)
        let controlDown = sut.modifierChanged(keyCode: Self.control, isDown: true)

        #expect(fnDown.events == [.bindingDown("ptt")])
        #expect(controlDown == MatcherDecision(events: [.bindingDown("command")], swallow: false))
    }

    @Test mutating func controlBeforeFnStartsOnlyCommand() {
        _ = sut.modifierChanged(keyCode: Self.control, isDown: true)

        let fnDown = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        #expect(fnDown == MatcherDecision(events: [.bindingDown("command")], swallow: true))
    }

    @Test mutating func pasteLastSwallowsOnlyTheLetter() {
        let commandDown = sut.modifierChanged(keyCode: Self.command, isDown: true)
        let controlDown = sut.modifierChanged(keyCode: Self.control, isDown: true)
        let letterDown = sut.keyDown(keyCode: Self.letterV, isRepeat: false)
        let letterUp = sut.keyUp(keyCode: Self.letterV)

        #expect(commandDown == MatcherDecision())
        #expect(controlDown == MatcherDecision())
        #expect(letterDown == MatcherDecision(events: [.bindingDown("pasteLast")], swallow: true))
        #expect(letterUp == MatcherDecision(events: [.bindingUp("pasteLast")], swallow: true))
    }

    @Test mutating func theOrdinaryPasteShortcutPassesThroughUntouched() {
        _ = sut.modifierChanged(keyCode: Self.command, isDown: true)

        let down = sut.keyDown(keyCode: Self.letterV, isRepeat: false)
        let up = sut.keyUp(keyCode: Self.letterV)

        #expect(down == MatcherDecision())
        #expect(up == MatcherDecision())
    }

    @Test mutating func rightHandModifiersAreDifferentKeys() {
        _ = sut.modifierChanged(keyCode: KeyCode.rightCommand, isDown: true)
        _ = sut.modifierChanged(keyCode: Self.control, isDown: true)

        let down = sut.keyDown(keyCode: Self.letterV, isRepeat: false)

        #expect(down == MatcherDecision(), "The chord was defined with the left Command key.")
    }

    // MARK: Interruptions

    @Test mutating func anotherKeyWhileHoldingFnInterruptsOncePerHold() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        let first = sut.keyDown(keyCode: Self.leftArrow, isRepeat: false)
        let second = sut.keyDown(keyCode: 124, isRepeat: false)

        #expect(first == MatcherDecision(events: [.interrupted("ptt")], swallow: false))
        #expect(second == MatcherDecision())
    }

    @Test mutating func aNewHoldCanBeInterruptedAgain() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)
        _ = sut.keyDown(keyCode: Self.leftArrow, isRepeat: false)
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: false)
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        let again = sut.keyDown(keyCode: Self.leftArrow, isRepeat: false)

        #expect(again.events == [.interrupted("ptt")])
    }

    @Test mutating func typingWithNoBindingHeldReportsNothing() {
        let down = sut.keyDown(keyCode: 0, isRepeat: false)
        let up = sut.keyUp(keyCode: 0)

        #expect(down == MatcherDecision())
        #expect(up == MatcherDecision())
    }

    @Test(arguments: [KeyCode.globeEmoji, KeyCode.globeDictation])
    mutating func globeSyntheticKeysAreSwallowedWithoutInterrupting(keyCode: Int) {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        let down = sut.keyDown(keyCode: keyCode, isRepeat: false)
        let up = sut.keyUp(keyCode: keyCode)

        #expect(down == MatcherDecision(swallow: true))
        #expect(up == MatcherDecision(swallow: true))
    }

    // MARK: Escape

    @Test mutating func escapeIsOrdinaryTypingUntilArmed() {
        let down = sut.keyDown(keyCode: Self.escape, isRepeat: false)
        let up = sut.keyUp(keyCode: Self.escape)

        #expect(down == MatcherDecision())
        #expect(up == MatcherDecision())
    }

    @Test mutating func armedEscapeCancelsAndIsSwallowedForOneWholePress() {
        sut.armEscape(true)

        let down = sut.keyDown(keyCode: Self.escape, isRepeat: false)
        let repeated = sut.keyDown(keyCode: Self.escape, isRepeat: true)
        let up = sut.keyUp(keyCode: Self.escape)
        let nextPress = sut.keyDown(keyCode: Self.escape, isRepeat: false)

        #expect(down == MatcherDecision(events: [.cancel], swallow: true))
        #expect(repeated == MatcherDecision(swallow: true))
        #expect(up == MatcherDecision(swallow: true))
        #expect(nextPress == MatcherDecision(), "Escape disarms itself after one press.")
    }

    @Test mutating func disarmingWhileEscapeIsHeldStillSwallowsItsRelease() {
        sut.armEscape(true)
        _ = sut.keyDown(keyCode: Self.escape, isRepeat: false)
        sut.armEscape(false)

        let up = sut.keyUp(keyCode: Self.escape)

        #expect(up == MatcherDecision(swallow: true), "The key-down was dropped, so the key-up must be too.")
    }

    @Test mutating func anEscapeStillHeldFromTheLastSessionDoesNotDisarmTheNextOne() {
        // The first session is cancelled with Escape, and Escape is kept down.
        sut.armEscape(true)
        _ = sut.keyDown(keyCode: Self.escape, isRepeat: false)
        sut.armEscape(false)

        // A hands-free session starts and arms Escape again; only then is the old press let go.
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)
        _ = sut.keyDown(keyCode: Self.space, isRepeat: false)
        sut.armEscape(true)
        _ = sut.keyUp(keyCode: Self.space)
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: false)
        let oldRelease = sut.keyUp(keyCode: Self.escape)
        let newPress = sut.keyDown(keyCode: Self.escape, isRepeat: false)
        let newRelease = sut.keyUp(keyCode: Self.escape)

        #expect(oldRelease == MatcherDecision(swallow: true), "Its key-down was dropped.")
        #expect(newPress == MatcherDecision(events: [.cancel], swallow: true))
        #expect(newRelease == MatcherDecision(swallow: true))
    }

    @Test mutating func aRepeatOfTheEscapeThatCancelledIsNotASecondCancel() {
        sut.armEscape(true)
        _ = sut.keyDown(keyCode: Self.escape, isRepeat: false)
        // The next session arms Escape while the key is still down and repeating.
        sut.armEscape(true)

        let repeated = sut.keyDown(keyCode: Self.escape, isRepeat: true)

        #expect(repeated == MatcherDecision(swallow: true))
    }

    // MARK: Reset and reconfiguration

    @Test mutating func resetEndsActiveBindingsAndForgetsKeyState() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)
        _ = sut.keyDown(keyCode: Self.space, isRepeat: false)

        let ended = sut.reset()
        let lateRelease = sut.modifierChanged(keyCode: Self.fn, isDown: false)

        #expect(ended == [.bindingUp("ptt"), .bindingUp("handsfree")])
        #expect(lateRelease == MatcherDecision())
    }

    @Test mutating func configureReplacesTheShortcutTable() {
        sut.configure([Binding(id: "pasteLast", chords: [[Self.command, Self.control, Self.letterV]])])

        let fnDown = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        #expect(fnDown == MatcherDecision(), "Fn is no longer bound, so it is neither reported nor swallowed.")
    }

    @Test mutating func releasingAKeyThatWasNeverPressedIsHarmless() {
        let modifierUp = sut.modifierChanged(keyCode: Self.fn, isDown: false)
        let keyUp = sut.keyUp(keyCode: Self.space)

        #expect(modifierUp == MatcherDecision())
        #expect(keyUp == MatcherDecision())
    }

    @Test mutating func configureEndsAShortcutThatWasDown() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        let ended = sut.configure(Self.bindings)
        let lateRelease = sut.modifierChanged(keyCode: Self.fn, isDown: false)

        #expect(ended == [.bindingUp("ptt")], "The new table would never report this release.")
        #expect(lateRelease == MatcherDecision())
    }

    // MARK: A release that was never seen

    @Test mutating func aStaleModifierStopsFnFromMatchingUntilItIsForgotten() {
        // Command went down, and its release never arrived.
        _ = sut.modifierChanged(keyCode: Self.command, isDown: true)
        let blocked = sut.modifierChanged(keyCode: Self.fn, isDown: true)
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: false)

        sut.forget([Self.command])
        let works = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        #expect(blocked.events.isEmpty, "Command plus Fn is not the push-to-talk chord.")
        #expect(works == MatcherDecision(events: [.bindingDown("ptt")], swallow: true))
    }

    @Test mutating func forgettingDoesNotEndAShortcutThatIsDown() {
        _ = sut.modifierChanged(keyCode: Self.fn, isDown: true)

        sut.forget([Self.fn, Self.command])
        let release = sut.modifierChanged(keyCode: Self.fn, isDown: false)

        #expect(release == MatcherDecision(events: [.bindingUp("ptt")], swallow: true))
    }

    @Test func capsLockIsNotAHeldKey() {
        #expect(KeyCode.isModifier(KeyCode.capsLock) == false, "Its down lasts as long as the light is on.")
    }
}
