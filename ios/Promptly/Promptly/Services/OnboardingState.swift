import Foundation
import SwiftUI

/// State core for the 1.2.0 wall onboarding (signup → social proof → trial
/// wall). Owns:
///   - the EXPOSURE decision (the one knob): `/api/health.wall_enforcement`,
///     fetched pre-auth (no token needed). 'on' → wall onboarding; anything
///     else (or fetch failure) → today's legacy flow, byte-for-byte. The same
///     knob drives the server gates — flip once, both halves move together.
///   - flow position, so a killed app resumes where it left off.
///
/// The opening hook clip and the quiz were removed (Zac, 2026-07-21) — the hook
/// returns in a later build with a good clip; the quiz is gone entirely, so
/// there is no personalized "building your studio" reveal anymore.
///
/// Every step change emits `onboarding_step` through the dual-sink wrapper, so
/// drop-off is measurable per step from day one.
@MainActor
final class OnboardingState: ObservableObject {
    static let shared = OnboardingState()

    // ── Exposure (the knob) ──────────────────────────────────────────────────
    /// nil = not yet fetched (show launch); false = legacy flow; true = wall
    /// onboarding. Defaults FALSE on any failure — the app must never brick
    /// because a config fetch failed (the wall stays a server-enforced fact).
    @Published private(set) var wallOnboardingEnabled: Bool? = nil

    /// Conversion workstream item 1: the FIRST-LAUNCH dismissible paywall.
    /// Separate knob from wall_enforcement (that one is shared with the server
    /// gates and cannot be overloaded for a UI-only wall). Same lifecycle:
    /// nil = not fetched, default false on failure, last-known cached.
    @Published private(set) var firstLaunchPaywallEnabled: Bool? = nil

    /// Conversion-experiment knobs (one per experiment; default off, cached).
    @Published private(set) var postrenderReferralEnabled = false
    @Published private(set) var abandonReferralEnabled = false
    @Published private(set) var ambientWallReferralEnabled = false
    /// The referral row on the SECOND paywall. Added 2026-08-29 because it was
    /// the only referral surface with NO flag at all — it shipped live to every
    /// wall-onboarding user while its three siblings sat dark, and it is the
    /// one that showed a progress promise ("0 of 3 friends have made a video")
    /// against attribution that has been 0% all-time. A promise the pipeline
    /// cannot keep is worse than no surface.
    @Published private(set) var secondPaywallReferralEnabled = false
    // ── 2026-08-31 build: six independent experiments ────────────────────────
    // Each on its OWN flag so their effects are separable. The reverse trial in
    // particular is split from its expiry surface: the grant is a non-event and
    // the expiry is where conversion happens, so blending them into one flag
    // would make the thing that matters unreadable.
    /// Credits meter — read/display half only (the client cannot debit;
    /// RevenueCat Virtual Currencies is read-only on device, SDK 5.75.0).
    @Published private(set) var creditsEnabled = false
    /// Monthly credit allowance for the CURRENT tier, served alongside the
    /// credits flag. nil while the meter is dark or the server has not said —
    /// and nil is what keeps the paywall honest: `headlineVideoClaim` falls back
    /// to the unlimited wording rather than inventing a number, so a missing
    /// value can never become a false claim about what money buys.
    @Published private(set) var creditsMonthlyAllowance: Int? = nil

    #if DEBUG
    /// Harness only: pose the server's `credits_monthly` so a capture can show
    /// the ARMED claim ("20 videos a month") rather than the unlimited
    /// fallback. Without this the allowance is nil in a simulator — no server
    /// field, and `storeKitAllowance()` needs both a Pro entitlement and live
    /// offerings — so a credits-armed capture silently shows the credits-dark
    /// copy, which is the most misleading possible screenshot to review.
    func debugSetCreditsAllowance(_ v: Int?) { if creditsMonthlyAllowance != v { creditsMonthlyAllowance = v } }
    #endif
    /// The render-progress rebuild: framed source + ring, no bullet list.
    @Published private(set) var progressRingEnabled = false
    /// Before/after compare in the delivered-video bubble.
    @Published private(set) var beforeAfterEnabled = false
    /// One or two conversational questions rendered on the send run loop.
    @Published private(set) var instantQuestionsEnabled = false
    /// 72h Pro on offer-reveal decline, via pro_until + the existing ledger.
    @Published private(set) var reverseTrialEnabled = false
    /// The expiry moment — deliberately separate from the grant.
    @Published private(set) var reverseTrialExpiryEnabled = false
    /// Q1 audience + Q2 content type into reveal and paywall headlines.
    @Published private(set) var paywallPersonalizationEnabled = false
    /// Referral progress + one-tap share on every share surface. Dark by
    /// default like every other experiment.
    @Published private(set) var referralProgressEnabled = false

