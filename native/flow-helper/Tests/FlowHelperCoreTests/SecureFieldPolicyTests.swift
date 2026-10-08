import FlowHelperCore
import Testing

struct SecureFieldPolicyTests {
    static let browser: Int32 = 501
    static let otherApp: Int32 = 777

    @Test func aSecureElementIsAlwaysSecure() {
        let secure = SecureFieldPolicy.isSecure(
            elementIsSecure: true,
            secureInputEnabled: false,
            secureInputHolderPid: nil,
            frontmostPid: Self.browser,
            bundleId: "com.apple.TextEdit"
        )

        #expect(secure == true)
    }

    @Test func secureInputHeldByTheFrontmostAppMeansAPasswordField() {
        let secure = SecureFieldPolicy.isSecure(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.brave.Browser"
        )

        #expect(secure == true, "Chromium apps expose no focused element, so this is the only signal.")
    }

    @Test func secureInputLeftOnByAnotherAppDoesNotBlockDictation() {
        let secure = SecureFieldPolicy.isSecure(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.otherApp,
            frontmostPid: Self.browser,
            bundleId: "com.brave.Browser"
        )

        #expect(secure == false)
    }

    @Test func secureInputWithNoKnownHolderDoesNotBlockDictation() {
        let secure = SecureFieldPolicy.isSecure(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: nil,
            frontmostPid: Self.browser,
            bundleId: "com.brave.Browser"
        )

        #expect(secure == false)
    }

    @Test(arguments: ["com.apple.Terminal", "com.googlecode.iterm2", "com.mitchellh.ghostty"])
    func aTerminalHoldingSecureInputIsNotAPasswordField(bundleId: String) {
        let secure = SecureFieldPolicy.isSecure(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: bundleId
        )

        #expect(secure == false, "Terminals hold Secure Event Input for ordinary typing.")
    }

    @Test func nothingSecureMeansNotSecure() {
        let secure = SecureFieldPolicy.isSecure(
            elementIsSecure: false,
            secureInputEnabled: false,
            secureInputHolderPid: nil,
            frontmostPid: Self.browser,
            bundleId: nil
        )

        #expect(secure == false)
    }

    @Test func theReasonNamesTheSignalThatFired() {
        let byRole = SecureFieldPolicy.reason(
            elementIsSecure: true,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.brave.Browser"
        )
        let bySecureInput = SecureFieldPolicy.reason(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.brave.Browser"
        )
        let terminal = SecureFieldPolicy.reason(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.googlecode.iterm2"
        )

        #expect(byRole == "element")
        #expect(bySecureInput == "secureInput")
        #expect(terminal == nil)
    }

    @Test func secureInputLeftOnStillRefusesAnAmbiguousCurrentField() {
        let reason = SecureFieldPolicy.reason(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.microsoft.VSCode"
        )
        let stuck = SecureFieldPolicy.isStuck(
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            secureInputLeftOn: true,
            frontmostPid: Self.browser
        )

        #expect(reason == "secureInput", "History cannot prove that the current field is safe.")
        #expect(stuck == true)
    }

    @Test func aPasswordFieldFocusedForAnHourIsStillRefused() {
        // What the helper sees while someone leaves a browser's password field focused:
        // one reading a second, the browser in front and holding Secure Event Input.
        var history = SecureInputHistory()
        for second in stride(from: 0.0, through: 3_600, by: 1) {
            history.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: second)
        }

        let reason = SecureFieldPolicy.reason(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.brave.Browser"
        )
        let stuck = SecureFieldPolicy.isStuck(
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            secureInputLeftOn: history.leftOn,
            frontmostPid: Self.browser
        )

        #expect(reason == "secureInput", "Time alone is no evidence that the hold is stuck.")
        #expect(stuck == false)
    }

    @Test func returningToAPasswordFieldAfterABackgroundHoldIsRefused() {
        var history = SecureInputHistory()
        history.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 0)
        for second in stride(from: 1.0, through: 6, by: 1) {
            history.observe(enabled: true, holder: Self.browser, frontmost: Self.otherApp, at: second)
        }
        history.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 7)

        let reason = SecureFieldPolicy.reason(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.google.Chrome"
        )

        #expect(history.leftOn == true, "The diagnostic marker was set by the background hold.")
        #expect(reason == "secureInput", "The newly focused password field exposes no secure AX role.")
    }

    @Test func aSamePidHoldRestartBetweenSamplesCannotInheritAPasteExemption() {
        var history = SecureInputHistory()
        history.observe(enabled: true, holder: Self.browser, frontmost: Self.otherApp, at: 0)
        history.observe(enabled: true, holder: Self.browser, frontmost: Self.otherApp, at: 5)
        // A disable and re-enable by this PID can happen before the next sample.
        // Neither event reaches the watcher; a new password field looks like the
        // previous hold. That ambiguity must still refuse automatic paste.
        history.observe(enabled: true, holder: Self.browser, frontmost: Self.browser, at: 6)

        let secure = SecureFieldPolicy.isSecure(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.google.Chrome"
        )

        #expect(history.leftOn == true, "Sampling cannot distinguish the old hold from a new one.")
        #expect(secure == true)
    }

    @Test func aPasswordFieldByRoleIsRefusedEvenWhenSecureInputWasLeftOn() {
        let reason = SecureFieldPolicy.reason(
            elementIsSecure: true,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.apple.Safari"
        )

        #expect(reason == "element")
    }

    @Test func theTerminalExceptionNeverOverridesASecureElement() {
        let reason = SecureFieldPolicy.reason(
            elementIsSecure: true,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            frontmostPid: Self.browser,
            bundleId: "com.apple.Terminal"
        )

        #expect(reason == "element")
    }
}
