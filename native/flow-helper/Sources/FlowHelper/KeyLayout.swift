import Carbon.HIToolbox
import CoreGraphics
import Foundation

/// Finds which physical key types a character under the user's keyboard layout.
/// The paste shortcut is Cmd plus whichever key produces "v": on Dvorak that is not
/// the key a QWERTY keyboard labels V.
enum KeyLayout {
    /// The key code for "v" on a QWERTY layout, used when the layout cannot be read.
    static let qwertyV: CGKeyCode = 9

    static func keyCode(for character: String) -> CGKeyCode? {
        // The current layout first; for a non-Latin layout, macOS resolves Cmd shortcuts
        // through the ASCII-capable layout, so that is the fallback.
        let sources = [
            TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
            TISCopyCurrentASCIICapableKeyboardLayoutInputSource()?.takeRetainedValue(),
        ]
        for source in sources.compactMap({ $0 }) {
            if let keyCode = keyCode(for: character, in: source) { return keyCode }
        }
        return nil
    }

    private static func keyCode(for character: String, in source: TISInputSource) -> CGKeyCode? {
        guard let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else {
            return nil
        }
        let layoutData = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue() as Data
        let keyboardType = UInt32(LMGetKbdType())

        // The shortcut is pressed with Command held, and some layouts change under it
        // ("Dvorak – QWERTY ⌘" types QWERTY while Command is down). So the key is looked
        // for with Command first, and without it only if that finds nothing.
        let commandHeld = UInt32((cmdKey >> 8) & 0xFF)
        let noDeadKeys = OptionBits(1 << kUCKeyTranslateNoDeadKeysBit)

        return layoutData.withUnsafeBytes { buffer -> CGKeyCode? in
            guard let layout = buffer.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else {
                return nil
            }
            for modifiers in [commandHeld, 0] {
                for keyCode in UInt16(0) ..< 128 {
                    var deadKeyState: UInt32 = 0
                    var length = 0
                    var characters = [UniChar](repeating: 0, count: 4)
                    let status = UCKeyTranslate(
                        layout,
                        keyCode,
                        UInt16(kUCKeyActionDown),
                        modifiers,
                        keyboardType,
                        noDeadKeys,
                        &deadKeyState,
                        characters.count,
                        &length,
                        &characters
                    )
                    guard status == noErr, length > 0 else { continue }
                    if String(utf16CodeUnits: characters, count: length).lowercased() == character {
                        return CGKeyCode(keyCode)
                    }
                }
            }
            return nil
        }
    }
}