    /// Free text from Q2's "Something else". Persisted so personalisation can
    /// use a real answer instead of the `other` bucket, which returns nil
    /// everywhere and therefore personalises nothing.
    @Published var v2VideoTypeOther: String? = UserDefaults.standard.string(forKey: "v2_video_type_other") {
        didSet { UserDefaults.standard.set(v2VideoTypeOther, forKey: "v2_video_type_other") }
    }

    @Published private(set) var postrenderSaveCtaEnabled = false
    @Published private(set) var chatMediaEnabled = false
    @Published private(set) var firstSessionAutopickerEnabled = false
    @Published private(set) var yearlyFrameFixEnabled = false
    @Published private(set) var uploadFailNotifyEnabled = false

    /// Conversion build 2026-08-27 (post-235): seven surfaces around the
    /// moment of desire, EACH behind its own server flag, default off —
    /// arming order stays a ruling after 235's read.
    @Published private(set) var attributionGateEnabled = false
    @Published private(set) var onboardingV2Enabled = false
    @Published private(set) var renderTransparencyEnabled = false
    @Published private(set) var exportGatePersonalizationEnabled = false
    @Published private(set) var badRenderSuppressorEnabled = false
    @Published private(set) var annualDollarLineEnabled = false
    @Published private(set) var offerSurfacingEnabled = false
    /// The paywall as two decisions (tier, then duration) instead of one
    /// four-product list. Dark until flipped; off = today's PaywallView,
    /// byte-identical.
    /// ARMED (2026-09-02). Every upgrade entry point — the pill, the usage
    /// meter, re-edit, the export gate, daily renders, daily chats, concurrency,
    /// Account — routes through `UpgradePaywall`, which reads this. On means all
    /// of them show the two-step paywall.
    ///
    /// Defaulting true is the arming mechanism because THE SERVER DOES NOT EMIT
    /// THIS KEY. `/api/health` has no `two_step_paywall`, so the parse below
    /// leaves it alone and the default stands. Turning it back OFF therefore
    /// needs the server to start emitting `two_step_paywall: "off"` — a backend
    /// change, not a client one. That is the honest cost of arming this way and
    /// it should be known before it is needed, not discovered during a rollback.
    @Published private(set) var twoStepPaywallEnabled = true
    /// Deferred auth: the funnel runs BEFORE sign-in (paywall, questions,
    /// reveal, chat), and an account is asked for at the first action that needs
    /// one. Dark until flipped; off = today's auth-first order, unchanged.
    ///
    /// The purchase guard is NOT gated on this flag — no purchase may complete
    /// without an account whether this is on or off.
    /// ARMED (2026-09-02), on the same terms as two_step_paywall and with the
    /// same rollback cost: the server does not emit this key, so turning it OFF
    /// needs the server to start emitting `deferred_auth: "off"` — a backend
    /// change, not a client one.
    @Published private(set) var deferredAuthEnabled = true

    /// Whether the Max tier may be OFFERED.
    ///
    /// OFF until Max is approved. As of 2026-09-02 both Max products read
    /// MISSING_METADATA in App Store Connect — neither approved nor submitted —
    /// so a paywall showing them is selling something nobody can buy.
    ///
    /// A FLAG RATHER THAN AN AVAILABILITY TEST, deliberately, because StoreKit
    /// exposes no approval state to the client. The reason Max renders with
    /// prices in a simulator is that the sandbox returns unapproved products;
    /// "filter on what the store returned" therefore cannot tell an approved
    /// product from an unapproved one. This flag can be armed the moment Max
    /// clears review, and nothing else has to change.
    @Published private(set) var maxTierEnabled = false
    @Published private(set) var pushPrimerEnabled = false
    /// Amendment 2026-08-27: the export gate as TWO pages (benefits written
    /// against the stated content type, then plans + price). Its own flag so
    /// its contribution is readable separately from the personalization.
    @Published private(set) var exportGateTwoPageEnabled = false

    /// Show-once: set when the first-launch wall is dismissed or purchased
    /// through. @Published so the root ZStack re-branches the moment it flips.
    @Published var hasSeenFirstLaunchPaywall: Bool =
        UserDefaults.standard.bool(forKey: "first_launch_paywall_seen") {
        didSet {
            UserDefaults.standard.set(hasSeenFirstLaunchPaywall,
                                      forKey: "first_launch_paywall_seen")
        }
    }

