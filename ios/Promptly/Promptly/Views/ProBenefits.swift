import SwiftUI

/// THE single source of what Pro is worth. Every surface that lists Pro
/// benefits reads from here — none of them owns a list.
///
/// WHY THIS EXISTS (2026-08-28). "Upload up to 10 videos at a time" appeared on
/// the offer reveal and was missing from the first-launch paywall, so the two
/// screens a new user sees back-to-back made different promises about the same
/// product. The cause was not a typo: FirstLaunchPaywallView hard-coded three
/// `benefitRow(...)` calls inline while OfferReveal.benefitLines built four
/// somewhere else. They shared nothing, so they could not help but drift, and
/// nothing could detect it — each file read perfectly on its own.
///
/// The structural guarantee: `personalised(...)` does not re-list the claims.
/// It takes `core` and SUBSTITUTES the first two entries with the user's own
/// words. The count and the tail are therefore invariant by construction — a
/// claim added to `core` appears on every surface, personalised or not, and it
/// is not possible to add one to a single screen.
enum ProBenefits {

    struct Benefit: Hashable, Identifiable {
        let icon: String
        let text: String
        var id: String { text }
    }

    /// The canonical claims, IN PITCH ORDER. Adding a claim here adds it
    /// everywhere. This is the only place a Pro benefit string may be written.
    ///
    /// ── UNIFICATION, prepared 2026-08-28, PENDING ZAC'S RULING ──────────────
    /// Four surfaces each owned a list, and they disagreed three ways about the
    /// same product:
    ///
    ///   unlimited videos  "Unlimited videos, no daily cap"   (this file)
    ///                     "Unlimited renders"                (main paywall)
    ///                     "Unlimited videos, every day"      (celebration)
    ///   upload ten        "Upload up to 10 videos at a time" (2 surfaces)
    ///                     "Upload up to 10 at once"          (celebration)
    ///
    /// Worse than the wording: the COVERAGE gaps. The two screens a new user
    /// sees never mentioned "Unlimited AI chats" or "Save and share every
    /// video" at all, and the main paywall never mentioned that captions, cuts
    /// and graphics are automatic — which is the actual product.
    ///
    /// The three decisions, isolated here so changing one is a one-line edit:
    ///   1. "Unlimited videos, no daily cap" over "Unlimited renders" —
    ///      "renders" is our vocabulary, not the user's, and the daily cap is
    ///      the specific thing Pro removes.
    ///   2. "Upload up to 10 videos at a time" — the majority spelling, and it
    ///      says what "at once" leaves ambiguous.
    ///   3. The set is the UNION of all four lists, so no surface can make a
    ///      claim another one contradicts.
    ///
    /// Surfaces that need a shorter list take a PREFIX of this array rather
    /// than picking their own subset. That is what keeps a compact screen
    /// consistent with a long one instead of merely shorter: the order is the
    /// pitch priority, so the first three claims are the three best claims
    /// everywhere, and a surface can never elevate a minor benefit above a
    /// major one or omit something the screen before it promised.
    /// Monthly video allowance per tier, once the credits meter is live.
    /// 10 credits per video, flat: Free 30/mo = 3, Pro 200 = 20, Max 1000 = 100.
    /// Derived here rather than written into copy so the claim and the meter
    /// cannot drift — the number a user reads is computed from the same
    /// constant the balance is.
    static let creditsPerVideo = 10
    static func monthlyVideos(credits: Int) -> Int { credits / creditsPerVideo }

    /// The allowance for the user's CURRENT tier, derived from the products
    /// StoreKit returned. nil when they are on free, when no product matches,
    /// or when offerings have not loaded — and nil is the safe answer in all
    /// three, because it means the claim falls back to wording that does not
    /// state a number.
    @MainActor
    static func storeKitAllowance() -> Int? {
        guard SubscriptionService.shared.effectiveIsPro else { return nil }
        let ids = (SubscriptionService.shared.offerings?.current?.availablePackages ?? [])
            .map(\.storeProduct.productIdentifier)
        // Highest matched allowance: a subscriber holding several products
        // should be described by the best one they actually have.
        return ids.compactMap { CreditAllowance.monthly(forProductId: $0) }.max()
    }

