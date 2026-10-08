/// Decides whether the focused field should be treated as a password field, which the
/// helper never pastes into.
///
/// There are two signals. The accessibility role is exact, but Chromium-based apps
/// (browsers, Electron apps) expose no focused element until something wakes their
/// accessibility tree. Those apps do switch on macOS Secure Event Input while a
/// password field has focus, so that is the second signal: Secure Event Input for which
/// the system names the frontmost app.
///
/// The app the system names is the one that was in front when Secure Event Input was
/// switched on, whichever process switched it on, and the name stays while the hold
/// lasts (checked on 2026-10-04 with a background process and two apps). So a name
/// that is not the frontmost app's says nothing about the field in front.
///
/// Terminals are exempt from the second signal, because they hold Secure Event Input
/// for ordinary typing ("Secure Keyboard Entry") and have no password fields of the
/// web kind.
///
/// Historical evidence that Secure Event Input was left on cannot establish whether
/// the current field is safe. A later password field, or a disable/re-enable entirely
/// between samples, can have the same holder. Apart from the terminal exception, the
/// current signal therefore always refuses automatic paste, however long the hold has
/// lasted. The text is offered for copying instead, including for an ordinary field
/// whose app has left Secure Event Input on. History is diagnostic only.
public enum SecureFieldPolicy {
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
        frontmostPid: Int32,
        bundleId: String?
    ) -> Bool {
        reason(
            elementIsSecure: elementIsSecure,
            secureInputEnabled: secureInputEnabled,
            secureInputHolderPid: secureInputHolderPid,
            frontmostPid: frontmostPid,
            bundleId: bundleId
        ) != nil
    }

    /// True when the frontmost app holds Secure Event Input and an earlier reading
    /// saw that holder in the background. Diagnostic only: this does not establish
    /// whether the current hold is the same one or whether the current field is safe.
    public static func isStuck(
        secureInputEnabled: Bool,
        secureInputHolderPid: Int32?,
        secureInputLeftOn: Bool,
        frontmostPid: Int32
    ) -> Bool {
        secureInputEnabled && secureInputHolderPid == frontmostPid && secureInputLeftOn
    }

    /// Which signal marked the field as a password field: `element` (its accessibility
    /// role) or `secureInput` (Secure Event Input held by the frontmost app). Nil when
    /// it is not one. This is what the log shows when a paste is refused for it.
    /// It is given no history: what earlier readings saw (`isStuck`) never relaxes it.
    public static func reason(
        elementIsSecure: Bool,
        secureInputEnabled: Bool,
        secureInputHolderPid: Int32?,
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
        return "secureInput"
    }
}
