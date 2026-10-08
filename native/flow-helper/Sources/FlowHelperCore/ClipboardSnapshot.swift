import AppKit

/// Everything on a pasteboard at one moment, so it can be put back after a paste.
///
/// A copy is either complete or not taken. Putting back part of what was there (every
/// format but the one that could not be read) would pass a poorer clipboard off as the
/// original, so a clipboard that cannot be copied whole is not put back at all: the
/// pasted text stays on it, and the helper says so.
public struct ClipboardSnapshot {
    /// A clipboard larger than this is not saved.
    public static let byteBudget = 16 * 1024 * 1024
    /// Reading stops once it has taken longer than this: no further format is asked
    /// for, and the clipboard is not saved. Content another app provides on demand (a
    /// large selection, Universal Clipboard) can take seconds a format.
    ///
    /// A read cannot be interrupted, so this does not bound the last one. A copy that
    /// is complete is kept however long its last format took: throwing it away would
    /// cost the clipboard and win no time back. What bounds the paste as a whole is its
    /// expiry (see `PasteSequence`).
    public static let timeBudget: TimeInterval = 0.25

    /// One format of an item, with its data.
    public typealias Format = (type: NSPasteboard.PasteboardType, data: Data)

    /// One entry per pasteboard item: each format it offered, in the order it offered
    /// them. The order is part of the content: an app lists its richest format first,
    /// and a reader that takes the first one it understands would get a poorer paste
    /// from a copy that had shuffled them.
    public let items: [[Format]]

    /// Copies the pasteboard, or returns nil when it cannot be copied whole: it is too
    /// large, too slow, a format it offers has no data to give, or something else was
    /// copied while it was being read.
    ///
    /// `changeCount` is how the pasteboard's change count is read; tests pass their own,
    /// because a change that falls between the last format being read and the count
    /// being looked at again cannot be made to happen on demand.
    public static func capture(
        _ pasteboard: NSPasteboard,
        byteBudget: Int = ClipboardSnapshot.byteBudget,
        timeBudget: TimeInterval = ClipboardSnapshot.timeBudget,
        now: () -> Date = { Date() },
        changeCount readChangeCount: (() -> Int)? = nil
    ) -> ClipboardSnapshot? {
        let currentChangeCount = readChangeCount ?? { pasteboard.changeCount }
        let changeCount = currentChangeCount()
        // Nil here is a failed read, not an empty clipboard.
        guard let pasteboardItems = pasteboard.pasteboardItems else { return nil }
        let deadline = now().addingTimeInterval(timeBudget)
        var total = 0
        var items: [[Format]] = []
        for item in pasteboardItems {
            var entry: [Format] = []
            for type in item.types {
                if now() > deadline { return nil }
                // A format that was offered and cannot be read is a format that would
                // be missing from the copy.
                guard let data = item.data(forType: type) else { return nil }
                total += data.count
                if total > byteBudget { return nil }
                entry.append((type, data))
            }
            items.append(entry)
        }
        // Read across a change, the copy is no longer what is on the clipboard. A change
        // during a read shows as a format with no data, above; this catches one that
        // came just after the last format had been read.
        guard currentChangeCount() == changeCount else { return nil }
        return ClipboardSnapshot(items: items)
    }

    /// Replaces the pasteboard's contents with the copy. False when the pasteboard did
    /// not take it; nothing else is tried, and the caller reports it as not restored.
    ///
    /// The copy goes back for this Mac only, as the pasted text was written. Whether the
    /// original was written that way cannot be read back (a password manager's copy for
    /// this Mac looks like any other), and put back with the default options it would be
    /// offered to the user's other devices through Universal Clipboard.
    public func restore(to pasteboard: some WritablePasteboard) -> Bool {
        pasteboard.prepareForNewContents(with: .currentHostOnly)
        // An empty clipboard is put back by leaving it empty.
        guard items.isEmpty == false else { return true }
        let objects = items.map { entry -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in entry {
                item.setData(data, forType: type)
            }
            return item
        }
        return pasteboard.writeObjects(objects)
    }
}

/// What putting a copy back asks of a pasteboard. `NSPasteboard` is one; a test passes
/// one that also notes how it was prepared, which a pasteboard cannot be asked afterwards.
public protocol WritablePasteboard {
    @discardableResult
    func prepareForNewContents(with options: NSPasteboard.ContentsOptions) -> Int
    func writeObjects(_ objects: [any NSPasteboardWriting]) -> Bool
}

extension NSPasteboard: WritablePasteboard {}
