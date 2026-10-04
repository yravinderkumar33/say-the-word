import AppKit
import FlowHelperCore
import Testing

/// Provides nothing for the format it promised.
private final class EmptyProvider: NSObject, NSPasteboardItemDataProvider {
    func pasteboard(
        _: NSPasteboard?, item _: NSPasteboardItem, provideDataForType _: NSPasteboard.PasteboardType
    ) {}
}

/// Provides its data on demand, and runs `whenAsked` first: a test uses that to let time
/// pass, as it does while another app works out what to hand over.
private final class LazyProvider: NSObject, NSPasteboardItemDataProvider {
    private(set) var asked = 0
    private let data: Data
    private let whenAsked: () -> Void

    init(data: Data, whenAsked: @escaping () -> Void = {}) {
        self.data = data
        self.whenAsked = whenAsked
    }

    func pasteboard(
        _: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType
    ) {
        asked += 1
        whenAsked()
        item.setData(data, forType: type)
    }
}

/// A clock a test moves by hand.
private final class TestClock {
    var date = Date(timeIntervalSince1970: 1_000_000)
}

/// A pasteboard of the tests' own, under a name nothing else uses.
private enum PrivatePasteboard {
    static func make() -> NSPasteboard {
        NSPasteboard(name: NSPasteboard.Name("app.whisperflow.tests.\(UUID().uuidString)"))
    }

    /// A sandbox can keep even a private pasteboard out of reach.
    static let works: Bool = {
        let pasteboard = make()
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        return pasteboard.setString("probe", forType: .string) && pasteboard.string(forType: .string) == "probe"
    }()
}

/// These tests use a pasteboard of their own, made for each test under a unique name and
/// released afterwards. The general clipboard is never read or written.
///
/// On the main thread, as the helper uses the clipboard: a format provided on demand is
/// asked for on the thread that reads it, and AppKit wants that to be the main one.
@MainActor
@Suite(.enabled(if: PrivatePasteboard.works, "No pasteboard server can be reached here."))
struct ClipboardSnapshotTests {
    static let richType = NSPasteboard.PasteboardType("app.whisperflow.tests.rich")
    static let otherType = NSPasteboard.PasteboardType("app.whisperflow.tests.other")

    /// The data an item of a copy holds for one format.
    static func data(_ type: NSPasteboard.PasteboardType, in item: [ClipboardSnapshot.Format]) -> Data? {
        item.first { $0.type == type }?.data
    }

    private func withPasteboard(_ body: (NSPasteboard) throws -> Void) rethrows {
        let pasteboard = PrivatePasteboard.make()
        defer { pasteboard.releaseGlobally() }
        pasteboard.clearContents()
        try body(pasteboard)
    }

    @Test func copiesEveryItemAndEveryFormat() throws {
        try withPasteboard { pasteboard in
            let first = NSPasteboardItem()
            first.setString("plain", forType: .string)
            first.setData(Data([1, 2, 3]), forType: Self.richType)
            let second = NSPasteboardItem()
            second.setString("another", forType: .string)
            try #require(pasteboard.writeObjects([first, second]))

            let snapshot = try #require(ClipboardSnapshot.capture(pasteboard))

            #expect(snapshot.items.count == 2)
            #expect(Self.data(.string, in: snapshot.items[0]) == Data("plain".utf8))
            #expect(Self.data(Self.richType, in: snapshot.items[0]) == Data([1, 2, 3]))
            #expect(Self.data(.string, in: snapshot.items[1]) == Data("another".utf8))
        }
    }

    @Test func keepsTheFormatsInTheOrderTheAppOfferedThem() throws {
        try withPasteboard { pasteboard in
            // Richest first, as an app lists them. A reader that takes the first format
            // it understands must find the same one first after the copy is put back.
            let offered = [Self.richType, Self.otherType, NSPasteboard.PasteboardType.string]
            let item = NSPasteboardItem()
            for (index, type) in offered.enumerated() {
                item.setData(Data([UInt8(index)]), forType: type)
            }
            try #require(pasteboard.writeObjects([item]))
            let snapshot = try #require(ClipboardSnapshot.capture(pasteboard))
            pasteboard.clearContents()
            pasteboard.setString("the pasted text", forType: .string)

            #expect(snapshot.restore(to: pasteboard) == true)

            #expect(snapshot.items[0].map(\.type) == offered)
            #expect(pasteboard.pasteboardItems?.first?.types == offered)
        }
    }

    @Test func aFormatThatWasOfferedButCannotBeReadMeansNoCopyAtAll() throws {
        try withPasteboard { pasteboard in
            let provider = EmptyProvider()
            let item = NSPasteboardItem()
            item.setString("plain", forType: .string)
            item.setDataProvider(provider, forTypes: [Self.richType])
            try #require(pasteboard.writeObjects([item]))

            let snapshot = ClipboardSnapshot.capture(pasteboard)

            #expect(snapshot == nil, "A copy without the rich format would be put back as if it were the original.")
        }
    }

