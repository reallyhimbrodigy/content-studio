import Foundation

// Standalone unit tests for the pure FeedbackGate decision math. The Xcode
// project has no test target, and these need none — the type is Foundation-only,
// so we compile it together with this file and run natively:
//
//   swiftc ../Promptly/Views/FeedbackGate.swift FeedbackGateTests.swift -o /tmp/feedbacktest && /tmp/feedbacktest
//
// (or: ios/Promptly/Tests/run.sh). Exit code is non-zero if any check fails.

var failures = 0
var checks = 0

func check(_ cond: Bool, _ msg: String) {
    checks += 1
    if cond {
        print("ok   - \(msg)")
    } else {
        failures += 1
        print("FAIL - \(msg)")
    }
}

// A fixed synthetic clock so every test is deterministic regardless of when it
// runs. All `now` values are offsets from this base.
let base = Date(timeIntervalSince1970: 1_700_000_000)
func days(_ d: Double) -> TimeInterval { d * 86_400 }
func at(_ d: Double) -> Date { base.addingTimeInterval(days(d)) }

@main
struct FeedbackGateTestMain {
static func main() {

let day = days(1)

// 1. First-render skip — below MIN_RENDERS we never prompt, even with no
//    prior prompt on record.
check(FeedbackGate.MIN_RENDERS == 2, "MIN_RENDERS is 2")
let fresh = FeedbackGate.State(successfulRenderCount: 1, lastPromptAt: nil)
check(FeedbackGate.shouldShowPrompt(state: fresh, now: base) == false,
      "1 render (< MIN_RENDERS) never prompts")
let zero = FeedbackGate.State(successfulRenderCount: 0, lastPromptAt: nil)
check(FeedbackGate.shouldShowPrompt(state: zero, now: base) == false,
      "0 renders never prompts")

// 2. Earned the renders, never prompted before -> prompt is due immediately.
let earnedNeverPrompted = FeedbackGate.State(successfulRenderCount: 2, lastPromptAt: nil)
check(FeedbackGate.shouldShowPrompt(state: earnedNeverPrompted, now: base) == true,
      ">=MIN_RENDERS with no prior prompt shows the prompt")

// 3. Cooldown not-elapsed vs elapsed (streak 0 -> 14 days).
check(FeedbackGate.COOLDOWN_DAYS == [14, 30, 60], "COOLDOWN_DAYS is [14, 30, 60]")
let promptedNow = FeedbackGate.State(successfulRenderCount: 5,
                                     lastPromptAt: base,
                                     ignoreStreak: 0)
// 13 days after a streak-0 prompt: still inside the 14-day cooldown.
check(FeedbackGate.shouldShowPrompt(state: promptedNow, now: base.addingTimeInterval(days(13))) == false,
      "streak 0: 13 days after prompt is still within 14d cooldown (no prompt)")
// 15 days after: cooldown elapsed.
check(FeedbackGate.shouldShowPrompt(state: promptedNow, now: base.addingTimeInterval(days(15))) == true,
      "streak 0: 15 days after prompt is past 14d cooldown (prompt)")

// 4. Render count >= 2 just past the cooldown boundary shows the prompt
//    (exactly at the boundary the elapsed time is == cooldown, which is not
//    < cooldown, so it is eligible).
check(FeedbackGate.shouldShowPrompt(state: promptedNow, now: base.addingTimeInterval(days(14))) == true,
      "streak 0: exactly at 14d boundary shows the prompt")
check(FeedbackGate.shouldShowPrompt(state: promptedNow, now: base.addingTimeInterval(days(14) + 1)) == true,
      "streak 0: one second past 14d shows the prompt")

// 5. Back-off growth — streak 0/1/2 map to 14/30/60 day cooldowns.
check(FeedbackGate.cooldown(ignoreStreak: 0) == 14 * day, "cooldown(0) == 14 days")
check(FeedbackGate.cooldown(ignoreStreak: 1) == 30 * day, "cooldown(1) == 30 days")
check(FeedbackGate.cooldown(ignoreStreak: 2) == 60 * day, "cooldown(2) == 60 days")
// Clamped: any streak beyond the table length stays at the longest cadence.
check(FeedbackGate.cooldown(ignoreStreak: 3) == 60 * day, "cooldown(3) clamps to 60 days")
check(FeedbackGate.cooldown(ignoreStreak: 99) == 60 * day, "cooldown(99) clamps to 60 days")
// Negative streak is safe (clamps to the shortest).
check(FeedbackGate.cooldown(ignoreStreak: -5) == 14 * day, "cooldown(-5) clamps to 14 days")

// Streak 1 (30d) and streak 2 (60d) honor their longer windows.
let streak1 = FeedbackGate.State(successfulRenderCount: 5, lastPromptAt: base, ignoreStreak: 1)
check(FeedbackGate.shouldShowPrompt(state: streak1, now: base.addingTimeInterval(days(29))) == false,
      "streak 1: 29 days is within 30d cooldown (no prompt)")
check(FeedbackGate.shouldShowPrompt(state: streak1, now: base.addingTimeInterval(days(31))) == true,
      "streak 1: 31 days is past 30d cooldown (prompt)")
let streak2 = FeedbackGate.State(successfulRenderCount: 5, lastPromptAt: base, ignoreStreak: 2)
check(FeedbackGate.shouldShowPrompt(state: streak2, now: base.addingTimeInterval(days(59))) == false,
      "streak 2: 59 days is within 60d cooldown (no prompt)")
check(FeedbackGate.shouldShowPrompt(state: streak2, now: base.addingTimeInterval(days(61))) == true,
      "streak 2: 61 days is past 60d cooldown (prompt)")

// 6. Reset on answer — the manager zeroes the streak when the user answers,
//    which drops the cooldown back to the short 14d cadence. Model that by
//    comparing a high-streak state to its post-answer (streak 0) form: at day
//    20 the streak-2 user is muted but the reset user is eligible again.
let beforeAnswer = FeedbackGate.State(successfulRenderCount: 5, lastPromptAt: base, ignoreStreak: 2)
let afterAnswer  = FeedbackGate.State(successfulRenderCount: 5, lastPromptAt: base, ignoreStreak: 0,
                                      lastAnswerAt: base.addingTimeInterval(days(1)))
check(FeedbackGate.shouldShowPrompt(state: beforeAnswer, now: base.addingTimeInterval(days(20))) == false,
      "pre-answer (streak 2): still muted at day 20")
check(FeedbackGate.shouldShowPrompt(state: afterAnswer, now: base.addingTimeInterval(days(20))) == true,
      "post-answer (streak reset to 0): eligible again at day 20")

// 7. appStoreReviewEligible — nil, < 90 days, >= 90 days.
check(FeedbackGate.APPSTORE_MIN_INTERVAL_DAYS == 90, "APPSTORE_MIN_INTERVAL_DAYS is 90")
let neverAsked = FeedbackGate.State(lastAppStorePromptAt: nil)
check(FeedbackGate.appStoreReviewEligible(state: neverAsked, now: base) == true,
      "App Store review eligible when never asked (nil)")
let askedRecently = FeedbackGate.State(lastAppStorePromptAt: base)
check(FeedbackGate.appStoreReviewEligible(state: askedRecently, now: base.addingTimeInterval(days(89))) == false,
      "App Store review NOT eligible 89 days after last ask")
check(FeedbackGate.appStoreReviewEligible(state: askedRecently, now: base.addingTimeInterval(days(90))) == true,
      "App Store review eligible exactly 90 days after last ask")
check(FeedbackGate.appStoreReviewEligible(state: askedRecently, now: base.addingTimeInterval(days(120))) == true,
      "App Store review eligible 120 days after last ask")

print("\n\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)

}
}