    /// The headline claim, which MUST match whichever meter is actually running.
    ///
    /// "Unlimited videos, no daily cap" is true today and becomes FALSE the
    /// moment credits ship — Pro at 200/month is 20 videos, a cap. So the claim
    /// is chosen by the same flag that arms the meter: unlimited while the
    /// meter is off, the real number once it is on. Shipping the number early
    /// would be false in the other direction, which is the failure mode that is
    /// easy to miss because it reads as conservative.
    static func headlineVideoClaim(creditsEnabled: Bool, monthlyCredits: Int?) -> Benefit {
        guard creditsEnabled, let c = monthlyCredits, c > 0 else {
            return Benefit(icon: "infinity", text: String(localized: "Unlimited videos, no daily cap"))
        }
        return Benefit(icon: "infinity",
                       text: String(localized: "\(monthlyVideos(credits: c)) videos a month"))
    }

    /// The paywall SUBTITLE, gated by the same flag as the benefit row.
    ///
    /// THE BENEFIT ROW WAS GATED AND THIS WAS NOT, which is a worse state than
    /// neither being gated: the moment credits arm, the checklist would switch
    /// to "20 videos a month" while the sentence directly above it still said
    /// "one free video a day — everything, unlimited". One screen, two limits,
    /// contradicting each other.
    ///
    /// WHAT IS ACTUALLY TRUE, verified against lib/tier-capabilities.js rather
    /// than assumed, because the answer decides whether this is a bug or a
    /// cosmetic worry:
    ///   credits DARK (live today): free renderLimit = FREE_DAILY_RENDERS = 1
    ///     per DAY, Pro renderLimit = Infinity. So "one free video a day" and
    ///     "everything, unlimited" are both TRUE right now. The pre-credits copy
    ///     is correct-for-now; it only LOOKS stale.
    ///   credits ARMED: free 30/month = 3 videos, Pro 200/month = 20. Both
    ///     halves become false together.
    ///
    /// So this ships the honest sentence in each state rather than rewriting to
    /// the credit numbers early — which would be false in the other direction,
    /// the failure mode that reads as conservative and therefore goes unnoticed.
    @MainActor
    static var paywallSubtitle: String {
        let o = OnboardingState.shared
        guard o.creditsEnabled, let monthly = o.creditsMonthlyAllowance, monthly > 0 else {
            return String(localized: "Go beyond your one free video a day — everything, unlimited.")
        }
        return String(localized: "\(monthlyVideos(credits: monthly)) videos a month, and every feature unlocked.")
    }

    /// The MAX claim, shown only when a Max product is actually on offer.
    ///
    /// Gated on the credits flag with everything else, because "100 videos a
    /// month" is a credits statement — with the meter dark there is no such
    /// number and the line would be describing a product the user cannot get.
    ///
    /// The 100 is DERIVED, not typed: Max maps to 1000 credits and a video
    /// costs 10, so the claim and the meter cannot drift. If Zac configures Max
    /// at a different allowance, this sentence follows without an edit.
    @MainActor
    static func maxClaim(monthlyCredits: Int) -> Benefit {
        Benefit(icon: "sparkles",
                text: String(localized: "\(monthlyVideos(credits: monthlyCredits)) videos a month, plus early access to new features"))
    }

