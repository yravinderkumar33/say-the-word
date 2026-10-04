import Foundation

/// Writes whole lines to a file handle. Safe to call from several threads: the lock
/// keeps two lines from interleaving, which would corrupt the JSON-lines stream.
public final class LineOutput: @unchecked Sendable {
    private let handle: FileHandle
    private let lock = NSLock()

    public init(handle: FileHandle = .standardOutput) {
        self.handle = handle
    }

    public func writeLine(_ line: String) {
        lock.lock()
        defer { lock.unlock() }
        // If the reader has gone away there is nobody to tell; the helper exits when stdin closes.
        try? handle.write(contentsOf: Data((line + "\n").utf8))
    }

    public func write(_ object: [String: Any]) {
        guard let line = JSONLines.encode(object) else { return }
        writeLine(line)
    }
}