    /// Show-once guard for the ATTRIBUTION ASK (attribution resurrection).
    /// ANY disposition — answer or skip, from the standalone gate OR
    /// onboarding v2's shared beat — sets it, so no flag combination can ever
    /// re-nag the question. @Published so the root ZStack re-branches the
    /// moment it flips (same contract as hasSeenFirstLaunchPaywall above).
    @Published var hasSeenAttributionGate: Bool =
        UserDefaults.standard.bool(forKey: "attribution_gate_seen") {
        didSet {
            UserDefaults.standard.set(hasSeenAttributionGate,
                                      forKey: "attribution_gate_seen")
        }
    }

    /// One fetch per launch, ~instant (same host as every other call). Cached
    /// result also persisted so a cold offline launch uses the last-known knob.
    func resolveExposure() async {
        let cacheKey = "wall_onboarding_enabled"
        let flpCacheKey = "first_launch_paywall_enabled"
        do {
            var req = URLRequest(url: URL(string: "https://usepromptly.app/api/health")!)
            req.timeoutInterval = 5
            let (data, _) = try await URLSession.shared.data(for: req)
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let on = (obj?["wall_enforcement"] as? String) == "on"
            wallOnboardingEnabled = on
            UserDefaults.standard.set(on, forKey: cacheKey)
            // Second knob rides the same fetch. Field absent (server not yet
            // deployed) → false → the wall stays dark. Never brick on config.
            let flp = (obj?["first_launch_paywall"] as? String) == "on"
            firstLaunchPaywallEnabled = flp
            UserDefaults.standard.set(flp, forKey: flpCacheKey)
            // Version awareness rides the same fetch (latest/min-supported/
            // force flag/notes — all server-driven).
            VersionAwareness.shared.ingest(obj)
            // Referral-surfacing experiment knobs (P2/P1/ambient-wall).
            postrenderReferralEnabled = (obj?["postrender_referral"] as? String) == "on"
            abandonReferralEnabled = (obj?["abandon_referral"] as? String) == "on"
            ambientWallReferralEnabled = (obj?["ambient_wall_referral"] as? String) == "on"
            secondPaywallReferralEnabled = (obj?["second_paywall_referral"] as? String) == "on"
            postrenderSaveCtaEnabled = (obj?["postrender_save_cta"] as? String) == "on"
            chatMediaEnabled = (obj?["chat_media"] as? String) == "on"
            firstSessionAutopickerEnabled = (obj?["first_session_autopicker"] as? String) == "on"
            yearlyFrameFixEnabled = (obj?["yearly_frame_fix"] as? String) == "on"
            uploadFailNotifyEnabled = (obj?["upload_fail_notify"] as? String) == "on"
            UserDefaults.standard.set(postrenderReferralEnabled, forKey: "postrender_referral_enabled")
            UserDefaults.standard.set(abandonReferralEnabled, forKey: "abandon_referral_enabled")
            UserDefaults.standard.set(ambientWallReferralEnabled, forKey: "ambient_wall_referral_enabled")
            UserDefaults.standard.set(secondPaywallReferralEnabled, forKey: "second_paywall_referral_enabled")
            UserDefaults.standard.set(postrenderSaveCtaEnabled, forKey: "postrender_save_cta_enabled")
            UserDefaults.standard.set(chatMediaEnabled, forKey: "chat_media_enabled")
            UserDefaults.standard.set(firstSessionAutopickerEnabled, forKey: "first_session_autopicker_enabled")
            UserDefaults.standard.set(yearlyFrameFixEnabled, forKey: "yearly_frame_fix_enabled")
            UserDefaults.standard.set(uploadFailNotifyEnabled, forKey: "upload_fail_notify_enabled")
            attributionGateEnabled = (obj?["attribution_gate"] as? String) == "on"
            onboardingV2Enabled = (obj?["onboarding_v2"] as? String) == "on"
            renderTransparencyEnabled = (obj?["render_transparency"] as? String) == "on"
            exportGatePersonalizationEnabled = (obj?["exportgate_personalization"] as? String) == "on"
            badRenderSuppressorEnabled = (obj?["bad_render_suppressor"] as? String) == "on"
            annualDollarLineEnabled = (obj?["annual_dollar_line"] as? String) == "on"
            offerSurfacingEnabled = (obj?["offer_surfacing"] as? String) == "on"
            // ONLY WHEN THE SERVER ACTUALLY SAYS SOMETHING. `== "on"` on an
            // absent key is false, so the old line turned this OFF on the first
            // refresh — a client default could never have survived. Every other
            // flag here is server-emitted, so none of them hit this; this is the
            // first one armed from the client.
            if let v = obj?["two_step_paywall"] as? String {
                twoStepPaywallEnabled = v == "on"
            }
            // Same absent-key trap as two_step_paywall: `== "on"` on a key the
            // server never sends is false, so this used to turn itself off on
            // the first refresh and no client default could survive.
            if let v = obj?["deferred_auth"] as? String {
                deferredAuthEnabled = v == "on"
            }
            if let v = obj?["max_tier"] as? String {
                maxTierEnabled = v == "on"
            }
            pushPrimerEnabled = (obj?["push_primer"] as? String) == "on"
            exportGateTwoPageEnabled = (obj?["exportgate_two_page"] as? String) == "on"
            creditsEnabled = (obj?["credits"] as? String) == "on"
            creditsMonthlyAllowance = obj?["credits_monthly"] as? Int
            #if DEBUG
            debugReapplyForcedFlags()   // the refresh must not undo a forced flag
            #endif
            progressRingEnabled = (obj?["progress_ring"] as? String) == "on"
            beforeAfterEnabled = (obj?["before_after"] as? String) == "on"
            instantQuestionsEnabled = (obj?["instant_questions"] as? String) == "on"
            reverseTrialEnabled = (obj?["reverse_trial"] as? String) == "on"
            reverseTrialExpiryEnabled = (obj?["reverse_trial_expiry"] as? String) == "on"
            paywallPersonalizationEnabled = (obj?["paywall_personalization"] as? String) == "on"
            referralProgressEnabled = (obj?["referral_progress"] as? String) == "on"
            UserDefaults.standard.set(attributionGateEnabled, forKey: "attribution_gate_enabled")
            UserDefaults.standard.set(onboardingV2Enabled, forKey: "onboarding_v2_enabled")
            UserDefaults.standard.set(renderTransparencyEnabled, forKey: "render_transparency_enabled")
            UserDefaults.standard.set(exportGatePersonalizationEnabled, forKey: "exportgate_personalization_enabled")
            UserDefaults.standard.set(badRenderSuppressorEnabled, forKey: "bad_render_suppressor_enabled")
            UserDefaults.standard.set(annualDollarLineEnabled, forKey: "annual_dollar_line_enabled")
            UserDefaults.standard.set(offerSurfacingEnabled, forKey: "offer_surfacing_enabled")
            UserDefaults.standard.set(twoStepPaywallEnabled, forKey: "two_step_paywall_enabled")
            UserDefaults.standard.set(deferredAuthEnabled, forKey: "deferred_auth_enabled")
            UserDefaults.standard.set(maxTierEnabled, forKey: "max_tier_enabled")
            UserDefaults.standard.set(pushPrimerEnabled, forKey: "push_primer_enabled")
            UserDefaults.standard.set(exportGateTwoPageEnabled, forKey: "exportgate_two_page_enabled")
            // The seven experiment flags persist too. They were added without a
            // cached copy, which is not a cosmetic gap: every flag above is
            // restored on a failed read, so a /api/health hiccup left THESE
            // seven — and only these seven — snapping to false mid-session while
            // their neighbours held. A surface that vanishes on a network blip
            // reads as a bug to the user and as a flapping denominator to us.
            UserDefaults.standard.set(creditsEnabled, forKey: "credits_enabled")
            UserDefaults.standard.set(progressRingEnabled, forKey: "progress_ring_enabled")
            UserDefaults.standard.set(beforeAfterEnabled, forKey: "before_after_enabled")
            UserDefaults.standard.set(instantQuestionsEnabled, forKey: "instant_questions_enabled")
            UserDefaults.standard.set(reverseTrialEnabled, forKey: "reverse_trial_enabled")
            UserDefaults.standard.set(reverseTrialExpiryEnabled, forKey: "reverse_trial_expiry_enabled")
            UserDefaults.standard.set(paywallPersonalizationEnabled, forKey: "paywall_personalization_enabled")
            UserDefaults.standard.set(referralProgressEnabled, forKey: "referral_progress_enabled")
        } catch {
            // Offline / server hiccup: last-known knobs, default off.
            wallOnboardingEnabled = UserDefaults.standard.bool(forKey: cacheKey)
            firstLaunchPaywallEnabled = UserDefaults.standard.bool(forKey: flpCacheKey)
            postrenderReferralEnabled = UserDefaults.standard.bool(forKey: "postrender_referral_enabled")
            abandonReferralEnabled = UserDefaults.standard.bool(forKey: "abandon_referral_enabled")
            ambientWallReferralEnabled = UserDefaults.standard.bool(forKey: "ambient_wall_referral_enabled")
            postrenderSaveCtaEnabled = UserDefaults.standard.bool(forKey: "postrender_save_cta_enabled")
            chatMediaEnabled = UserDefaults.standard.bool(forKey: "chat_media_enabled")
            firstSessionAutopickerEnabled = UserDefaults.standard.bool(forKey: "first_session_autopicker_enabled")
            yearlyFrameFixEnabled = UserDefaults.standard.bool(forKey: "yearly_frame_fix_enabled")
            uploadFailNotifyEnabled = UserDefaults.standard.bool(forKey: "upload_fail_notify_enabled")
            attributionGateEnabled = UserDefaults.standard.bool(forKey: "attribution_gate_enabled")
            onboardingV2Enabled = UserDefaults.standard.bool(forKey: "onboarding_v2_enabled")
            renderTransparencyEnabled = UserDefaults.standard.bool(forKey: "render_transparency_enabled")
            exportGatePersonalizationEnabled = UserDefaults.standard.bool(forKey: "exportgate_personalization_enabled")
            badRenderSuppressorEnabled = UserDefaults.standard.bool(forKey: "bad_render_suppressor_enabled")
            annualDollarLineEnabled = UserDefaults.standard.bool(forKey: "annual_dollar_line_enabled")
            offerSurfacingEnabled = UserDefaults.standard.bool(forKey: "offer_surfacing_enabled")
            if UserDefaults.standard.object(forKey: "two_step_paywall_enabled") != nil {
                twoStepPaywallEnabled = UserDefaults.standard.bool(forKey: "two_step_paywall_enabled")
            }
            if UserDefaults.standard.object(forKey: "deferred_auth_enabled") != nil {
                deferredAuthEnabled = UserDefaults.standard.bool(forKey: "deferred_auth_enabled")
            }
            maxTierEnabled = UserDefaults.standard.bool(forKey: "max_tier_enabled")
            pushPrimerEnabled = UserDefaults.standard.bool(forKey: "push_primer_enabled")
            exportGateTwoPageEnabled = UserDefaults.standard.bool(forKey: "exportgate_two_page_enabled")
            creditsEnabled = UserDefaults.standard.bool(forKey: "credits_enabled")
            progressRingEnabled = UserDefaults.standard.bool(forKey: "progress_ring_enabled")
            beforeAfterEnabled = UserDefaults.standard.bool(forKey: "before_after_enabled")
            instantQuestionsEnabled = UserDefaults.standard.bool(forKey: "instant_questions_enabled")
            reverseTrialEnabled = UserDefaults.standard.bool(forKey: "reverse_trial_enabled")
            reverseTrialExpiryEnabled = UserDefaults.standard.bool(forKey: "reverse_trial_expiry_enabled")
            paywallPersonalizationEnabled = UserDefaults.standard.bool(forKey: "paywall_personalization_enabled")
            referralProgressEnabled = UserDefaults.standard.bool(forKey: "referral_progress_enabled")
        }
    }

