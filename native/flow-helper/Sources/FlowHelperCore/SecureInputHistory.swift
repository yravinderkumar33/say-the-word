/// Follows Secure Event Input readings for diagnostics about a possibly stale hold.
/// A holder still named after another app has been in front for a while may have left
/// the signal on. This does not prove that a later field is safe: a password field can
/// inherit the same signal, and a same-PID off/on transition can happen between samples.
/// `SecureFieldPolicy` never uses this history to permit automatic paste.
/// How long a foreground hold has lasted says nothing: a password field can sit
/// focused for an hour.
///
/// Pure state: the helper feeds it one reading a second, and one at every capture.
public struct SecureInputHistory: Sendable {
    /// How long the holder must be seen in the background, still holding, before the
    /// hold counts as left on. An app that is switched away from lets go within a
    /// moment; this is the margin for one that is slow to, or that is not answering
    /// for a few seconds and lets go only when it comes round.
    public static let backgroundProof: Double = 5

    private var holder: Int32?
    /// When the holder was first seen behind another app, in the current unbroken run
    /// of such readings.
    private var backgroundSince: Double?

    /// True when the named holder was seen holding while another app was in front.
    /// It stays true until an observed disable or holder change. Sampling can miss
    /// either transition, so this is not evidence that the current field is safe.
    public private(set) var leftOn = false

    public init() {}

    /// Apps that are in front when nobody is using an app at all. A hold seen behind
    /// one of these proves nothing: a password field that had the keyboard when the
    /// screen was locked still has it, and still holds Secure Event Input, underneath.
    public static let nobodyAtTheMac: Set<String> = [
        "com.apple.loginwindow",
        "com.apple.ScreenSaver.Engine",
    ]

    /// The app to count as being in front for a reading, or nil when the reading says
    /// nothing about that: nothing is in front, the screen is locked, another user has
    /// the console, or what is in front is the lock screen or the screen saver.
    public static func witness(frontmostPid: Int32?, bundleId: String?, sessionAway: Bool) -> Int32? {
        guard sessionAway == false, let frontmostPid, frontmostPid > 0 else { return nil }
        if let bundleId, nobodyAtTheMac.contains(bundleId) { return nil }
        return frontmostPid
    }

    /// One reading. `frontmost` is the app in front, or nil when that is not known or
    /// says nothing (see `witness`). `time` is in seconds on a clock that never goes back.
    public mutating func observe(enabled: Bool, holder: Int32?, frontmost: Int32?, at time: Double) {
        guard enabled, let holder else {
            // Off, or nobody can be named as holding it: nothing is known any more.
            self.holder = nil
            backgroundSince = nil
            leftOn = false
            return
        }
        if holder != self.holder {
            // A new hold. What was learned about the last one does not carry over.
            self.holder = holder
            backgroundSince = nil
            leftOn = false
        }
        guard leftOn == false else { return }
        guard let frontmost, frontmost != holder else {
            // In front, where a password field would be. Seen once behind another app
            // proves nothing either: that is what every switch between apps looks like.
            backgroundSince = nil
            return
        }
        guard let since = backgroundSince else {
            backgroundSince = time
            return
        }
        if time - since >= Self.backgroundProof { leftOn = true }
    }
}
