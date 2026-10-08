import CoreGraphics
import IOKit.hidsystem

/// Works out whether a modifier key went down or up from a `flagsChanged` event's flags.
///
/// The generic flags (Shift, Control, Option, Command) cannot tell the left key from the
/// right one: with both Control keys held, releasing one leaves the Control flag set.
/// macOS also sets device-specific bits in the low 16 bits of the raw flags, one per
/// physical key, and those decide when present.
///
/// The low 16 bits hold more than the per-key bits (0x100 marks an event that was not
/// coalesced), so "present" means one of the per-key bits, not any low bit. Events
/// posted by a program usually carry none of them, and for those the generic flag
/// decides. So it does for Fn, which has no per-key bit at all.
public enum ModifierState {
    static let deviceBits: [Int: UInt64] = [
        KeyCode.leftControl: UInt64(NX_DEVICELCTLKEYMASK),
        KeyCode.leftShift: UInt64(NX_DEVICELSHIFTKEYMASK),
        KeyCode.rightShift: UInt64(NX_DEVICERSHIFTKEYMASK),
        KeyCode.leftCommand: UInt64(NX_DEVICELCMDKEYMASK),
        KeyCode.rightCommand: UInt64(NX_DEVICERCMDKEYMASK),
        KeyCode.leftOption: UInt64(NX_DEVICELALTKEYMASK),
        KeyCode.rightOption: UInt64(NX_DEVICERALTKEYMASK),
        KeyCode.rightControl: UInt64(NX_DEVICERCTLKEYMASK),
    ]

    /// The flag each modifier key sets, whichever key of a pair it is. The test tool that
    /// posts key events sets the same ones.
    public static let genericBits: [Int: UInt64] = [
        KeyCode.leftShift: CGEventFlags.maskShift.rawValue,
        KeyCode.rightShift: CGEventFlags.maskShift.rawValue,
        KeyCode.leftControl: CGEventFlags.maskControl.rawValue,
        KeyCode.rightControl: CGEventFlags.maskControl.rawValue,
        KeyCode.leftOption: CGEventFlags.maskAlternate.rawValue,
        KeyCode.rightOption: CGEventFlags.maskAlternate.rawValue,
        KeyCode.leftCommand: CGEventFlags.maskCommand.rawValue,
        KeyCode.rightCommand: CGEventFlags.maskCommand.rawValue,
        KeyCode.function: CGEventFlags.maskSecondaryFn.rawValue,
    ]

    static let anyDeviceBit: UInt64 = deviceBits.values.reduce(0, |)

    public static func isDown(keyCode: Int, rawFlags: UInt64) -> Bool {
        if let device = deviceBits[keyCode], rawFlags & anyDeviceBit != 0 {
            return rawFlags & device != 0
        }
        guard let generic = genericBits[keyCode] else { return false }
        return rawFlags & generic != 0
    }

    /// The modifier keys these flags show to be up. Every key event carries the state of
    /// all the modifiers, so one event can tell that a key whose own release was never
    /// seen is no longer held. A flag that is set proves nothing (the other key of the
    /// pair may be the one that is down); a flag that is clear does.
    public static func released(rawFlags: UInt64) -> Set<Int> {
        let hasKeyBits = rawFlags & anyDeviceBit != 0
        var up: Set<Int> = []
        for (keyCode, generic) in genericBits {
            if rawFlags & generic == 0 {
                up.insert(keyCode)
            } else if hasKeyBits, let device = deviceBits[keyCode], rawFlags & device == 0 {
                up.insert(keyCode)
            }
        }
        return up
    }
}
