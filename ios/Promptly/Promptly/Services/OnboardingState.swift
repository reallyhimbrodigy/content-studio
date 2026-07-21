import Foundation
import SwiftUI

/// State core for the 1.2.0 wall onboarding (hook → signup → quiz → reveal →
/// social proof → trial wall). Owns:
///   - the EXPOSURE decision (the one knob): `/api/health.wall_enforcement`,
///     fetched pre-auth (no token needed). 'on' → wall onboarding; anything
///     else (or fetch failure) → today's legacy flow, byte-for-byte. The same
///     knob drives the server gates — flip once, both halves move together.
///   - quiz answers (persisted; feed personalization + person properties),
///   - flow position, so a killed app resumes where it left off.
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

    // ── Flow position ────────────────────────────────────────────────────────
    enum Step: String, Codable {
        case hook           // before/after demo, pre-signup
        case signup         // Sign in with Apple first
        case quiz           // language → creator questions → aspiration
        case building       // "building your studio" reveal
        case socialProof    // honest numbers
        case wall           // the trial-timeline paywall
        case done           // trial started or Pro purchased — into the app
    }

    @Published var step: Step = .hook {
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
            // Never restore into signup/hook once authenticated — the flow
            // container re-derives the right entry from auth + completion.
            step = s
        }
    }

    // ── Quiz answers ─────────────────────────────────────────────────────────
    struct QuizAnswers: Codable {
        var language: String?      // BCP-47 code the user picked (step one)
        var creates: String?       // what do you create?
        var platform: String?      // where do you post?
        var frequency: String?     // how often?
        var goal: String?          // your goal
        var aspiration: String?    // where do you want to be in 90 days?
    }

    @Published var answers = QuizAnswers() {
        didSet {
            if let data = try? JSONEncoder().encode(answers) {
                UserDefaults.standard.set(data, forKey: "onboarding_answers")
            }
        }
    }

    private init() {
        if let data = UserDefaults.standard.data(forKey: "onboarding_answers"),
           let a = try? JSONDecoder().decode(QuizAnswers.self, from: data) {
            answers = a
        }
    }

    #if DEBUG
    /// Force the wall onboarding on for the presentation-proof harness
    /// (`-reproOnboarding`), independent of the server knob: enable exposure,
    /// clear completion, rewind to the hook. DEBUG only.
    func debugForceRepro() {
        wallOnboardingEnabled = true
        hasCompletedOnboarding = false
        UserDefaults.standard.set(false, forKey: "onboarding_started")
        answers = QuizAnswers(language: "en", creates: "Talking-head videos",
                              platform: "TikTok", frequency: "Daily",
                              goal: "Grow my audience", aspiration: "First viral video")
        step = .hook
    }
    /// Directly set the beat (harness walk).
    func debugSet(_ s: Step) { step = s }
    #endif
}
