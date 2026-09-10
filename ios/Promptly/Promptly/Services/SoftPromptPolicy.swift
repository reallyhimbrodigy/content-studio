import Foundation

/// WHEN MAY WE ASK FOR NOTIFICATION PERMISSION AGAIN?
///
/// THE DEFECT THIS REPLACES. `shouldOfferSoftPrompt` was
/// `!hasAskedForPermission && !didOfferSoftPrompt`, and `markSoftPromptOffered()`
/// was called from BOTH alert buttons. So one "Not now" — a deferral, the mildest
/// thing a user can say — set a permanent flag, and the user was never asked
/// again on that install. 1,056 users have no push token because of it.
///
/// The part that made it unrecoverable: the delivery primer, built specifically
/// to re-ask these people at a better moment, guarded on that same flag
/// (`guard !didOfferDeliveryPrimer, shouldOfferSoftPrompt`). It was dead for
/// exactly the population it existed to recover, and it called
/// markSoftPromptOffered() itself, so showing it also spent the future.
///
/// A deferral now sets a DATE, not a flag. "Not now" means not now.
///
/// WHY THIS TYPE IS PURE. It touches no UserDefaults, no UNUserNotificationCenter
/// and no clock — every input arrives as a parameter, `now` included. That is
/// what lets __test_soft_prompt_policy.swift compile and run it directly and
/// exercise the RE-ASK, not just the first ask. The re-ask is the whole change;
/// a test that only proves the first ask still works would pass identically
/// against the code being replaced.
enum SoftPromptPolicy {

    /// Total soft asks a user may ever see. Three, not unlimited: a deferral is
    /// not consent, and someone who has said "not now" twice has told us
    /// something. The cap is what keeps "ask again" from becoming a nag.
    static let maxOffers = 3

    /// Gap after the 1st decline, then after the 2nd. The first gap is short
    /// enough that a returning user is still the same user with the same
    /// problem; the second is long enough to be an apology.
    static let retryGaps: [TimeInterval] = [7 * 86_400, 30 * 86_400]

    struct State {
        /// The iOS system dialog has been shown at least once on this install.
        /// This is a HARD stop and always has been: iOS grants exactly one
        /// prompt, so after it there is nothing left to ask for in-app.
        var systemDialogSeen: Bool
        /// How many times the user has said "not now" to the in-app explainer.
        var declineCount: Int
        /// Earliest moment we may offer again. nil = no bar.
        var retryAfter: Date?
        /// The legacy `didOfferSoftPrompt` boolean, still on 1,056 devices.
        var legacyOfferedFlag: Bool
        /// Whether this install has been through the new bookkeeping yet.
        /// False means `declineCount`/`retryAfter` were never written and the
        /// legacy flag is all we have.
        var migrated: Bool
    }

    /// What the legacy flag means, read honestly. A set `didOfferSoftPrompt`
    /// with the system dialog STILL unseen can only be a "Not now" — an accept
    /// would have reached requestPermissionIfNeeded() and set the asked flag.
    /// So it is exactly one decline, at an unknown date.
    static func effectiveDeclines(_ s: State) -> Int {
        if s.migrated { return s.declineCount }
        return s.legacyOfferedFlag ? 1 : 0
    }

    /// THE RECOVERY, and the reason it is one line. A legacy decline carries no
    /// date, so it gets no bar — `retryAfter` is nil and the user is eligible at
    /// their next moment of delight. Their decline is at least as old as the
    /// build that recorded it, so any gap we would have set has already elapsed
    /// several times over. Backdating it would be inventing a fact; treating it
    /// as expired is reading the one we have.
    static func shouldOffer(_ s: State, now: Date) -> Bool {
        if s.systemDialogSeen { return false }
        if effectiveDeclines(s) >= maxOffers { return false }
        guard let retry = s.retryAfter else { return true }
        return now >= retry
    }

    /// The bar to set after a decline. `declines` is the count INCLUDING the one
    /// just recorded, so the first decline picks retryGaps[0].
    static func nextRetry(afterDeclines declines: Int, from now: Date) -> Date {
        let index = min(max(declines - 1, 0), retryGaps.count - 1)
        return now.addingTimeInterval(retryGaps[index])
    }
}
