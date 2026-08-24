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
    @Published private(set) var postrenderSaveCtaEnabled = false
    @Published private(set) var chatMediaEnabled = false

    /// Show-once: set when the first-launch wall is dismissed or purchased
    /// through. @Published so the root ZStack re-branches the moment it flips.
    @Published var hasSeenFirstLaunchPaywall: Bool =
        UserDefaults.standard.bool(forKey: "first_launch_paywall_seen") {
        didSet {
            UserDefaults.standard.set(hasSeenFirstLaunchPaywall,
                                      forKey: "first_launch_paywall_seen")
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
            postrenderSaveCtaEnabled = (obj?["postrender_save_cta"] as? String) == "on"
            chatMediaEnabled = (obj?["chat_media"] as? String) == "on"
            UserDefaults.standard.set(postrenderReferralEnabled, forKey: "postrender_referral_enabled")
            UserDefaults.standard.set(abandonReferralEnabled, forKey: "abandon_referral_enabled")
            UserDefaults.standard.set(ambientWallReferralEnabled, forKey: "ambient_wall_referral_enabled")
            UserDefaults.standard.set(postrenderSaveCtaEnabled, forKey: "postrender_save_cta_enabled")
            UserDefaults.standard.set(chatMediaEnabled, forKey: "chat_media_enabled")
        } catch {
            // Offline / server hiccup: last-known knobs, default off.
            wallOnboardingEnabled = UserDefaults.standard.bool(forKey: cacheKey)
            firstLaunchPaywallEnabled = UserDefaults.standard.bool(forKey: flpCacheKey)
            postrenderReferralEnabled = UserDefaults.standard.bool(forKey: "postrender_referral_enabled")
            abandonReferralEnabled = UserDefaults.standard.bool(forKey: "abandon_referral_enabled")
            ambientWallReferralEnabled = UserDefaults.standard.bool(forKey: "ambient_wall_referral_enabled")
            postrenderSaveCtaEnabled = UserDefaults.standard.bool(forKey: "postrender_save_cta_enabled")
            chatMediaEnabled = UserDefaults.standard.bool(forKey: "chat_media_enabled")
        }
    }

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
