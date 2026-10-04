/// Decides whether the helper may post key events, which is what a paste is.
///
/// Accessibility trust is what allows it, and that is read afresh each time. The
/// system's own "may I post?" answer is not: a process that asked for the right before
/// it had it goes on being told "no" after the grant. So trust decides, and the other
/// answer is only asked for when there is no trust, for someone who has allowed event
/// posting on its own.
public enum PostAccess {
    public static func decide(trusted: Bool, preflight: () -> Bool) -> (allowed: Bool, detail: String) {
        if trusted { return (true, "trusted=true") }
        let answer = preflight()
        return (answer, "trusted=false preflight=\(answer)")
    }
}
