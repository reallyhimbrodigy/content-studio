import Foundation

/// The personalised lead line for the reveal and paywall headlines.
///
/// DELIBERATELY NOT IN ProBenefits. It lived there for one commit and
/// benefits-parity-gate rejected it, correctly: ProBenefits is the single
/// source for PRO BENEFIT CLAIMS, and "vlogs" is not a claim — it is a noun
/// describing what the user makes. Putting it there made the gate see the Q2
/// option label in VideoTypeQuestionView as a forked benefit, which is exactly
/// the collision the gate exists to detect. The gate was right and the fix is
/// separation, not a rename that would have quieted it while leaving a content
/// noun sitting in the claims file.
enum PaywallPersonalization {

    /// Sits ABOVE the discount headline and never replaces it.
    ///
    /// The discount headline is a money claim — computed per territory, floored,
    /// and guarded by the banned-percentage gate. Weaving a user-derived noun
    /// into it would put arbitrary text inside the one sentence that must say
    /// exactly what the store says. So personalisation is strictly additive.
    ///
    /// Returns nil when the questions were skipped, which is MOST users: Q2's
    /// measured skip rate is 59%, and Q1's is not yet knowable. A generic
    /// substitute ("For your videos") would be worse than nothing — it reads as
    /// personalisation that FAILED, a stronger negative signal than none at all.
    /// Nil means the line is simply not drawn.
    ///
    /// One %@ carrying an already-localised noun, so the placeholder gate sees a
    /// single argument and translators can move it where their grammar needs it.
    static func lead(audience: String?, videoType: String?) -> String? {
        // Q2 first — what someone MAKES is more specific than who it is for,
        // and specificity is the entire value of the line.
        if let noun = contentNoun(videoType: videoType) {
            return String(localized: "For your \(noun)")
        }
        if let who = audienceNoun(audience) {
            return String(localized: "For \(who)")
        }
        return nil
    }

    /// Q2 → a plural noun phrase. Goes through the compound-key parser: Q2 keys
    /// are compound ("podcast:fast"), and switching on the raw key silently
    /// falls through to nil — the defect compound-key-gate exists to catch.
    private static func contentNoun(videoType: String?) -> String? {
        guard let t = OnboardingQuestion.contentTypeV2(videoType) else { return nil }
        switch t {
        case "podcast":     return String(localized: "podcast clips")
        case "talkinghead": return String(localized: "talking-head videos")
        case "vlogs":       return String(localized: "vlogs")
        case "promo":       return String(localized: "promos")
        default:            return nil
        }
    }

    /// Q1 → who it is for. Only answers that name a real audience; "just trying
    /// it out" and "other" return nil rather than being bent into a phrase that
    /// would read as a guess about someone who declined to say.
    private static func audienceNoun(_ audience: String?) -> String? {
        switch audience {
        case "clients":        return String(localized: "client work")
        case "small_business": return String(localized: "your business")
        case "employer":       return String(localized: "your team")
        default:               return nil
        }
    }
}
