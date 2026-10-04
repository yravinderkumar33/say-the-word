import FlowHelperCore
import Foundation
import Testing

struct LineOutputTests {
    @Test func writesEachMessageAsOneTerminatedLine() throws {
        let pipe = Pipe()
        let sut = LineOutput(handle: pipe.fileHandleForWriting)

        sut.write(["type": "ready", "protocol": 1])
        sut.writeLine(#"{"id":1,"ok":true}"#)
        try pipe.fileHandleForWriting.close()

        let written = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        #expect(written == "{\"protocol\":1,\"type\":\"ready\"}\n{\"id\":1,\"ok\":true}\n")
    }

    @Test func linesFromManyThreadsNeverInterleave() async throws {
        let pipe = Pipe()
        let sut = LineOutput(handle: pipe.fileHandleForWriting)
        let line = String(repeating: "x", count: 200)
        let lineCount = 200

        // Read while writing, so the writers never block on a full pipe buffer.
        let reading = pipe.fileHandleForReading
        let reader = Task.detached {
            String(decoding: reading.readDataToEndOfFile(), as: UTF8.self)
        }
        DispatchQueue.concurrentPerform(iterations: lineCount) { _ in sut.writeLine(line) }
        try pipe.fileHandleForWriting.close()

        let lines = await reader.value.split(separator: "\n", omittingEmptySubsequences: true)
        #expect(lines.count == lineCount)
        #expect(lines.allSatisfy { $0 == line }, "Every line must arrive whole.")
    }
}
