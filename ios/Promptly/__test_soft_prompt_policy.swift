// Runs directly: swiftc -parse-as-library is not needed, just
//   swiftc -o /tmp/t ios/Promptly/Promptly/Services/SoftPromptPolicy.swift \
//          ios/Promptly/__test_soft_prompt_policy.swift && /tmp/t
// Driven by push-soft-prompt-gate.sh, which is what the pre-push hook runs.
//
// THE POINT OF THIS FILE: it exercises the RE-ASK. A test that only proves the
// first ask still works would pass, unchanged, against the exact code this
// replaces — the first ask was never broken. What was broken is everything
// after "Not now", so that is what is asserted here.
import Foundation

@main
struct SoftPromptPolicyTests {
    static func main() {
        var failures = 0
        func check(_ cond: Bool, _ what: String) {
            if cond { return }
            FileHandle.standardError.write(Data("  FAIL: \(what)\n".utf8))
            failures += 1
        }

        let t0 = Date(timeIntervalSince1970: 1_780_000_000)
        let day = 86_400.0

        func fresh() -> SoftPromptPolicy.State {
            .init(systemDialogSeen: false, declineCount: 0, retryAfter: nil,
                  legacyOfferedFlag: false, migrated: true)
        }

        // ── 1. the first ask, which was never the problem ───────────────────────────
        check(SoftPromptPolicy.shouldOffer(fresh(), now: t0), "a fresh install is offered")

        // ── 2. THE RE-ASK. One "Not now" is a deferral, not an answer ───────────────
        var s = fresh()
        s.declineCount = 1
        s.retryAfter = SoftPromptPolicy.nextRetry(afterDeclines: 1, from: t0)
        check(!SoftPromptPolicy.shouldOffer(s, now: t0), "silent immediately after a decline")
        check(!SoftPromptPolicy.shouldOffer(s, now: t0.addingTimeInterval(6 * day)),
              "still silent a day before the gap elapses")
        check(SoftPromptPolicy.shouldOffer(s, now: t0.addingTimeInterval(7 * day)),
              "ASKS AGAIN once the gap elapses — this is the whole change, and it is "
              + "the assertion that fails against the flag-based predicate")
        check(SoftPromptPolicy.shouldOffer(s, now: t0.addingTimeInterval(400 * day)),
              "and long after")

        // ── 3. the second gap is longer, and the third decline is the last ──────────
        var s2 = fresh()
        s2.declineCount = 2
        s2.retryAfter = SoftPromptPolicy.nextRetry(afterDeclines: 2, from: t0)
        check(!SoftPromptPolicy.shouldOffer(s2, now: t0.addingTimeInterval(29 * day)),
              "the second gap is longer than the first")
        check(SoftPromptPolicy.shouldOffer(s2, now: t0.addingTimeInterval(30 * day)),
              "but it does elapse")
        var s3 = fresh()
        s3.declineCount = 3
        s3.retryAfter = t0
        check(!SoftPromptPolicy.shouldOffer(s3, now: t0.addingTimeInterval(9_999 * day)),
              "three declines is an answer, not a deferral — never ask a fourth time")

        // ── 4. THE 1,056. A legacy flag with the system dialog unseen ───────────────
        var legacy = SoftPromptPolicy.State(
            systemDialogSeen: false, declineCount: 0, retryAfter: nil,
            legacyOfferedFlag: true, migrated: false)
        check(SoftPromptPolicy.effectiveDeclines(legacy) == 1,
              "a legacy flag reads as exactly one decline — an accept would have set "
              + "the system-dialog flag instead")
        check(SoftPromptPolicy.shouldOffer(legacy, now: t0),
              "THE RECOVERY: a user who tapped 'Not now' on an old build is eligible "
              + "now. Their decline carries no date and is older than the build that "
              + "wrote it, so no gap we would have set is still running.")
        legacy.legacyOfferedFlag = false
        check(SoftPromptPolicy.shouldOffer(legacy, now: t0),
              "an unmigrated install that never declined is simply fresh")

        // ── 5. the hard stop that must survive all of this ──────────────────────────
        var seen = fresh()
        seen.systemDialogSeen = true
        check(!SoftPromptPolicy.shouldOffer(seen, now: t0.addingTimeInterval(9_999 * day)),
              "the iOS dialog is a one-shot: once shown, NEVER soft-ask again, whatever "
              + "the retry date says")
        var seenLegacy = legacy
        seenLegacy.systemDialogSeen = true
        seenLegacy.legacyOfferedFlag = true
        check(!SoftPromptPolicy.shouldOffer(seenLegacy, now: t0),
              "and the legacy path must not route around it either")

        // ── 6. the gap schedule itself ──────────────────────────────────────────────
        check(SoftPromptPolicy.nextRetry(afterDeclines: 1, from: t0) == t0.addingTimeInterval(7 * day), "gap 1 = 7d")
        check(SoftPromptPolicy.nextRetry(afterDeclines: 2, from: t0) == t0.addingTimeInterval(30 * day), "gap 2 = 30d")
        check(SoftPromptPolicy.nextRetry(afterDeclines: 9, from: t0) == t0.addingTimeInterval(30 * day),
              "past the end of the table it clamps rather than crashing")

        if failures > 0 {
            FileHandle.standardError.write(Data("[soft-prompt-policy] \(failures) FAILED\n".utf8))
            exit(1)
        }
        print("[soft-prompt-policy] ALL PASS — re-ask after a gap, gap escalates, cap at 3, "
              + "legacy 'Not now' recovers, iOS one-shot still absolute")

    }
}
