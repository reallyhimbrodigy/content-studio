import Foundation

// Standalone unit tests for FeedbackGate.reviewPromptEligible — the decision
// behind the native App Store review sheet. UI-free:
//
//   swiftc ../Promptly/Views/FeedbackGate.swift ReviewPromptTests.swift -o /tmp/rvtest && /tmp/rvtest
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.
//
// Apple caps the sheet at three prompts a year and SILENTLY DISCARDS the rest.
// That is what makes these conditions worth testing rather than eyeballing: a
// wrong one does not fail loudly, it spends an attempt on someone who was never
// going to be shown a sheet, and the quota is gone with nothing recorded.

var failures = 0, checks = 0
func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond { print("ok   - \(msg)") } else { failures += 1; print("FAIL - \(msg)") }
}
let now = Date(timeIntervalSince1970: 1_800_000_000)
func days(_ n: Double) -> Date { now.addingTimeInterval(-n * 86_400) }

/// A user who has earned the ask: two renders, one export, nothing failed.
func good() -> FeedbackGate.State {
    var s = FeedbackGate.State()
    s.successfulRenderCount = 2
    s.exportCount = 1
    return s
}

@main
struct ReviewPromptTestMain {
static func main() {

check(FeedbackGate.reviewPromptEligible(state: good(), now: now),
      "two renders, one export, nothing failed, never asked -> ask")

// NEVER BEFORE THEIR FIRST VIDEO, and not on a single lucky one.
var s = good(); s.successfulRenderCount = 0
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "no successful render -> never")
s = good(); s.successfulRenderCount = 1
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "one render is not a pattern -> refuse")

// THEY MUST HAVE TAKEN SOMETHING OUT OF THE APP.
s = good(); s.exportCount = 0
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "never exported -> refuse")

// THE ONE-STAR CONDITION. A user whose render died this session is exactly who
// leaves a one-star, and they are the likeliest to review unprompted anyway.
s = good(); s.failedRenderInSession = true
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "a failed render this session -> refuse, however good the rest looks")
s = good(); s.failedRenderInSession = true; s.successfulRenderCount = 50; s.exportCount = 40
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "the failure condition is not outvoted by a long good history")

// ONCE, THEN A LONG SILENCE.
s = good(); s.lastAppStorePromptAt = days(1)
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "asked yesterday -> refuse")
s = good(); s.lastAppStorePromptAt = days(FeedbackGate.REVIEW_REASK_DAYS - 1)
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "one day short of the re-ask window -> still refuse")
s = good(); s.lastAppStorePromptAt = days(FeedbackGate.REVIEW_REASK_DAYS)
check(FeedbackGate.reviewPromptEligible(state: s, now: now),
      "exactly the re-ask window, and exporting again -> ask")

// AND THE RE-ASK IS EARNED, NOT MERELY WAITED OUT. The calendar alone is not
// enough: the conditions still have to hold at the moment of the second ask.
s = good(); s.lastAppStorePromptAt = days(400); s.failedRenderInSession = true
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "a year later but a render just failed -> refuse")
s = good(); s.lastAppStorePromptAt = days(400); s.exportCount = 0
check(!FeedbackGate.reviewPromptEligible(state: s, now: now),
      "a year later but nothing exported since -> refuse")

// THE INTERVAL IS LONGER THAN THE IN-APP PROMPT'S. The two cadences are
// separate on purpose; the scarce one must not inherit the chatty one.
check(FeedbackGate.REVIEW_REASK_DAYS > FeedbackGate.COOLDOWN_DAYS.max()!,
      "the review re-ask window is longer than the longest in-app cooldown")

print("\n\(checks - failures)/\(checks) checks passed")
if failures > 0 { exit(1) }
}
}