    @Test func aClipboardOverTheSizeLimitIsNotCopied() throws {
        try withPasteboard { pasteboard in
            let item = NSPasteboardItem()
            item.setData(Data(repeating: 7, count: 65), forType: Self.richType)
            try #require(pasteboard.writeObjects([item]))

            #expect(ClipboardSnapshot.capture(pasteboard, byteBudget: 64) == nil)
            #expect(ClipboardSnapshot.capture(pasteboard, byteBudget: 65) != nil)
        }
    }

    @Test func readingStopsOnceItHasTakenTooLong() throws {
        try withPasteboard { pasteboard in
            let clock = TestClock()
            let slow = LazyProvider(data: Data([1])) { clock.date += 0.6 }
            let next = LazyProvider(data: Data([2]))
            let first = NSPasteboardItem()
            first.setDataProvider(slow, forTypes: [Self.richType])
            let second = NSPasteboardItem()
            second.setDataProvider(next, forTypes: [Self.otherType])
            try #require(pasteboard.writeObjects([first, second]))

            let snapshot = ClipboardSnapshot.capture(pasteboard, timeBudget: 0.25, now: { clock.date })

            #expect(snapshot == nil)
            #expect(slow.asked == 1)
            #expect(next.asked == 0, "Nothing more is asked for once the time is up.")
        }
    }

    @Test func aCompleteCopyIsKeptEvenWhenItsLastFormatWasSlow() throws {
        try withPasteboard { pasteboard in
            let clock = TestClock()
            let slow = LazyProvider(data: Data([1, 2])) { clock.date += 0.6 }
            let item = NSPasteboardItem()
            item.setDataProvider(slow, forTypes: [Self.richType])
            try #require(pasteboard.writeObjects([item]))

            let snapshot = ClipboardSnapshot.capture(pasteboard, timeBudget: 0.25, now: { clock.date })

            // The time is already spent. Whether the paste may still go ahead is for
            // its expiry to say (PasteSequence), not for this copy.
            #expect(snapshot.flatMap { Self.data(Self.richType, in: $0.items[0]) } == Data([1, 2]))
        }
    }

    @Test func aClipboardThatChangesWhileAFormatIsBeingSuppliedIsNotCopied() throws {
        try withPasteboard { pasteboard in
            // Something else is copied while a format is being supplied. The format then
            // comes back with no data, which is what stops the copy.
            let provider = LazyProvider(data: Data([1])) {
                pasteboard.clearContents()
                pasteboard.setString("copied meanwhile", forType: .string)
            }
            let item = NSPasteboardItem()
            item.setString("old", forType: .string)
            item.setDataProvider(provider, forTypes: [Self.richType])
            try #require(pasteboard.writeObjects([item]))

            let snapshot = ClipboardSnapshot.capture(pasteboard)

            #expect(provider.asked == 1)
            #expect(snapshot == nil)
            #expect(pasteboard.string(forType: .string) == "copied meanwhile")
        }
    }

    @Test func aClipboardThatChangesJustAfterItsLastFormatWasReadIsNotCopied() throws {
        try withPasteboard { pasteboard in
            let item = NSPasteboardItem()
            item.setString("old", forType: .string)
            item.setData(Data([1]), forType: Self.richType)
            try #require(pasteboard.writeObjects([item]))
            // Every format is read, and reads well. Only the change count, looked at
            // before the first format and again after the last, says that the copy is
            // of a clipboard that is no longer there.
            var counts = [7, 8]

            let changed = ClipboardSnapshot.capture(pasteboard, changeCount: { counts.removeFirst() })
            let unchanged = ClipboardSnapshot.capture(pasteboard, changeCount: { 7 })

            #expect(changed == nil)
            #expect(unchanged?.items.first?.count == 2)
        }
    }

    @Test func anEmptyClipboardIsCopiedAndPutBackEmpty() throws {
        try withPasteboard { pasteboard in
            let snapshot = try #require(ClipboardSnapshot.capture(pasteboard))
            pasteboard.setString("the pasted text", forType: .string)

            let restored = snapshot.restore(to: pasteboard)

            #expect(snapshot.items.isEmpty)
            #expect(restored == true)
            #expect(pasteboard.pasteboardItems?.isEmpty ?? false)
        }
    }

    @Test func restorePutsEveryItemAndFormatBack() throws {
        try withPasteboard { pasteboard in
            let first = NSPasteboardItem()
            first.setString("plain", forType: .string)
            first.setData(Data([1, 2, 3]), forType: Self.richType)
            let second = NSPasteboardItem()
            second.setString("another", forType: .string)
            try #require(pasteboard.writeObjects([first, second]))
            let snapshot = try #require(ClipboardSnapshot.capture(pasteboard))
            pasteboard.clearContents()
            pasteboard.setString("the pasted text", forType: .string)

            let restored = snapshot.restore(to: pasteboard)

            let items = try #require(pasteboard.pasteboardItems)
            #expect(restored == true)
            #expect(items.count == 2)
            #expect(items[0].string(forType: .string) == "plain")
            #expect(items[0].data(forType: Self.richType) == Data([1, 2, 3]))
            #expect(items[1].string(forType: .string) == "another")
        }
    }
}
