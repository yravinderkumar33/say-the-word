import FlowHelperCore
import Testing

struct ModifierStateTests {
    static let controlFlag: UInt64 = 0x0004_0000
    static let commandFlag: UInt64 = 0x0010_0000
    static let functionFlag: UInt64 = 0x0080_0000
    static let leftControlDevice: UInt64 = 0x0001
    static let rightControlDevice: UInt64 = 0x2000
    static let leftCommandDevice: UInt64 = 0x0008

    @Test func functionKeyFollowsTheSecondaryFnFlag() {
        #expect(ModifierState.isDown(keyCode: KeyCode.function, rawFlags: Self.functionFlag) == true)
        #expect(ModifierState.isDown(keyCode: KeyCode.function, rawFlags: 0) == false)
    }

    @Test func usesTheDeviceBitWhenOneIsPresent() {
        let leftControlHeld = Self.controlFlag | Self.leftControlDevice

        #expect(ModifierState.isDown(keyCode: KeyCode.leftControl, rawFlags: leftControlHeld) == true)
        #expect(ModifierState.isDown(keyCode: KeyCode.rightControl, rawFlags: leftControlHeld) == false)
    }

    @Test func theNotCoalescedBitIsNotMistakenForAKeyBit() {
        // Nearly every event carries 0x100. An event posted by a program has it and no
        // per-key bit, so the generic flag must still decide.
        let notCoalesced: UInt64 = 0x0100

        #expect(ModifierState.isDown(keyCode: KeyCode.leftCommand, rawFlags: Self.commandFlag | notCoalesced) == true)
        #expect(ModifierState.isDown(keyCode: KeyCode.rightControl, rawFlags: Self.controlFlag | notCoalesced) == true)
        #expect(ModifierState.isDown(keyCode: KeyCode.leftCommand, rawFlags: notCoalesced) == false)
        #expect(ModifierState.isDown(keyCode: KeyCode.function, rawFlags: notCoalesced) == false)
    }

    @Test func releasingOneOfTwoHeldControlKeysIsSeenAsARelease() {
        // Both were held; the left one was released. The generic Control flag is still set.
        let onlyRightStillHeld = Self.controlFlag | Self.rightControlDevice

        #expect(ModifierState.isDown(keyCode: KeyCode.leftControl, rawFlags: onlyRightStillHeld) == false)
        #expect(ModifierState.isDown(keyCode: KeyCode.rightControl, rawFlags: onlyRightStillHeld) == true)
    }

    @Test func aDifferentModifiersDeviceBitDoesNotCountForThisKey() {
        let commandHeld = Self.commandFlag | Self.leftCommandDevice

        #expect(ModifierState.isDown(keyCode: KeyCode.leftControl, rawFlags: commandHeld) == false)
    }

    @Test func fallsBackToTheGenericFlagForSyntheticEvents() {
        #expect(ModifierState.isDown(keyCode: KeyCode.leftControl, rawFlags: Self.controlFlag) == true)
        #expect(ModifierState.isDown(keyCode: KeyCode.leftCommand, rawFlags: Self.commandFlag) == true)
        #expect(ModifierState.isDown(keyCode: KeyCode.leftCommand, rawFlags: Self.controlFlag) == false)
    }

    @Test func releasingTheLastModifierLeavesNoFlags() {
        #expect(ModifierState.isDown(keyCode: KeyCode.leftControl, rawFlags: 0) == false)
        #expect(ModifierState.isDown(keyCode: KeyCode.leftCommand, rawFlags: 0) == false)
    }

    @Test func aKeyThatIsNotAModifierIsNeverDown() {
        #expect(ModifierState.isDown(keyCode: KeyCode.space, rawFlags: ~0) == false)
    }

    @Test func flagsWithNothingHeldShowEveryModifierUp() {
        let up = ModifierState.released(rawFlags: 0x0100)

        #expect(up.contains(KeyCode.leftCommand))
        #expect(up.contains(KeyCode.rightControl))
        #expect(up.contains(KeyCode.function))
    }

    @Test func aSetFlagProvesNothingWithoutKeyBits() {
        // Posted by a program: Command is set, and nothing says which Command key.
        let up = ModifierState.released(rawFlags: Self.commandFlag | Self.functionFlag)

        #expect(up.contains(KeyCode.leftCommand) == false)
        #expect(up.contains(KeyCode.rightCommand) == false)
        #expect(up.contains(KeyCode.function) == false)
        #expect(up.contains(KeyCode.leftControl))
    }

    @Test func keyBitsTellWhichKeyOfAPairIsUp() {
        let onlyLeftCommand = Self.commandFlag | Self.leftCommandDevice

        let up = ModifierState.released(rawFlags: onlyLeftCommand)

        #expect(up.contains(KeyCode.leftCommand) == false)
        #expect(up.contains(KeyCode.rightCommand))
    }
}