    #if DEBUG
    /// Sim-proof harness: force a conversion-build flag on locally
    /// (screenshots of dark surfaces without a server flip). DEBUG only.
    /// Forced flags are STICKY.
    ///
    /// A one-shot force is clobbered by the very next server refresh, which
    /// writes every flag from the payload — so the app reverts a second after
    /// launch and the surface under test never appears. Cost a full
    /// build-install-run cycle proving deferred auth "did not work" when the
    /// flag had simply been overwritten. Remembering what was forced and
    /// re-applying it after each refresh is the only version that holds.
    private static var forcedKeys: Set<String> = []

    func debugReapplyForcedFlags() {
        for k in Self.forcedKeys { debugForceFlag(k) }
    }

    func debugForceFlag(_ key: String) {
        Self.forcedKeys.insert(key)
        switch key {
        case "first_launch_paywall": if firstLaunchPaywallEnabled != true { firstLaunchPaywallEnabled = true }
        case "attribution_gate": if !attributionGateEnabled { attributionGateEnabled = true }
        case "onboarding_v2": onboardingV2Enabled = true
        case "render_transparency": if !renderTransparencyEnabled { renderTransparencyEnabled = true }
        case "exportgate_personalization": if !exportGatePersonalizationEnabled { exportGatePersonalizationEnabled = true }
        case "bad_render_suppressor": if !badRenderSuppressorEnabled { badRenderSuppressorEnabled = true }
        case "annual_dollar_line": if !annualDollarLineEnabled { annualDollarLineEnabled = true }
        case "offer_surfacing": if !offerSurfacingEnabled { offerSurfacingEnabled = true }
        case "two_step_paywall": if !twoStepPaywallEnabled { twoStepPaywallEnabled = true }
        case "deferred_auth": if !deferredAuthEnabled { deferredAuthEnabled = true }
        case "max_tier": if !maxTierEnabled { maxTierEnabled = true }
        // A flag with no case here cannot be turned on anywhere but a live
        // server flip, so it cannot be screenshotted or reviewed before it
        // ships — the gap this switch's own comment describes.
        case "first_session_autopicker": if !firstSessionAutopickerEnabled { firstSessionAutopickerEnabled = true }
        case "push_primer": if !pushPrimerEnabled { pushPrimerEnabled = true }
        case "exportgate_two_page": if !exportGateTwoPageEnabled { exportGateTwoPageEnabled = true }
        // The seven experiment flags. Their absence here was not a small gap —
        // it meant NONE of them could be turned on anywhere but a live server
        // flip, so none could be recorded, screenshotted, or reviewed before
        // shipping. A surface that cannot be seen before it ships is reviewed
        // by its users.
        case "credits": if !creditsEnabled { creditsEnabled = true }
        case "progress_ring": if !progressRingEnabled { progressRingEnabled = true }
        case "before_after": if !beforeAfterEnabled { beforeAfterEnabled = true }
        case "instant_questions": if !instantQuestionsEnabled { instantQuestionsEnabled = true }
        case "reverse_trial": if !reverseTrialEnabled { reverseTrialEnabled = true }
        case "reverse_trial_expiry": if !reverseTrialExpiryEnabled { reverseTrialExpiryEnabled = true }
        case "paywall_personalization": if !paywallPersonalizationEnabled { paywallPersonalizationEnabled = true }
        case "referral_progress": if !referralProgressEnabled { referralProgressEnabled = true }
        // LOUD, not silent. `default: break` meant a mistyped key produced a
        // run that looked forced and wasn't — the harness would record the dark
        // state and it would be filed as "the surface doesn't work". A proof
        // tool that fails quietly is worse than no proof tool.
        default:
            assertionFailure("debugForceFlag: unknown flag '\(key)' — nothing was forced.")
        }
    }
    #endif

