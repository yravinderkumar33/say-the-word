/// Decides whether the focused field should be treated as a password field, which the
/// helper never pastes into.
///
/// There are two signals. The accessibility role is exact, but Chromium-based apps
/// (browsers, Electron apps) expose no focused element until something wakes their
/// accessibility tree. Those apps do switch on macOS Secure Event Input while a
/// password field has focus, so that is the second signal: Secure Event Input held by
/// the frontmost app itself.
///
/// Terminals are exempt from the second signal, because they hold Secure Event Input
/// for ordinary typing ("Secure Keyboard Entry") and have no password fields of the
/// web kind.
///
/// The second signal only counts while it is fresh. A password field holds Secure Event
/// Input for as long as someone is typing a password. macOS 26.5 has been reported to
/// leave it switched on after the lock screen, naming whichever app was in front, and
/// it then stays on until logout: taken at its word, that would refuse every dictation
/// into that app. Secure Event Input that has been on for longer than a password takes
/// to type is therefore treated as stuck, and ignored.
public enum SecureFieldPolicy {
    /// How long Secure Event Input may have been on and still mean "a password field".
    public static let freshFor: Double = 60

    public static let terminalBundleIds: Set<String> = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "net.kovidgoyal.kitty",
        "com.github.wez.wezterm",
        "org.alacritty",
        "co.zeit.hyper",
        "com.mitchellh.ghostty",
    ]

    public static func isSecure(
        elementIsSecure: Bool,
        secureInputEnabled: Bool,
        secureInputHolderPid: Int32?,
        secureInputHeldFor: Double = 0,
        frontmostPid: Int32,
        bundleId: String?
    ) -> Bool {
        reason(
            elementIsSecure: elementIsSecure,
            secureInputEnabled: secureInputEnabled,
            secureInputHolderPid: secureInputHolderPid,
            secureInputHeldFor: secureInputHeldFor,
            frontmostPid: frontmostPid,
            bundleId: bundleId
        ) != nil
    }

    /// True when the frontmost app holds Secure Event Input and has done for too long to
    /// be a password being typed. Reported so the log can say why the signal was ignored.
    public static func isStuck(
        secureInputEnabled: Bool,
        secureInputHolderPid: Int32?,
        secureInputHeldFor: Double,
        frontmostPid: Int32
    ) -> Bool {
        secureInputEnabled && secureInputHolderPid == frontmostPid && secureInputHeldFor > freshFor
    }

    /// Which signal marked the field as a password field: `element` (its accessibility
    /// role) or `secureInput` (Secure Event Input held by the frontmost app). Nil when
    /// it is not one. This is what the log shows when a paste is refused for it.
    public static func reason(
        elementIsSecure: Bool,
        secureInputEnabled: Bool,
        secureInputHolderPid: Int32?,
        secureInputHeldFor: Double = 0,
        frontmostPid: Int32,
        bundleId: String?
    ) -> String? {
        if elementIsSecure { return "element" }
        guard secureInputEnabled, let holder = secureInputHolderPid, holder == frontmostPid else {
            // Off, or held by some other app. Apps sometimes leave it on by mistake;
            // that must not stop dictation everywhere.
            return nil
        }
        if let bundleId, terminalBundleIds.contains(bundleId) { return nil }
        if secureInputHeldFor > freshFor { return nil }
        return "secureInput"
    }
}
