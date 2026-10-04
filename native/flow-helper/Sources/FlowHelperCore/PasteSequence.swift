/// What a paste does to the system, one step at a time. The helper supplies the real
/// steps; `PasteSequence` decides their order and when to stop.
public struct PasteSteps {
    /// Milliseconds since the epoch, the clock the app's expiry is given in.
    public var now: () -> Double
    /// Whether this process may post key events, and what the checks said.
    public var postAccess: () -> (allowed: Bool, detail: String)
    /// Makes the key press. False when it cannot be made.
    public var prepareKeys: () -> Bool
    /// Why the destination must be refused, or nil when the paste may go there.
    /// `afterWait` is true when the helper has just been held up (reading the
    /// clipboard) and has not been back to its run loop since: what it knows of the
    /// app in front is then as old as the wait, and has to be asked for afresh.
    public var refusal: (_ afterWait: Bool) -> (outcome: String, detail: String?)?
    /// Finishes an earlier paste that is still waiting to put the clipboard back.
    public var settleEarlierPaste: () -> Void
    /// Copies the clipboard so it can be put back. This can block: another app may be
    /// asked for the data.
    public var saveClipboard: () -> Void
    /// Puts the text on the clipboard.
    public var writeText: () -> Void
    public var pressKeys: () -> Void
    /// Takes the text off the clipboard again, putting back what was saved.
    public var takeTextBack: () -> Void
    /// Arranges for the clipboard to be put back once the app in front has read it.
    public var scheduleRestore: () -> Void

    public init(
        now: @escaping () -> Double,
        postAccess: @escaping () -> (allowed: Bool, detail: String),
        prepareKeys: @escaping () -> Bool,
        refusal: @escaping (_ afterWait: Bool) -> (outcome: String, detail: String?)?,
        settleEarlierPaste: @escaping () -> Void,
        saveClipboard: @escaping () -> Void,
        writeText: @escaping () -> Void,
        pressKeys: @escaping () -> Void,
        takeTextBack: @escaping () -> Void,
        scheduleRestore: @escaping () -> Void
    ) {
        self.now = now
        self.postAccess = postAccess
        self.prepareKeys = prepareKeys
        self.refusal = refusal
        self.settleEarlierPaste = settleEarlierPaste
        self.saveClipboard = saveClipboard
        self.writeText = writeText
        self.pressKeys = pressKeys
        self.takeTextBack = takeTextBack
        self.scheduleRestore = scheduleRestore
    }
}

/// The order of a paste, and the points at which it is called off.
///
/// The app waits only so long for a paste. After that it tells the user the paste
/// failed, and they may paste again by hand. A paste that then went through anyway
/// would put the text in twice, or into wherever the user has moved on to. So the app
/// sends the time it stops waiting (`expiresAtMs`), and nothing is done to the
/// clipboard or the keyboard after it. The step that can take long is saving the
/// clipboard, which cannot be interrupted; the time is looked at again when it returns.
public enum PasteSequence {
    /// After a clipboard read this slow, focus may have moved: the destination is
    /// checked again.
    public static let slowReadMs: Double = 300

    /// Returns the outcome (`pasted`, `targetChanged`, `secureField`, `noPostAccess` or
    /// `expired`) and a detail that says why. For `expired`, the detail is where the
    /// time ran out: `onArrival`, `clipboardRead`, `destinationCheck` or `beforeKeys`.
    ///
    /// Only `pasted` leaves the text on the clipboard, with one exception: if the time
    /// runs out after the text was written and there was no copy of the clipboard to
    /// put back, the text stays where it is.
    public static func run(_ steps: PasteSteps, expiresAtMs: Double?) -> (outcome: String, detail: String?) {
        func expired() -> Bool {
            guard let expiresAtMs else { return false }
            return steps.now() >= expiresAtMs
        }

        // The request may have waited behind something slow before it was read.
        if expired() { return ("expired", "onArrival") }

        let access = steps.postAccess()
        guard access.allowed else { return ("noPostAccess", access.detail) }
        // The key press is made before the clipboard is touched: without it nothing can
        // be pasted, and the clipboard must then be left as it is.
        guard steps.prepareKeys() else { return ("noPostAccess", "keyEvent") }
        if let refusal = steps.refusal(false) { return refusal }

        // An earlier paste is finished first, or its text would be saved as "the clipboard".
        steps.settleEarlierPaste()

        let readStarted = steps.now()
        steps.saveClipboard()
        if expired() { return ("expired", "clipboardRead") }
        if steps.now() - readStarted > slowReadMs {
            if let refusal = steps.refusal(true) { return refusal }
            // That check asks the app in front, which can itself be slow to answer.
            if expired() { return ("expired", "destinationCheck") }
        }

        steps.writeText()
        if expired() {
            steps.takeTextBack()
            return ("expired", "beforeKeys")
        }
        steps.pressKeys()
        steps.scheduleRestore()
        return ("pasted", nil)
    }
}