    // ── Language (KEPT from the removed quiz — it is the only quiz step Zac
    // preserved). Sets the APP UI language via the String Catalog: persisted to
    // AppleLanguages (full effect next launch) and surfaced as `locale` for an
    // immediate SwiftUI override at the app root. Also becomes the PostHog
    // preferred_language person property. NOTE: this controls the app UI
    // language, NOT the video/caption output language (captions follow the
    // spoken audio) — see the report.
    @Published var preferredLanguage: String? {
        didSet {
            guard let code = preferredLanguage else { return }
            UserDefaults.standard.set(code, forKey: "preferred_language")
            // Standard iOS in-app language override — the whole app (incl. UIKit
            // + String(localized:)) renders in this language from the next launch.
            UserDefaults.standard.set([code], forKey: "AppleLanguages")
        }
    }
    /// The locale to apply at the app root for immediate effect this session.
    var locale: Locale? { preferredLanguage.map { Locale(identifier: $0) } }

    // ── Flow position ────────────────────────────────────────────────────────
    // Rebuilt 2026-08-03 (Zac): the paywall + social-proof beats are GONE. The
    // funnel proved day-1 is everything and onboarding must END AT THE PICKER —
    // so onboarding is now three skippable questions that segment the user and
    // preselect a vibe, then drop them straight on the importer. The paywall
    // moved out entirely; the referral (post-first-video) replaces the trial.
    enum Step: String, Codable {
        case language       // pick the app language (kept from the quiz)
        case signup         // Sign in with Apple
        case audience       // Q1: who are you making videos for? (required, Skip)
        case intent         // Q2: what do you want to make? (required, MULTI-select, Skip)
        case attribution    // Q3: how did you hear about us? (OPTIONAL, last)
        case results        // the results wall — real renders, right before the ask
        case paywall2       // the second, personalised paywall (referral = 3rd option)
        case done           // → straight to the video picker
    }

