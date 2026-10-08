/// One shortcut: an id the app understands, and the key combinations that trigger it.
public struct Binding: Equatable, Sendable {
    public let id: String
    public let chords: [Set<Int>]

    public init(id: String, chords: [Set<Int>]) {
        self.id = id
        self.chords = chords
    }
}

/// What the matcher reports to the app. It never reports which ordinary key was typed.
public enum MatcherEvent: Equatable, Sendable {
    case bindingDown(String)
    case bindingUp(String)
    /// Some other key was pressed while a modifier-only binding (such as Fn) was held,
    /// so the user is using the modifier for something else.
    case interrupted(String)
    /// Escape was pressed while armed.
    case cancel
}

public struct MatcherDecision: Equatable, Sendable {
    public var events: [MatcherEvent]
    /// True when the key event must not reach other apps.
    public var swallow: Bool

    public init(events: [MatcherEvent] = [], swallow: Bool = false) {
        self.events = events
        self.swallow = swallow
    }
}

/// Turns raw key events into shortcut events, and decides which key events to swallow.
///
/// Pure state machine: no OS calls, so it is fully unit-tested. The event tap feeds it.
///
/// Rules:
/// - A binding starts on a press edge, when the held keys equal one of its chords exactly.
/// - It stays down while those keys are held, and ends when any of them is released.
/// - Swallowing is stateful: a key-up is dropped only if its key-down was dropped, so a
///   key can never be left stuck down in another app.
/// - Keys that belong to no chord are never stored.
public struct BindingMatcher: Sendable {
    private var bindings: [Binding] = []
    /// Non-modifier keys that appear in some chord.
    private var chordKeys: Set<Int> = []
    /// True when some binding is exactly the Fn key. Fn's own events are then dropped,
    /// which is what keeps macOS from running the Globe-key action.
    private var fnIsBoundAlone = false

    private var pressed: Set<Int> = []
    private var active: [ActiveBinding] = []
    private var interrupted: Set<String> = []
    private var swallowed: Set<Int> = []
    private var escapeArmed = false
    private var escapeHeld = false

    private struct ActiveBinding: Sendable {
        let id: String
        let chord: Set<Int>
    }

    public init(bindings: [Binding] = []) {
        configure(bindings)
    }

    /// Replaces the shortcut table and forgets all key state. Returns a `bindingUp` for
    /// every shortcut that was down: the new table will never report its release.
    @discardableResult
    public mutating func configure(_ bindings: [Binding]) -> [MatcherEvent] {
        let ended = active.map { MatcherEvent.bindingUp($0.id) }
        self.bindings = bindings
        chordKeys = Set(bindings.flatMap(\.chords).flatMap { $0 }).subtracting(KeyCode.modifiers)
        fnIsBoundAlone = bindings.contains { $0.chords.contains([KeyCode.function]) }
        pressed = []
        active = []
        interrupted = []
        swallowed = []
        escapeHeld = false
        return ended
    }

    /// Drops keys that are known to be up although their release was never seen (the
    /// tap can miss one). Left in place, a stale key makes every later press look like
    /// part of a chord that matches nothing. Keys that hold an active shortcut down
    /// are left alone: ending a dictation is for a real release to do.
    public mutating func forget(_ keyCodes: Set<Int>) {
        let inUse = Set(active.flatMap(\.chord))
        for keyCode in keyCodes where pressed.contains(keyCode) && inUse.contains(keyCode) == false {
            pressed.remove(keyCode)
            swallowed.remove(keyCode)
        }
    }

    /// While armed, the next Escape press is swallowed whole and reported as `cancel`.
    /// That press uses the arming up as it goes down, so a stalled app cannot leave
    /// Escape dead. Its release is still swallowed, whenever it comes, but belongs to
    /// that press alone: a session armed in the meantime keeps its own Escape.
    public mutating func armEscape(_ armed: Bool) {
        escapeArmed = armed
    }

