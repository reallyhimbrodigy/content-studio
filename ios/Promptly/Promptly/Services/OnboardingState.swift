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

    /// One fetch per launch, ~instant (same host as every other call). Cached
    /// result also persisted so a cold offline launch uses the last-known knob.
    func resolveExposure() async {
        let cacheKey = "wall_onboarding_enabled"
        do {
            var req = URLRequest(url: URL(string: "https://usepromptly.app/api/health")!)
            req.timeoutInterval = 5
            let (data, _) = try await URLSession.shared.data(for: req)
            let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let on = (obj?["wall_enforcement"] as? String) == "on"
            wallOnboardingEnabled = on
            UserDefaults.standard.set(on, forKey: cacheKey)
        } catch {
            // Offline / server hiccup: last-known knob, default off.
            wallOnboardingEnabled = UserDefaults.standard.bool(forKey: cacheKey)
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
    enum Step: String, Codable {
        case language       // pick the app language (kept from the quiz)
        case signup         // Sign in with Apple
        case socialProof    // honest numbers (+ the native review prompt)
        case wall           // the trial-timeline paywall
        case done           // trial started or Pro purchased — into the app
    }

    @Published var step: Step = .language {
        didSet {
            UserDefaults.standard.set(step.rawValue, forKey: "onboarding_step")
            Analytics.track("onboarding_step", props: ["step": step.rawValue])
        }
    }

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