    @Published var step: Step = .language {
        didSet {
            UserDefaults.standard.set(step.rawValue, forKey: "onboarding_step")
            Analytics.track("onboarding_step", props: ["step": step.rawValue])
        }
    }

    // ── Onboarding v2 flow position (the `onboarding_v2` knob) ──────────────
    // OnboardingV2Flow's beats — its OWN enum + persistence key so it can
    // never collide with the wall flow's `step` above. MAX FOUR beats, ends
    // at the picker, NO paywall anywhere in the flow (that placement was
    // removed for cause).
    /// Restructured 2026-08-27 to the verified Captions sequence. Screen one
    /// (the full-price paywall) is NOT a step here — it is the existing
    /// FirstLaunchPaywallView branch above this flow in PromptlyApp.
    enum V2Step: String, Codable {
        case audience     // Q1: who are you making videos for?
        case videoType    // Q2: what kind of videos? (the one that feeds vibe)
        case attribution  // Q3: how did you hear about us? (gate merged in)
        /// The full-price paywall, MOVED HERE 2026-09-02 (was a root branch
        /// ABOVE this flow, so it ran before any question was answered).
        ///
        /// It reads Q1 and Q2 for its personalised lead — `ProBenefits
        /// .personalised(audience:videoType:)` substitutes slots 0 and 1 from
        /// those two answers. Shown first, both were nil, so every new user got
        /// the generic list and the personalisation could not fire by
        /// construction. Ordering it after the questions is what turns that
        /// already-built copy on.
        case paywall
        case reveal       // the offer reveal (skipped when no real offer)
        /// THE LAST RUNG (2026-09-02). "Decline offer" used to be a dead end —
        /// the user said no to the discount and the flow simply ended, with the
        /// referral reduced to one line ON the reveal that a declining user has
        /// already decided to ignore. A user who has just refused to pay is the
        /// one person for whom "not ready to pay?" is the right question, so it
        /// gets its own rung instead of a line on the rung above.
        case referralCatch
        case done         // → the picker (PromptlyApp re-branches)

