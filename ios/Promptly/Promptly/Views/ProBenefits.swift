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
    static let core: [Benefit] = [
        Benefit(icon: "infinity",
                text: String(localized: "Unlimited videos, no daily cap")),
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

    /// The first `n` claims, for surfaces with less room. Never a hand-picked
    /// subset — see the note on `core`.
    static func top(_ n: Int) -> [Benefit] { Array(core.prefix(max(0, n))) }

    /// The same claim SET, with the first two lines rewritten in the user's own
    /// terms from Q1 (who the videos are for) and Q2 (what kind). A skipped
    /// question falls back to the generic claim it replaces, so the list is
    /// always the same length as `core`.
    ///
    /// Note it substitutes BY INDEX into `core` rather than rebuilding a list:
    /// that is what makes the tail impossible to drift.
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
    static func lines(audience: String? = nil, videoType: String? = nil) -> [String] {
        personalised(audience: audience, videoType: videoType).map(\.text)
    }
}
