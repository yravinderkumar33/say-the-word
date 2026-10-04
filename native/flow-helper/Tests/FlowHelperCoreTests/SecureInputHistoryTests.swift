import FlowHelperCore
import Testing

struct SecureInputHistoryTests {
    static let browser: Int32 = 501
    static let editor: Int32 = 777
    /// How long a hold must be seen behind another app.
    static let proof = SecureInputHistory.backgroundProof

    var sut = SecureInputHistory()

    @Test mutating func aHoldByTheAppInFrontIsNeverLeftOnHoweverLongItLasts() {
        for second in stride(from: 0.0, through: 3_600, by: 1) {
            sut.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: second)
        }

        #expect(sut.leftOn == false)
    }

    @Test mutating func aHoldThatOutlastsItsAppBeingInFrontWasLeftOn() {
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10 + Self.proof - 1)
        let justShort = sut.leftOn
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10 + Self.proof)

        #expect(justShort == false)
        #expect(sut.leftOn == true)
    }

    @Test mutating func anAppThatIsOnlySlowToLetGoIsNotTakenForOneThatLeftItOn() {
        // Switched away from, and busy for a few seconds before it gets round to
        // letting go. Then it does, and the user comes back to its password field.
        for second in stride(from: 10.0, through: 13, by: 1) {
            sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: second)
        }
        sut.observe(enabled: false, holder: nil, frontmost: Self.editor, at: 14)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 15)

        #expect(sut.leftOn == false)
    }

    @Test mutating func itStaysLeftOnWhenItsAppComesBackToTheFront() {
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10 + Self.proof)

        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 11 + Self.proof)

        #expect(sut.leftOn == true, "Diagnostic history persists; it says nothing about the current field.")
    }

    @Test mutating func oneReadingBehindAnotherAppProvesNothing() {
        // What switching away from a focused password field looks like for an instant.
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 10)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10.4)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 11)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 30)

        #expect(sut.leftOn == false, "The two readings behind another app are not one unbroken stretch.")
    }

    @Test mutating func readingsCloseTogetherAreNotProof() {
        // A capture and the check before the paste can be milliseconds apart.
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10.01)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10.02)

        #expect(sut.leftOn == false)
    }

    @Test mutating func switchingItOffForgetsWhatWasLearned() {
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10 + Self.proof)
        #expect(sut.leftOn == true)

        sut.observe(enabled: false, holder: nil, frontmost: Self.editor, at: 11 + Self.proof)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 12 + Self.proof)

        #expect(sut.leftOn == false, "A new hold may be a password field.")
    }

    @Test mutating func aNewHolderStartsFromNothing() {
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10 + Self.proof)
        #expect(sut.leftOn == true)

        sut.observe(enabled: true, holder: Self.editor, frontmost: Self.editor, at: 11 + Self.proof)

        #expect(sut.leftOn == false)
    }

    @Test mutating func aHoldNobodyCanBeNamedForIsNotJudged() {
        sut.observe(enabled: true, holder: nil, frontmost: Self.editor, at: 10)
        sut.observe(enabled: true, holder: nil, frontmost: Self.editor, at: 20)

        #expect(sut.leftOn == false)
    }

    @Test mutating func aPasswordFieldLeftFocusedBehindTheLockScreenIsStillOne() {
        // The browser's password field has the keyboard when the screen is locked. The
        // browser is never switched away from, so it goes on holding Secure Event Input
        // underneath, for however long the Mac stays locked.
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 0)
        for second in stride(from: 1.0, through: 600, by: 1) {
            let lockScreen = SecureInputHistory.witness(
                frontmostPid: 99, bundleId: "com.apple.loginwindow", sessionAway: true
            )
            sut.observe(enabled: true, holder: Self.browser, frontmost: lockScreen, at: second)
        }
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 601)

        #expect(sut.leftOn == false)
    }

    @Test func aReadingSaysNothingWhileNobodyCanBeUsingAnApp() {
        let editor = SecureInputHistory.witness(
            frontmostPid: Self.editor, bundleId: "com.microsoft.VSCode", sessionAway: false
        )
        let locked = SecureInputHistory.witness(
            frontmostPid: Self.editor, bundleId: "com.microsoft.VSCode", sessionAway: true
        )
        let lockScreen = SecureInputHistory.witness(
            frontmostPid: 99, bundleId: "com.apple.loginwindow", sessionAway: false
        )
        let screenSaver = SecureInputHistory.witness(
            frontmostPid: 98, bundleId: "com.apple.ScreenSaver.Engine", sessionAway: false
        )
        let nothing = SecureInputHistory.witness(frontmostPid: nil, bundleId: nil, sessionAway: false)
        let unknownApp = SecureInputHistory.witness(frontmostPid: -1, bundleId: nil, sessionAway: false)
        let noBundle = SecureInputHistory.witness(frontmostPid: 4_242, bundleId: nil, sessionAway: false)

        #expect(editor == Self.editor)
        #expect(locked == nil)
        #expect(lockScreen == nil)
        #expect(screenSaver == nil)
        #expect(nothing == nil)
        #expect(unknownApp == nil)
        #expect(noBundle == 4_242, "A program with no bundle id is still an app in front.")
    }

    @Test mutating func timeBehindTheLockScreenDoesNotCountTowardsTheProof() {
        // Behind another app for a little less than the proof takes, then the screen
        // locks for an hour, then behind that app for as long again: never long enough
        // on end.
        let short = Self.proof - 1
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 10 + short)
        sut.observe(enabled: true, holder: Self.browser, frontmost: nil, at: 11 + short)
        sut.observe(enabled: true, holder: Self.browser, frontmost: nil, at: 3_600)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 3_601)
        sut.observe(enabled: true, holder: Self.browser, frontmost: Self.editor, at: 3_601 + short)

        #expect(sut.leftOn == false)
    }

    @Test mutating func withNothingInFrontThereIsNoEvidence() {
        sut.observe(enabled: true, holder: Self.browser, frontmost: nil, at: 10)
        sut.observe(enabled: true, holder: Self.browser, frontmost: nil, at: 20)

        #expect(sut.leftOn == false)
    }
}
