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

    @Test func secureInputThatHasBeenOnTooLongIsStuckNotAPasswordField() {
        let fresh = SecureFieldPolicy.reason(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            secureInputHeldFor: 5,
            frontmostPid: Self.browser,
            bundleId: "com.microsoft.VSCode"
        )
        let stale = SecureFieldPolicy.reason(
            elementIsSecure: false,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            secureInputHeldFor: SecureFieldPolicy.freshFor + 1,
            frontmostPid: Self.browser,
            bundleId: "com.microsoft.VSCode"
        )
        let stuck = SecureFieldPolicy.isStuck(
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            secureInputHeldFor: SecureFieldPolicy.freshFor + 1,
            frontmostPid: Self.browser
        )

        #expect(fresh == "secureInput")
        #expect(stale == nil, "macOS can leave it on after the lock screen; that must not stop dictation.")
        #expect(stuck == true)
    }

    @Test func aPasswordFieldByRoleIsRefusedHoweverLongSecureInputHasBeenOn() {
        let reason = SecureFieldPolicy.reason(
            elementIsSecure: true,
            secureInputEnabled: true,
            secureInputHolderPid: Self.browser,
            secureInputHeldFor: 10_000,
            frontmostPid: Self.browser,
            bundleId: "com.apple.Safari"
        )

        #expect(reason == "element")
    }
}
