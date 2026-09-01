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

    /// The offer, stated once. Referrer-only, tied to completed videos.
    ///
    /// CORRECTED 2026-09-01. This said "A day of Pro each time someone you
    /// invite makes their first video" — wrong on BOTH halves of the ruled
    /// reward. It is not a day, and it is not per referral: the reward is a week
    /// of Pro for THREE qualified referrals. The old wording promised roughly
    /// seven times more Pro per referral than the product grants, on the one
    /// surface whose entire job is to be believed, in twelve languages.
    ///
    /// This wording is correct under BOTH candidate rulings — the 2/4/7 ladder
    /// and a flat 3-to-7 — because both agree on the headline: three friends,
    /// one week. The ladder question only decides whether the INTERMEDIATE
    /// milestones are named, which is `ladderDetail` below and a one-line
    /// change either way. Stating only the part both rulings share is what lets
    /// this ship before the ruling lands.
    ///
    /// The string is already in the catalog and already translated x11 — it was
    /// written for the second paywall and is the same promise.
    static let offer = String(localized: "Invite 3 friends who make a video — get a week of Pro")

    /// The intermediate rewards, shown only if the LADDER survives Zac's
    /// ruling. Nil under a flat 3-to-7, where naming a partial reward that does
    /// not exist would repeat the defect this comment documents.
    ///
    /// PENDING: ladder 2/4/7 vs flat 3 -> 7. Set `ladderConfirmed` when ruled.
    static let ladderConfirmed = false
    static var ladderDetail: String? {
        guard ladderConfirmed else { return nil }
        return String(localized: "1 friend gets you 2 days, 2 gets you 4, 3 gets you a week")
    }

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

    // MARK: - The shared message

    /// The message body, as approved. Deliberately says nothing about a reward:
    ///
    ///  • No "download it here" — iMessage, WhatsApp and every other target
    ///    already render the link as a rich bubble, so the instruction is noise
    ///    that pushes the actual claim further down the message.
    ///  • No "counts toward my free week". It tells the recipient they are doing
    ///    the sender a favour, which is a weaker opening than the product claim
    ///    on its own, and it is the clause that would make this read two-sided.
    ///  • Nothing is offered to the recipient, which is what keeps the loop
    ///    referrer-only and compliant under guideline 3.2.2 (see rule 1 above).
    ///
    /// "ChatGPT" stays literal in every translation. It is the comparison that
    /// does the explaining — substituting a local equivalent (or transliterating
    /// it) loses the one reference the reader already understands.
    static let shareBody = String(localized: "It's like ChatGPT for video editing — you tell it what you want and it edits the whole thing. Captions, cuts, graphics, all of it.")

    /// The invite URL for a code. UPPERCASED at the source: `claim_referral`
    /// resolves codes with `upper(trim(p_code))`, and the landing page echoes
    /// the code back for the paste path, so a lower-case code that survives the
    /// round trip would still resolve — but it would be shown to the user in a
    /// form that does not match what we tell them their code is.
    static func shareURL(code: String) -> URL? {
        let c = code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard !c.isEmpty else { return nil }
        return URL(string: "https://usepromptly.app/?ref=\(c)")
    }

    /// Body + link, the ONE assembly point. Every surface shares this; none
    /// composes its own, which is what stopped four files drifting apart before.
    /// The link goes on its own line so the rich preview attaches to it cleanly.
    static func shareMessage(code: String) -> String {
        guard let url = shareURL(code: code) else { return shareBody }
        return "\(shareBody)\n\n\(url.absoluteString)"
    }
}
