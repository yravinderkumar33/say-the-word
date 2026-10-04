import ApplicationServices
import FlowHelperCore
import Foundation

/// The system-wide key event tap. It feeds key events to the matcher, reports shortcut
/// events to the app, and drops the few key events the matcher asks it to swallow.
///
/// It is an active tap (`defaultTap`), so it needs the Accessibility permission and
/// nothing else. The callback runs on a dedicated thread and never blocks: a slow tap
/// makes the whole keyboard lag, and macOS disables a tap that stalls.
final class EventTap: @unchecked Sendable {
    /// Marks key events this helper posts itself, so the tap lets them through untouched.
    static let ownEventTag: Int64 = 0x5746_4C4F

    private let emit: @Sendable ([String: Any]) -> Void
    /// False under `--no-tap`: the helper then never listens to the keyboard at all.
    private let allowed: Bool
    private let lock = NSLock()
    private var matcher = BindingMatcher()
    private var port: CFMachPort?
    /// The tap thread's run loop, kept so the tap can be taken down again.
    private var runLoop: CFRunLoop?

    init(emit: @escaping @Sendable ([String: Any]) -> Void, allowed: Bool = true) {
        self.emit = emit
        self.allowed = allowed
    }

    var isInstalled: Bool {
        lock.withLock { port != nil }
    }

    func configure(_ bindings: [Binding]) {
        // A shortcut that was down when the table changed would never be reported up by
        // the new table, and the app would wait for its release for ever.
        let ended = lock.withLock { matcher.configure(bindings) }
        report(ended, reason: "reconfigured")
    }

    func armEscape(_ armed: Bool) {
        lock.withLock { matcher.armEscape(armed) }
    }

    /// Creates the tap and starts its thread. Returns false without Accessibility.
    ///
    /// It never tries without the permission. Creating an active tap asks macOS for the
    /// right to post key events, and the process remembers the answer: a tap attempted
    /// before the grant left this helper with a "no" that outlived the grant, and every
    /// paste was refused (2026-10-03).
    func install() -> Bool {
        guard allowed, AXIsProcessTrusted() else { return false }
        if isInstalled { return true }

        let mask = (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)
        guard let port = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: eventTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else { return false }

        lock.withLock { self.port = port }
        let thread = Thread { [weak self] in
            guard let self, let loop = CFRunLoopGetCurrent() else { return }
            // The tap may have been taken down again before this thread got going.
            let current = self.lock.withLock { () -> Bool in
                guard self.port === port else { return false }
                self.runLoop = loop
                return true
            }
            guard current else { return }
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
            CFRunLoopAddSource(loop, source, .commonModes)
            CGEvent.tapEnable(tap: port, enable: true)
            CFRunLoopRun()
        }
        thread.name = "flow-helper.event-tap"
        thread.qualityOfService = .userInteractive
        thread.start()
        return true
    }

    /// Takes the tap down and says so. Used when Accessibility is withdrawn while the
    /// helper runs: a live tap whose owner has lost the permission has been reported to
    /// block the keys it watches for every app, until its process ends.
    func uninstall(reason: String) {
        let (port, loop, ended) = lock.withLock { () -> (CFMachPort?, CFRunLoop?, [MatcherEvent]) in
            let state = (self.port, self.runLoop, matcher.reset())
            self.port = nil
            self.runLoop = nil
            return state
        }
        guard let port else { return }
        CGEvent.tapEnable(tap: port, enable: false)
        CFMachPortInvalidate(port)
        if let loop { CFRunLoopStop(loop) }
        // Nobody will report these keys going up now.
        report(ended, reason: "tapReset")
        emit(HelperProtocol.tapState(installed: false, reason: reason))
    }

    /// Reports shortcuts that ended for a reason other than their key being released.
    private func report(_ events: [MatcherEvent], reason: String) {
        guard events.isEmpty == false else { return }
        let now = Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000
        for event in events {
            emit(HelperProtocol.event(event, t: now, reason: reason))
        }
    }

    fileprivate func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let pass = Unmanaged.passUnretained(event)

        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // Without the permission the tap must stay off; it is taken down instead.
            guard AXIsProcessTrusted() else {
                DispatchQueue.main.async { [weak self] in self?.uninstall(reason: "accessibilityRevoked") }
                return pass
            }
            // macOS switched the tap off. Turn it back on here, in the callback: polling
            // the tap's state from a timer has caused kernel panics in other projects.
            let (port, ended) = lock.withLock { (self.port, matcher.reset()) }
            if let port { CGEvent.tapEnable(tap: port, enable: true) }
            report(ended, reason: "tapReset")
            let reason = type == .tapDisabledByTimeout ? "timeout" : "userInput"
            emit(HelperProtocol.tapState(installed: true, reason: reason))
            return pass
        }

        if event.getIntegerValueField(.eventSourceUserData) == Self.ownEventTag {
            return pass
        }

        let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))
        let decision: MatcherDecision
        switch type {
        case .flagsChanged:
            guard KeyCode.isModifier(keyCode) else { return pass }
            let rawFlags = event.flags.rawValue
            let isDown = ModifierState.isDown(keyCode: keyCode, rawFlags: rawFlags)
            decision = lock.withLock {
                // Every such event carries the state of all the modifiers. One that the
                // matcher still holds as down, but these flags show to be up, lost its
                // release somewhere; left there, it would stop every shortcut matching.
                matcher.forget(ModifierState.released(rawFlags: rawFlags).subtracting([keyCode]))
                return matcher.modifierChanged(keyCode: keyCode, isDown: isDown)
            }
        case .keyDown:
            let isRepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
            decision = lock.withLock { matcher.keyDown(keyCode: keyCode, isRepeat: isRepeat) }
        case .keyUp:
            decision = lock.withLock { matcher.keyUp(keyCode: keyCode) }
        default:
            return pass
        }

        if decision.events.isEmpty == false {
            let time = Double(event.timestamp) / 1_000_000
            for matcherEvent in decision.events {
                emit(HelperProtocol.event(matcherEvent, t: time))
            }
        }
        return decision.swallow ? nil : pass
    }
}

private func eventTapCallback(
    proxy _: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    guard let userInfo else { return Unmanaged.passUnretained(event) }
    let tap = Unmanaged<EventTap>.fromOpaque(userInfo).takeUnretainedValue()
    return tap.handle(type: type, event: event)
}