    /// A modifier key went down or up (a `flagsChanged` event).
    public mutating func modifierChanged(keyCode: Int, isDown: Bool) -> MatcherDecision {
        if isDown {
            guard pressed.insert(keyCode).inserted else {
                return MatcherDecision(swallow: swallowed.contains(keyCode))
            }
            let events = startMatchingBindings()
            let swallow = keyCode == KeyCode.function && fnIsBoundAlone
            if swallow { swallowed.insert(keyCode) }
            return MatcherDecision(events: events, swallow: swallow)
        }

        let wasSwallowed = swallowed.remove(keyCode) != nil
        guard pressed.remove(keyCode) != nil else {
            return MatcherDecision(swallow: wasSwallowed)
        }
        return MatcherDecision(events: endBindings(containing: keyCode), swallow: wasSwallowed)
    }

    public mutating func keyDown(keyCode: Int, isRepeat: Bool) -> MatcherDecision {
        if isRepeat {
            let held = swallowed.contains(keyCode) || (keyCode == KeyCode.escape && escapeHeld)
            return MatcherDecision(swallow: held)
        }

        if keyCode == KeyCode.escape, escapeArmed {
            escapeArmed = false
            escapeHeld = true
            return MatcherDecision(events: [.cancel], swallow: true)
        }

        if KeyCode.globeSynthetic.contains(keyCode), fnIsBoundAlone {
            swallowed.insert(keyCode)
            return MatcherDecision(swallow: true)
        }

        if chordKeys.contains(keyCode) {
            pressed.insert(keyCode)
            let events = startMatchingBindings()
            if events.isEmpty == false {
                swallowed.insert(keyCode)
                return MatcherDecision(events: events, swallow: true)
            }
            // A chord key pressed without the rest of its chord is ordinary typing.
            pressed.remove(keyCode)
        }

        // A key-down that is let through owns its key-up. A mark left by an earlier press
        // whose release the tap never saw must not swallow it: the app would be left
        // with the key held down.
        swallowed.remove(keyCode)
        return MatcherDecision(events: interruptModifierOnlyBindings())
    }

    public mutating func keyUp(keyCode: Int) -> MatcherDecision {
        if keyCode == KeyCode.escape, escapeHeld {
            escapeHeld = false
            return MatcherDecision(swallow: true)
        }

        let wasSwallowed = swallowed.remove(keyCode) != nil
        guard pressed.remove(keyCode) != nil else {
            return MatcherDecision(swallow: wasSwallowed)
        }
        return MatcherDecision(events: endBindings(containing: keyCode), swallow: wasSwallowed)
    }

    /// Ends every active binding and forgets key state. Used when key events may have
    /// been missed: macOS disabled the tap, or the helper took it down. (After the Mac
    /// sleeps, the app sends the shortcut table again, and `configure` forgets the same.)
    public mutating func reset() -> [MatcherEvent] {
        let events = active.map { MatcherEvent.bindingUp($0.id) }
        pressed = []
        active = []
        interrupted = []
        swallowed = []
        escapeHeld = false
        return events
    }

    private mutating func startMatchingBindings() -> [MatcherEvent] {
        var events: [MatcherEvent] = []
        for binding in bindings where binding.chords.contains(pressed) {
            guard active.contains(where: { $0.id == binding.id }) == false else { continue }
            active.append(ActiveBinding(id: binding.id, chord: pressed))
            events.append(.bindingDown(binding.id))
        }
        return events
    }

    private mutating func endBindings(containing keyCode: Int) -> [MatcherEvent] {
        var events: [MatcherEvent] = []
        var stillActive: [ActiveBinding] = []
        for entry in active {
            if entry.chord.contains(keyCode) {
                events.append(.bindingUp(entry.id))
                interrupted.remove(entry.id)
            } else {
                stillActive.append(entry)
            }
        }
        active = stillActive
        return events
    }

    private mutating func interruptModifierOnlyBindings() -> [MatcherEvent] {
        var events: [MatcherEvent] = []
        for entry in active where entry.chord.allSatisfy(KeyCode.isModifier) {
            guard interrupted.insert(entry.id).inserted else { continue }
            events.append(.interrupted(entry.id))
        }
        return events
    }
}