    /// `core` is now COMPUTED, not a constant, and that is the whole fix.
    ///
    /// `headlineVideoClaim` existed with the right logic and ZERO CALLERS — the
    /// only mention of it outside this file was a comment. So the claim that was
    /// supposed to switch when the meter arms was never on any screen: every
    /// paywall read this array, and this array said "Unlimited" unconditionally.
    /// The rewrite was not covered and did not regress; it was never wired.
    ///
    /// A static array cannot answer a question about runtime state, so the
    /// first row has to be resolved when it is read. Every surface reads `core`,
    /// so wiring it here reaches all of them at once — the same reason the list
    /// was centralised in the first place.
    /// @MainActor because it reads OnboardingState, which is MainActor-isolated.
    /// Every caller is already a SwiftUI view body, so this costs nothing — and
    /// the compiler refusing the nonisolated read is the correct outcome: a
    /// paywall claim resolved off the main actor could disagree with the flag
    /// the rest of the screen is drawing from.
    @MainActor
    static var core: [Benefit] {
        [
        // Allowance from the SERVER first, then derived from the StoreKit
        // products actually on offer. The second source is what makes a Max
        // tier appear the moment Zac configures it — no client build, no
        // hardcoded third row — and it also means the claim survives a server
        // field that has not shipped yet. Both nil still falls back to the
        // unlimited wording rather than inventing a number.
        headlineVideoClaim(creditsEnabled: OnboardingState.shared.creditsEnabled,
                           monthlyCredits: OnboardingState.shared.creditsMonthlyAllowance
                                           ?? storeKitAllowance()),
        Benefit(icon: "captions.bubble.fill",
                text: String(localized: "Captions, cuts and graphics — automatic")),
        Benefit(icon: "arrow.uturn.left",
                text: String(localized: "Re-edit any finished video")),
        Benefit(icon: "square.stack.3d.up.fill",
                text: String(localized: "Upload up to 10 videos at a time")),
        Benefit(icon: "bubble.left.and.bubble.right.fill",
                text: String(localized: "Unlimited AI chats")),
        Benefit(icon: "square.and.arrow.down",
                text: String(localized: "Save and share every video")),
        ]
    }

    /// The first `n` claims, for surfaces with less room. Never a hand-picked
    /// subset — see the note on `core`.
    @MainActor
    static func top(_ n: Int) -> [Benefit] { Array(core.prefix(max(0, n))) }

    /// The same claim SET, with the first two lines rewritten in the user's own
    /// terms from Q1 (who the videos are for) and Q2 (what kind). A skipped
    /// question falls back to the generic claim it replaces, so the list is
    /// always the same length as `core`.
    ///
    /// Note it substitutes BY INDEX into `core` rather than rebuilding a list:
    /// that is what makes the tail impossible to drift.
    @MainActor
    static func personalised(audience: String?, videoType: String?) -> [Benefit] {
        var out = core

        // Slot 0 — what they make. Q2 keys are compound ("podcast:fast"), so
        // this must go through the parser; switching on the raw key silently
        // falls through to the generic line, which is exactly the defect the
        // compound-key gate now prevents.
        let made: String? = {
            switch OnboardingQuestion.contentTypeV2(videoType) {
            case "podcast":     return String(localized: "Every episode into clips, unlimited")
            case "talkinghead": return String(localized: "Every take into a finished cut, unlimited")
            case "vlogs":       return String(localized: "Every vlog cut and captioned, unlimited")
            case "promo":       return String(localized: "Every promo cut and captioned, unlimited")
            default:            return nil
            }
        }()
        substitute(0, with: made, in: &out)

        // Slot 1 — who it is for.
        let who: String? = {
            switch audience {
            case "clients":        return String(localized: "Turn around client work the same day")
            case "small_business": return String(localized: "Keep your business posting without an editor")
            case "employer":       return String(localized: "Ship team video without a production queue")
            default:               return nil
            }
        }()
        substitute(1, with: who, in: &out)

        return out
    }

    /// Replace slot `i`'s TEXT, keeping its icon. Bounds-checked on purpose.
    ///
    /// The raw `out[0] = ...` this replaces was safe only because `core`
    /// happens to hold four entries. But `core` is the one place claims are
    /// meant to be edited — that is the entire point of it — so a future
    /// trim to a single claim would have crashed the first screen of the app
    /// for every new user, from a change that looks like pure copy. A
    /// hard-coded index into an intentionally-editable list is a trap with a
    /// delay on it. Out of range now simply means "no personalisation",
    /// which degrades to the generic claim rather than terminating.
    private static func substitute(_ i: Int, with text: String?, in list: inout [Benefit]) {
        guard let text, list.indices.contains(i) else { return }
        list[i] = Benefit(icon: list[i].icon, text: text)
    }

    /// Text-only convenience for surfaces that render their own row style.
    @MainActor
    static func lines(audience: String? = nil, videoType: String? = nil) -> [String] {
        personalised(audience: audience, videoType: videoType).map(\.text)
    }
}
