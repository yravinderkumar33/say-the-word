import FlowHelperCore
import Testing

struct PostAccessTests {
    @Test func trustAloneAllowsPosting() {
        var asked = 0

        let decision = PostAccess.decide(trusted: true) {
            asked += 1
            return false
        }

        #expect(decision.allowed == true)
        #expect(asked == 0, "The remembered answer is not consulted: it can be a stale no.")
        #expect(decision.detail == "trusted=true")
    }

    @Test func withoutTrustTheSystemAnswerDecides() {
        let allowed = PostAccess.decide(trusted: false) { true }
        let refused = PostAccess.decide(trusted: false) { false }

        #expect(allowed.allowed == true)
        #expect(refused.allowed == false)
        #expect(refused.detail == "trusted=false preflight=false")
    }
}
