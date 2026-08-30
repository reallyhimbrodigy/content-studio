import Foundation

/// THE single source of referral copy. Every surface renders these; none spells
/// its own.
///
/// WHY (2026-08-29): the string "Invite 3 friends who make a video — get a week
/// of Pro" was duplicated across FOUR files — PaywallView twice, EditorView,
/// SecondPaywallView. Identical text, four homes, no shared source. That is the
/// same defect the Pro benefit claims had, and it drifts the same way: change
/// the ladder and three surfaces keep promising the old one.
///
/// THREE RULES THIS FILE ENCODES, each with a different reason:
///
/// 1. REFERRER-ONLY, permanently. Apple permits rewarding the person who
///    sends an invite. Rewarding the person who RECEIVES it, for downloading or
///    registering, is a rejection under guideline 3.2.2 — which targets
///    incentivised installs. Two-sided is the industry default, so it will be
///    proposed again in good faith; the banned-copy gate is what makes that
///    conversation happen before App Review rather than during it.
///
/// 2. NO QUOTA. The old copy stated "3 friends" before the user had shared
///    once, so a first successful invite read as a third of a reward. The
///    ladder exists precisely so invite one pays. Progress is shown as a count
///    with no denominator — there is nothing to fail at.
///
/// 3. FRAMED ON WHAT THEY MAKE, not on signing up. A reward for a signup is
///    both the Apple-sensitive framing and the fraud-exposed one: emails are
///    free to mint, a finished render is not. Qualification is the referred
///    user's first completed render, and the copy says so plainly rather than
///    implying a reward for installing.
enum ReferralCopy {

    /// The offer, stated once. Referrer-only, no quota, tied to a completed video.
    static let offer = String(localized: "A day of Pro each time someone you invite makes their first video")

    /// Section heading on surfaces that host the invite.
    static let heading = String(localized: "Get Pro free")

    /// The share-sheet CTA.
    static let shareAction = String(localized: "Share your invite link")

    /// Progress, with NO denominator — see rule 2. A target would reintroduce
    /// the quota this copy exists to remove.
    static func progress(_ qualified: Int) -> String {
        qualified == 1
            ? String(localized: "1 person you invited has made a video")
            : String(localized: "\(qualified) people you invited have made a video")
    }

    /// Shown only once a reward has actually been granted, never as a promise.
    /// A reward the user cannot see is worse than no reward, so this states what
    /// landed rather than what might.
    static func granted(days: Int) -> String {
        days == 1
            ? String(localized: "You earned a day of Pro")
            : String(localized: "You earned \(days) days of Pro")
    }
}
