import AppKit
import ApplicationServices
import FlowHelperCore
import Foundation

// flow-helper: the app's OS glue. Started by the Electron main process, it speaks JSON
// lines on stdin/stdout. It owns the key event tap, the paste transaction and the
// accessibility reads; every decision about what they mean is made by the app.
//
// Threads:
//   main          run loop; handles every request, the clipboard and accessibility calls
//   stdin reader  reads request lines and hands them to main
//   event tap     its own run loop; must never block
//   sender        serial queue for stdout, so the tap callback never waits on a pipe

let arguments = Array(CommandLine.arguments.dropFirst())

if arguments.first == "--version" {
    print("flow-helper \(HelperProtocol.helperVersion) (protocol \(HelperProtocol.version))")
    exit(0)
}

if let tool = arguments.first,
   ["--post-keys", "--census", "--focused-value", "--slow-clipboard"].contains(tool)
{
    guard TestTools.isEnabled else {
        FileHandle.standardError.write(Data("test tools are disabled (set FLOW_HELPER_TEST_TOOLS=1)\n".utf8))
        exit(64)
    }
    switch tool {
    case "--post-keys":
        exit(TestTools.postKeys(arguments.dropFirst().first ?? ""))
    case "--focused-value":
        exit(TestTools.focusedValue())
    case "--slow-clipboard":
        exit(TestTools.slowClipboard(milliseconds: arguments.dropFirst().first.flatMap { Int($0) } ?? 1_500))
    default:
        exit(TestTools.census(seconds: arguments.dropFirst().first.flatMap { Int($0) } ?? 20))
    }
}

// A closed stdout must not kill the process with SIGPIPE; stdin closing is the exit signal.
signal(SIGPIPE, SIG_IGN)

let output = LineOutput()
let sender = DispatchQueue(label: "flow-helper.sender")
let send: @Sendable ([String: Any]) -> Void = { object in
    guard let line = JSONLines.encode(object) else { return }
    sender.async { output.writeLine(line) }
}

// `--no-tap` is for automated tests that drive the app through its debug control: with
// no tap, a test can neither see nor swallow the keys of the person using the Mac.
let tap = EventTap(emit: send, allowed: !arguments.contains("--no-tap"))
let targets = TargetStore()
let paster = PasteTransaction(targets: targets, emit: send)
// Whether Accessibility is granted. A test can have the answer be "no" for a while
// after the start, which is what a first launch looks like.
let grantedFrom = TestTools.pretendedGrantTime()
let isTrusted: () -> Bool = { Date() >= grantedFrom && AXIsProcessTrusted() }
let dispatcher = Dispatcher(
    actions: SystemActions(tap: tap, targets: targets, paster: paster, isTrusted: isTrusted)
)

// The tap can only be created once Accessibility is granted. If it is not yet, the app
// asks for it and then sends `installTap`.
let trusted = isTrusted()
send(HelperProtocol.ready(accessibilityTrusted: trusted, tapInstalled: trusted && tap.install()))

// Accessibility can be withdrawn while the helper runs, and nothing announces it
// reliably. A live tap whose owner has lost the permission has been reported to block
// the keys it watches for every app, so it is looked for once a second and the tap is
// taken down. (This reads a cached permission, which is cheap; it does not touch the
// tap's own state, which must not be polled.) The same tick follows Secure Event Input.
let watch = Timer(timeInterval: 1, repeats: true) { _ in
    if tap.isInstalled, AXIsProcessTrusted() == false {
        tap.uninstall(reason: "accessibilityRevoked")
    }
    let inFront = NSWorkspace.shared.frontmostApplication
    targets.secureInput.sample(
        frontmost: inFront?.processIdentifier,
        // With the fallback: the lock screen or the screen saver must be known for what
        // it is even when Launch Services has no answer about it.
        bundleId: inFront.flatMap { TargetStore.bundleId(of: $0) }
    )
}
RunLoop.main.add(watch, forMode: .common)

Thread.detachNewThread {
    while let line = readLine(strippingNewline: true) {
        DispatchQueue.main.async {
            guard let reply = dispatcher.reply(to: line) else { return }
            sender.async { output.writeLine(reply) }
        }
    }
    // stdin closed: the app has gone away, and the helper must not outlive it.
    // The tidy way out runs on the main thread. If that thread is stuck (in a read from
    // an app that does not answer, say), the helper still goes, a moment later: left
    // behind, its key tap would go on swallowing the shortcut keys with no app to use them.
    DispatchQueue.global().asyncAfter(deadline: .now() + 1) { exit(0) }
    DispatchQueue.main.async {
        paster.settle()
        sender.sync {}
        exit(0)
    }
}

RunLoop.main.run()