        /// One name per beat, shared by the arrive and answer emitters. The
        /// rawValue stays `videoType` because it is persisted in UserDefaults
        /// and renaming it would strand every mid-flow resume on upgrade.
        var analyticsName: String {
            self == .videoType ? "video_type" : rawValue
        }
    }

    /// V2 survey answers (amendment 2026-08-27). Kept separate from the wall
    /// flow's audience/intent so neither flow can clobber the other. All three
    /// feed the composer prefill; `platform` and `making` also personalise the
    /// render-wait copy and the export gate's benefit page.
    @Published var v2Audience: String?
    @Published var v2VideoType: String?

    /// The plan the user actually PRE-SELECTED on the first-launch paywall.
    ///
    /// Added 2026-08-28. The paywall held its selection in local `@State`, so
    /// the moment that screen went away the choice was gone, and the offer
    /// reveal fell back to `PlanSavings.defaultSelection` — the DEFAULT, not the
    /// user's pick. A user who deliberately tapped Monthly and dismissed was
    /// then shown an annual offer. It looked correct in testing only because
    /// the default happens to be annual, so the two agreed by coincidence on
    /// the one path anyone exercised.
    ///
    /// Stored as the RevenueCat package identifier, and resolved back to a live
    /// `Package` at read time — never persist a price or a plan name, both of
    /// which change per storefront and per offering revision.
    @Published var preselectedPlanID: String? {
        didSet { UserDefaults.standard.set(preselectedPlanID, forKey: Self.preselectedPlanKey) }
    }
    static let preselectedPlanKey = "preselected_plan_id"
    /// Back-compat alias: the render-wait header and export gate read the
    /// content-type answer under its old name.
    var v2Making: String? { v2VideoType }

    @Published var v2Step: V2Step = .audience {
        didSet {
            UserDefaults.standard.set(v2Step.rawValue, forKey: "onboarding_v2_step")
            // `phase` separates ARRIVING at a beat from ANSWERING it. Without it
            // the two were indistinguishable: this didSet emitted the enum's
            // rawValue ("audience") and the answer seam emitted the same literal
            // ("audience"), so Q1's arrival and its answer collided on one
            // string and no funnel could tell entered-the-question from
            // answered-it. Q2 only LOOKED different because the enum spells it
            // `videoType` while the answer spells it `video_type` — an accident
            // of naming that read as two steps and hid the same collision.
            //
            // `step` is also normalised to snake_case here so one beat has ONE
            // name across both emitters.
            Analytics.track("onboarding_v2_step",
                            props: ["step": v2Step.analyticsName,
                                    "phase": "arrive",
                                    "context": "onboarding_v2"])
        }
    }

