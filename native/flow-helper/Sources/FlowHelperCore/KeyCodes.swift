/// macOS virtual key codes the helper needs to recognise.
public enum KeyCode {
    public static let escape = 53
    public static let space = 49
    public static let function = 63

    public static let leftCommand = 55
    public static let rightCommand = 54
    public static let leftShift = 56
    public static let rightShift = 60
    public static let leftOption = 58
    public static let rightOption = 61
    public static let leftControl = 59
    public static let rightControl = 62
    public static let capsLock = 57

    /// Synthetic key presses macOS sends after the Globe key, for "Show Emoji & Symbols"
    /// and "Start Dictation". They are not real keys and must not count as typing.
    public static let globeEmoji = 179
    public static let globeDictation = 176

    /// The keys that are held to form a shortcut. Caps Lock is not one of them: it is a
    /// lock, and its "down" lasts for as long as the light is on. Counted as held, it
    /// stopped every shortcut from matching while it was on.
    public static let modifiers: Set<Int> = [
        function, leftCommand, rightCommand, leftShift, rightShift,
        leftOption, rightOption, leftControl, rightControl,
    ]

    public static func isModifier(_ keyCode: Int) -> Bool {
        modifiers.contains(keyCode)
    }

    static let globeSynthetic: Set<Int> = [globeEmoji, globeDictation]
}
