import SwiftUI
import RevenueCat

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
    /// THE INTRO DISCOUNT, AS A WHOLE NUMBER — moved here from the offer reveal
    /// when that screen was deleted, unchanged, so the figure the badge shows is
    /// the one the reveal showed.
    ///
    /// StoreKit's intro against the product's own base price, per territory,
    /// FLOORED so the claim is never rounded up, and capped. Ineligible users
    /// get nil and therefore no badge; a free trial is not a discount and also
    /// returns nil.
    static let maxClaimedIntroPercent = 90

    @MainActor
    static func introPercentOff(for pkg: Package) -> Int? {
        guard SubscriptionService.shared.isEligibleForIntro(pkg.storeProduct) else { return nil }
        guard let intro = pkg.storeProduct.introductoryDiscount,
              intro.paymentMode != .freeTrial else { return nil }
        let std = (pkg.storeProduct.price as NSDecimalNumber).doubleValue
        let off = (intro.price as NSDecimalNumber).doubleValue
        guard std > 0, off < std else { return nil }
        let floored = Int(((1.0 - off / std) * 100.0).rounded(.down))
        guard floored >= 1 else { return nil }
        return min(floored, maxClaimedIntroPercent)
    }

    /// THE INTRO STATED AS MONEY, which is the sell — "$145.99 for your first
    /// year, then $289.99/year". Zac's read is that the amount converts better
    /// than the percentage, so this replaces the billing sub-line for anyone
    /// eligible; the percentage stays as a badge beside the price.
    ///
    /// Every figure comes from StoreKit — the intro's own
    /// `localizedPriceString` and the product's — so it is correct per
    /// territory and never a literal. nil for anyone ineligible, for a free
    /// trial, and for any product with no intro at all (Max and the week carry
    /// none), which is what keeps the badge and this line off those rows.
    @MainActor
    static func introSubline(for pkg: Package, isAnnual: Bool) -> String? {
        guard SubscriptionService.shared.isEligibleForIntro(pkg.storeProduct) else { return nil }
        guard let intro = pkg.storeProduct.introductoryDiscount,
              intro.paymentMode != .freeTrial else { return nil }
        let first = intro.localizedPriceString
        let full = pkg.storeProduct.localizedPriceString
        return isAnnual
            ? String(localized: "\(first) for your first year, then \(full)/year")
            : String(localized: "\(first) for your first month, then \(full)/month")
    }

    /// The badge text for a row: "49% OFF FIRST YEAR" / "50% OFF FIRST MONTH".
    @MainActor
    static func introBadge(for pkg: Package, isAnnual: Bool) -> String? {
        guard let pct = introPercentOff(for: pkg) else { return nil }
        return introBadgeText(pct: pct, isAnnual: isAnnual)
    }

    /// THE PHRASING LIVES HERE, ONCE. The harness poses a badge from posed
    /// prices and would otherwise spell this a second time — which is the fork
    /// benefits-parity exists to catch.
    static func introBadgeText(pct: Int, isAnnual: Bool) -> String {
        isAnnual
            ? String(localized: "\(pct)% OFF FIRST YEAR")
            : String(localized: "\(pct)% OFF FIRST MONTH")
    }


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

    // MARK: - Capacity, stated in videos (258+)

    /// VIDEOS ARE THE ONLY UNIT ANY USER-FACING SURFACE STATES (Zac, on 258).
    ///
    /// Credits were an internal accounting unit that leaked into the pitch:
    /// "200 credits a month — 20 videos" made the reader learn an exchange rate
    /// to evaluate an offer, and every surface that mentioned it had to keep two
    /// numbers agreeing. One unit removes the conversion and the drift together.
    ///
    /// THE NUMBER IS NOT COMPUTED FROM CREDITS. `monthlyVideos(credits:)` would
    /// give Pro 20 (200 ÷ 10); the allowance is 50. The figures are no longer a
    /// function of the meter, so deriving them would silently reintroduce the
    /// old ones. It comes from `videos_limit` on /api/usage and nowhere else.
    static func videosAMonth(_ videos: Int) -> String {
        String(localized: "\(videos) videos a month")
    }

    /// The two qualifiers that make the allowance evaluable. Separate catalog
    /// keys, joined at the end — NOT interpolated into a sentence. The first
    /// version of the Pro capacity claim built one string and let each screen
    /// interpolate a fragment; that minted keys carrying %@ the catalog did not
    /// have and would have dropped eleven locales to English. Each of these is
    /// a whole phrase a translator sees finished.
    static var aiVideosCountAsTwo: String { String(localized: "AI videos count as 2") }
    static var reeditsAreFree: String { String(localized: "re-edits free") }

    /// THE FULL CAPACITY ROW — "50 videos a month · AI videos count as 2 ·
    /// re-edits free". For full-width surfaces: the paywall benefit rows and the
    /// account screen. The narrow tier card uses `videosAMonth` alone, which is
    /// what `cardFeatures` has always been for.
    ///
    /// nil when the server has not sent the tier's allowance, so the caller
    /// states no number at all rather than an invented one.
    static func capacityLine(videos: Int?) -> String? {
        guard let videos, videos > 0 else { return nil }
        return [videosAMonth(videos), aiVideosCountAsTwo, reeditsAreFree]
            .joined(separator: " · ")
    }

    /// The allowance for the user's CURRENT tier, derived from the products
    /// StoreKit returned. nil when they are on free, when no product matches,
    /// or when offerings have not loaded — and nil is the safe answer in all
    /// three, because it means the claim falls back to wording that does not
    /// state a number.
    @MainActor
    /// THE USER'S OWN ALLOWANCE, NOT THE LARGEST ON SALE (Zac, on 248).
    ///
    /// This took `.max()` across every available package, so it returned Max's
    /// 1,000 to EVERY subscriber — a Pro account read "1,000 credits a month —
    /// about 100 videos" when Pro is 200 and about 20. The offering is what is
    /// for sale; the entitlement is what the user holds, and this line is about
    /// what they hold.
    static func storeKitAllowance() -> Int? {
        let sub = SubscriptionService.shared
        guard sub.effectiveIsPro else { return nil }
        let allowances = (sub.offerings?.current?.availablePackages ?? [])
            .map(\.storeProduct.productIdentifier)
            .compactMap { CreditAllowance.monthly(forProductId: $0) }
        guard !allowances.isEmpty else { return nil }
        // Max holds the top tier; anyone else entitled holds the one below it.
        return sub.isMax ? allowances.max() : allowances.min()
    }


    /// The headline claim, which MUST match whichever meter is actually running.
    ///
    /// "Unlimited videos, no daily cap" is true today and becomes FALSE the
    /// moment credits ship — Pro at 200/month is 20 videos, a cap. So the claim
    /// is chosen by the same flag that arms the meter: unlimited while the
    /// meter is off, the real number once it is on. Shipping the number early
    /// would be false in the other direction, which is the failure mode that is
    /// easy to miss because it reads as conservative.
    static func headlineVideoClaim(videos: Int?) -> Benefit {
        guard let line = capacityLine(videos: videos) else {
            // The honest claim while `videos_limit` is absent. Verified against
            // lib/tier-capabilities.js rather than assumed: with the meter dark
            // Pro's renderLimit is Infinity, so this is TRUE today. It stops
            // being true the moment a real allowance lands — which is exactly
            // when the field arrives and this branch stops being taken.
            return Benefit(icon: "infinity", text: String(localized: "Unlimited videos, no daily cap"))
        }
        return Benefit(icon: "infinity", text: line)
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
    /// THE PRO CAPACITY CLAIM, IN ONE PLACE. Both the cap-encounter subtitles and
    /// the lapsed-trial wall need to say what Pro actually gives; each spelled it
    /// for itself and benefits-parity-gate refused the build, correctly. Two
    /// screens owning a copy of the pitch drift, and the drift is invisible in
    /// review because each file reads correctly by itself.
    ///
    /// Derived from TIER_ALLOWANCE via CreditAllowance rather than written out,
    /// so the number cannot fall out of step with what is actually granted.
    /// WHOLE SENTENCES, NOT A FRAGMENT INTERPOLATED INTO ONE. The first version
    /// of this returned just the claim and let each screen interpolate it. That
    /// satisfied benefits-parity and broke localisation: the interpolation
    /// minted new keys carrying %@ which the catalog did not have, so eleven
    /// locales would have fallen back to English — caught by localization-gate.
    /// It is also the wrong shape for translation regardless, because word order
    /// around an inserted phrase differs by language and the translator never
    /// sees the finished sentence.
    ///
    /// So the SENTENCES live here, one catalog key each, translated as units.
    /// THESE SENTENCES NO LONGER CARRY A NUMBER AT ALL (258).
    ///
    /// They used to end "…with 200 credits a month — 20 videos", which was two
    /// problems in one clause: a credit number on a user-facing surface, and a
    /// figure hard-written into a translated sentence, so changing the allowance
    /// meant re-translating the pitch in twelve languages. The capacity claim
    /// now lives in ONE place — `capacityLine`, fed by the server — and these
    /// say what the surface is actually about. A sentence with no number in it
    /// cannot go stale when the allowance moves.
    static func reeditSubtitle() -> String {
        String(localized: "Change a finished video without sending it again. Pro lets you do that, with unlimited chats.")
    }

    /// "Free is 1 video a month and no re-edits. Pro gives you 50." — both
    /// numbers from `videos_limit`, never written out (ruled 2026-09-23).
    ///
    /// NO RE-EDIT ON FREE is stated here because the cap encounter is where a
    /// free user is deciding, and re-edit is the thing they will reach for next.
    /// Falls back to a sentence with no number when the server has not sent the
    /// field, on the same rule as every other capacity claim.
    @MainActor
    static func freeVsProSubtitle() -> String {
        let usage = UsageService.shared
        guard let free = usage.videosLimitFree, let pro = usage.videosLimitPro else {
            return String(localized: "Free includes a video a month and no re-edits. Pro gives you more, and re-edits are free.")
        }
        return String(localized: "Free is \(free) videos a month and no re-edits. Pro gives you \(pro), and re-edits are free.")
    }

    static func exportGateSubtitle() -> String {
        String(localized: "Free lets you save only a few videos. Pro saves and shares every one.")
    }

    static func lapsedTrialSubtitle() -> String {
        String(localized: "Everything you made is still here. Go Pro to pick up where you left off.")
    }

    @MainActor
    static var paywallSubtitle: String {
        guard let pro = UsageService.shared.videosLimitPro else {
            return String(localized: "Go beyond the free plan — every feature unlocked.")
        }
        return String(localized: "\(pro) videos a month, and every feature unlocked.")
    }
    /// The SHORT form of the same promises, for a tier card roughly 165pt wide.
    ///
    /// WRITTEN HERE, which is the whole point. `core`'s phrasing is sized for a
    /// full-width row and wraps to three lines in a column that narrow, so the
    /// card needs shorter words — but a shorter phrasing invented inside the
    /// paywall view would be a second copy of the product's promises, which is
    /// exactly the drift benefits-parity-gate exists to stop. One file writes
    /// claims; this is that file, so both lengths live and change together.
    ///
    /// ONE UNIT ON THIS SURFACE. With the meter armed the card header states the
    /// allowance in CREDITS, so a "20 videos a month" row underneath would be
    /// the same quantity in a second currency and the reader would have to know
    /// the exchange rate (ten credits a video) to check the two lines agree. The
    /// balance strip counts credits and the meter spends credits; the card says
    /// credits too, and nothing on it converts. While the meter is dark there is
    /// no credit number, so capacity is stated as what is then true.
    @MainActor
    static func cardFeatures(videos: Int?) -> [String] {
        var out: [String] = []
        // The capacity row appears only when the server has said what it is.
        // This used to append a literal "20 videos a month" whenever the meter
        // was dark — which is every install today, and the figure is now 50, so
        // the one branch that always ran was the one that was wrong. Omitting
        // the row costs a line on a narrow card; printing a stale allowance is a
        // false promise about what money buys.
        if let v = videos, v > 0 {
            out.append(videosAMonth(v))
        }
        out += [
            String(localized: "Auto captions and cuts"),
            String(localized: "Re-edit any video"),
            String(localized: "10 uploads at once"),
            String(localized: "Unlimited AI chats"),
            String(localized: "Save and share"),
        ]
        return out
    }

    /// Max's card: TWO lines, and deliberately not a copy of Pro's list.
    ///
    /// Repeating Pro's six with identical ticks made the two cards read as the
    /// same product at two prices — the eye scans matching columns and the only
    /// difference it finds is the number at the bottom. Stating the relationship
    /// instead says more in less space and puts the actual difference, the
    /// multiple, into the sentence.
    ///
    /// The multiple is DERIVED and disappears with the meter: without credits
    /// there is nothing for Max to be a multiple OF, so the line degrades to the
    /// relationship alone rather than inventing a factor.
    @MainActor
    static func maxCardList(proVideos: Int?, maxVideos: Int?) -> [String] {
        // "EVERYTHING IN PRO" IS A POINTER, NOT A BENEFIT. It asks the reader to
        // go and look at the other tab, hold five lines in their head, and come
        // back — on the card that has to justify the higher price. It also left
        // Max with two bullets against Pro's five, which is the void that kept
        // being reported as a layout bug: the card was short because it said
        // almost nothing, and no amount of spacing fixes a card with nothing in
        // it.
        //
        // Max now NAMES what it includes. The lines are taken as a PREFIX of
        // Pro's own card features rather than retyped, so they cannot drift
        // from what Pro claims — the same discipline `top(_:)` uses, and the
        // reason a claim still exists in exactly one place.
        var out = Array(cardFeatures(videos: maxVideos).prefix(3))
        out.append(String(localized: "Early access to our newest features"))
        // The multiple is DERIVED, and it now derives from the VIDEO allowances
        // — which changes the number, not just the noun. Against credits Max was
        // 1000/200 = 5x; against videos it is 200/50 = 4x. Had this kept reading
        // the credit figures it would have gone on claiming 5x next to a card
        // stating 50 and 200, and the reader could do that division themselves.
        // Dropped entirely when either side is unknown, rather than invented.
        if let m = usageMultiple(proVideos: proVideos, maxVideos: maxVideos) {
            out.append(String(localized: "\(m)x the videos"))
        }
        return out
    }

    /// The usage multiple, DERIVED from the two allowances rather than typed, so
    /// repricing a tier cannot leave a stale multiple on screen. Nil while the
    /// meter is dark: with no credits there is no usage to be a multiple of.
    static func usageMultiple(proVideos: Int?, maxVideos: Int?) -> Int? {
        guard let p = proVideos, let m = maxVideos,
              p > 0, m > p else { return nil }
        let times = m / p
        return times >= 2 ? times : nil
    }

    /// "200 credits/month" under a tier name. Nil while the meter is dark —
    /// printing a credit number for a meter that is not running is a claim about
    /// something the user cannot yet spend.
    /// RETIRED AS A USER-FACING STRING (258). Credits are an internal accounting
    /// unit; the tier header states the allowance in videos like everything else.
    /// Kept as a nil-returning shim so the call sites that composed a header out
    /// of (creditsLine, videosLine) keep compiling while they collapse to one
    /// line — the gate below is what stops a credit number coming back.
    static func creditsLine(allowance: Int, creditsEnabled: Bool) -> String? { nil }

    /// The same allowance in videos, small, under the credits headline.
    ///
    /// CREDITS STAY THE HEADLINE — the bigger number carries the value — and
    /// this makes it evaluable, because "200 credits" alone is not a quantity
    /// anyone can price. Derived from `creditsPerVideo`, so changing either the
    /// allowance or the cost of a render moves this line with it; the two can
    /// never disagree the way a written-out "≈ 20 videos" eventually would.
    static func videosLine(allowance: Int, creditsEnabled: Bool) -> String? {
        guard creditsEnabled, allowance > 0 else { return nil }
        return String(localized: "≈ \(monthlyVideos(credits: allowance)) videos")
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
        // ONE SOURCE NOW: `videos_limit` on /api/usage. This used to try the
        // credits knob and then fall back to a StoreKit lookup across the
        // offering — two sources for one claim, and the StoreKit one returned
        // the largest allowance on sale rather than the caller's own. Nil falls
        // back to the unlimited wording rather than inventing a number.
        headlineVideoClaim(videos: UsageService.shared.videosLimitPro),
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
            case "podcast":     return String(localized: "Every episode into clips")
            case "talkinghead": return String(localized: "Every take into a finished cut")
            case "vlogs":       return String(localized: "Every vlog cut and captioned")
            case "promo":       return String(localized: "Every promo cut and captioned")
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
