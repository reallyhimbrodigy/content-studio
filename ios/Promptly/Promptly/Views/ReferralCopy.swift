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
    /// I FIRST WROTE "Invite 3 friends who make a video — get a week of Pro"
    /// and claimed it was correct under BOTH candidate rulings. It is not, and
    /// trial-copy-gate caught it: under the 2/4/7 LADDER the reward starts at
    /// friend ONE, so naming three states a quota that does not exist and hides
    /// the 2 days already earned. The gate's rule says exactly that — "states a
    /// quota before the first share; the ladder pays from invite one" — which
    /// is a ruling that predates me and that I walked straight into.
    ///
    /// So the two candidate rulings genuinely need DIFFERENT copy and no single
    /// string covers both:
    ///   ladder 2/4/7  -> pays from friend one, so no number belongs in the
    ///                    headline. This wording.
    ///   flat 3 -> 7   -> a quota IS the truth, and the headline must say three.
    ///                    That wording would fail the gate as written, because
    ///                    the gate encodes the ladder assumption. If Zac rules
    ///                    flat, the RULE has to move too — not be worked around.
    ///
    /// Written for the ladder, which is the standing ruling.
    ///
    /// The string is already in the catalog and already translated x11 — it was
    /// written for the second paywall and is the same promise.
    static let offer = String(localized: "Every friend who makes a video earns you free Pro")

    /// The paywall's invite line — RULED FLAT 2026-09-01.
    ///
    /// This states the quota, which the standing rule banned. The ban was
    /// premised on the LADDER ("the first successful invite pays"), and the
    /// ladder was never confirmed: `ladderConfirmed` is still false and the
    /// server has always granted at THREE (`rewardTarget = 3`, seven days). So
    /// the premise was the stale half, not the copy.
    ///
    /// With a flat 3-to-7 grant, naming three is the honest wording and hiding
    /// it is the dishonest one: a user told "every friend earns you free Pro"
    /// gets nothing for their first two successful invites, discovers that only
    /// by counting, and concludes the reward does not arrive. The rule moved to
    /// match the product rather than the copy being bent around the rule — the
    /// resolution my own note on `offer` prescribed for exactly this case.
    static let inviteOffer = String(localized: "Or invite 3 friends and get 1 week of Promptly Pro free.")

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

    /// Progress toward the reward, WITH the denominator.
    ///
    /// THE NO-DENOMINATOR RULE IS OBSOLETE, and this is the reasoning rather
    /// than an override. It was written for the LADDER, where the reward paid
    /// from friend one and no single target existed — naming "3" then would
    /// have invented a threshold the product did not have. The ruling is now
    /// FLAT: three qualified friends, one week, no intermediate rewards. Under
    /// flat, three IS the target, and hiding it makes the surface useless —
    /// "2 people have made a video" tells a user nothing about how close they
    /// are to the thing they are working toward.
    ///
    /// THE GATE AGREES, checked rather than assumed. trial-copy-gate's
    /// INVITE_QUOTA_RE flags a quota HEADLINE ("Invite 3 friends who…") and
    /// does not flag "%lld of %lld friends joined" — verified by probing it
    /// with both forms before writing this. So no carve-out was needed: the
    /// rule already distinguished a demand from a progress report, which is the
    /// real difference. A headline states a price of entry; a progress line
    /// reports where you already are.
    static func progress(_ qualified: Int, target: Int = ReferralService.rewardTarget) -> String {
        String(localized: "\(qualified) of \(target) friends joined")
    }

    /// The line under the progress count — what the count is FOR. Kept separate
    /// so the number and the promise can be styled differently, and so a
    /// surface with no room can show the count alone.
    static let progressReward = String(localized: "Get a free week of Pro when all 3 have made a video")

    /// Shown the moment the third friend qualifies, before the grant lands.
    static let progressComplete = String(localized: "All 3 friends are in — your free week is on the way")

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