    /// Seed the last-known v2 beat (kill-resume) — same contract as
    /// `restore()` below; OnboardingV2Flow re-derives the right entry from
    /// auth + completion in its onAppear.
    func restoreV2() {
        if let raw = UserDefaults.standard.string(forKey: "onboarding_v2_step"),
           let s = V2Step(rawValue: raw) {
            v2Step = s
        }
        // The paywall and the reveal are separate screens in separate launches'
        // worth of state; without this the user's plan choice does not survive
        // the trip between them.
        if preselectedPlanID == nil {
            preselectedPlanID = UserDefaults.standard.string(forKey: Self.preselectedPlanKey)
        }
    }

    // ── Onboarding answers ───────────────────────────────────────────────────
    // Persisted to profile_settings (POST /api/profile/settings) + surfaced as
    // PostHog person properties. Every future funnel cut can finally segment by
    // audience/intent, and we get channel attribution for the first time.
    @Published var audience: String?
    /// Q2 is MULTI-SELECT (ruled 2026-08-21). All picks, in tap order.
    @Published var intents: [String] = []
    /// Back-compat single intent = the first pick (feeds the vibe bridge and
    /// the profile_settings key existing consumers read).
    var intent: String? { intents.first }
    @Published var attribution: String?
    /// Q2 maps the chosen intent to a starting vibe so the editor opens ON A
    /// STYLE, not a blank text field (nil = "not sure" → default composer).
    @Published var preselectedVibe: String?

    /// Completed = the user has passed the wall (trial/Pro) at least once.
    /// A lapsed subscriber does NOT redo onboarding — they get the lapsed wall.
    var hasCompletedOnboarding: Bool {
        get { UserDefaults.standard.bool(forKey: "onboarding_completed") }
        set { UserDefaults.standard.set(newValue, forKey: "onboarding_completed") }
    }

    /// True once the wall onboarding has ever been shown on this install.
    /// The GRANDFATHER rule hangs on this: an already-authenticated user who
    /// never entered the flow (existing account when the knob flips) is marked
    /// completed rather than forced through a signup flow they've already done
    /// — the server's rollout policy walls them only per its own rules.
    var startedFlow: Bool {
        get { UserDefaults.standard.bool(forKey: "onboarding_started") }
    }
    func markFlowStarted() {
        UserDefaults.standard.set(true, forKey: "onboarding_started")
    }

    func restore() {
        if let raw = UserDefaults.standard.string(forKey: "onboarding_step"),
           let s = Step(rawValue: raw) {
            // The flow container re-derives the right entry from auth +
            // completion in onAppear; this just seeds the last-known beat.
            step = s
        }
    }

    /// Persist the three answers into `profile_settings` (POST
    /// /api/profile/settings) so every future funnel can segment by
    /// audience/intent and we finally have channel attribution. Best-effort and
    /// fire-and-forget: onboarding must never block on a network write. The
    /// server merges these keys into profile_settings (additive).
    func persistAnswersToProfile() {
        var settings: [String: Any] = [:]
        if let audience { settings["audience"] = audience }
        if let intent { settings["intent"] = intent }
        if !intents.isEmpty { settings["intents"] = intents }
        if let attribution { settings["attribution"] = attribution }
        // V2 survey (amendment 2026-08-27) — segmentable alongside the wall
        // flow's keys; the server merges additively.
        if let v2Audience { settings["v2_audience"] = v2Audience }
        if let v2VideoType { settings["v2_video_type"] = v2VideoType }
        guard !settings.isEmpty,
              let token = AuthService.shared.accessToken,
              let url = URL(string: "https://usepromptly.app/api/profile/settings"),
              let body = try? JSONSerialization.data(withJSONObject: ["profile_settings": settings]) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = body
        req.timeoutInterval = 8
        Task.detached { _ = try? await URLSession.shared.data(for: req) }
    }

    private init() {
        preferredLanguage = UserDefaults.standard.string(forKey: "preferred_language")
    }

    #if DEBUG
    /// Force the wall onboarding on for the presentation-proof harness
    /// (`-reproOnboarding`), independent of the server knob. DEBUG only.
    func debugForceRepro() {
        wallOnboardingEnabled = true
        hasCompletedOnboarding = false
        UserDefaults.standard.set(false, forKey: "onboarding_started")
        step = .language
    }
    /// Directly set the beat (harness walk).
    func debugSet(_ s: Step) { step = s }
    #endif
}
