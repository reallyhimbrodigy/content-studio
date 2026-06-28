import Foundation
import SwiftUI
import StoreKit
import UIKit

/// Single source of truth for the in-app feedback loop on the client.
///
/// Owns the persisted cadence state (how many renders the user has watched,
/// when we last prompted, how many prompts they've ignored, when they last
/// answered, and when we last asked StoreKit for an App Store review) and
/// delegates every show/eligibility *decision* to ``FeedbackGate`` — a pure,
/// UIKit-free, clock-free module that takes the current state + a `now: Date`.
/// This keeps all the timing logic deterministic and unit-testable via
/// `swiftc`, while this class handles persistence, StoreKit, and the network.
///
/// Persistence lives in `UserDefaults` under the `feedback.` key prefix.
/// Network submission POSTs `/api/feedback` using the app's authorized-request
/// pattern (AuthService bearer token + APIService.requestData) and is strictly
/// best-effort: failures are swallowed so feedback never blocks the UI.
@MainActor
final class FeedbackManager: ObservableObject {
    static let shared = FeedbackManager()

    // MARK: - UserDefaults keys (all prefixed "feedback.")

    private enum Key {
        static let successfulRenderCount = "feedback.successfulRenderCount"
        static let lastPromptAt = "feedback.lastPromptAt"
        static let ignoreStreak = "feedback.ignoreStreak"
        static let lastAnswerAt = "feedback.lastAnswerAt"
        static let lastAppStorePromptAt = "feedback.lastAppStorePromptAt"
    }

    // MARK: - Published state (drives SwiftUI bindings)

    @Published private(set) var successfulRenderCount: Int
    @Published private(set) var lastPromptAt: Date?
    @Published private(set) var ignoreStreak: Int
    @Published private(set) var lastAnswerAt: Date?
    @Published private(set) var lastAppStorePromptAt: Date?

    private let defaults: UserDefaults

    private init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.successfulRenderCount = defaults.integer(forKey: Key.successfulRenderCount)
        self.lastPromptAt = defaults.object(forKey: Key.lastPromptAt) as? Date
        self.ignoreStreak = defaults.integer(forKey: Key.ignoreStreak)
        self.lastAnswerAt = defaults.object(forKey: Key.lastAnswerAt) as? Date
        self.lastAppStorePromptAt = defaults.object(forKey: Key.lastAppStorePromptAt) as? Date
    }

    // MARK: - Derived state snapshot for the gate

    /// Bundles the current persisted state into the value type that
    /// ``FeedbackGate`` consumes. Always reads the live published fields so
    /// the gate sees the same thing the UI does.
    private var currentState: FeedbackGate.State {
        FeedbackGate.State(
            successfulRenderCount: successfulRenderCount,
            lastPromptAt: lastPromptAt,
            ignoreStreak: ignoreStreak,
            lastAnswerAt: lastAnswerAt,
            lastAppStorePromptAt: lastAppStorePromptAt
        )
    }

    // MARK: - Signals

    /// Call when the user actually *watches* a completed render (i.e. taps
    /// play on a finished video). This is the only thing that moves the user
    /// toward becoming prompt-eligible — generating a render they never watch
    /// doesn't count.
    func recordRenderWatched() {
        successfulRenderCount += 1
        defaults.set(successfulRenderCount, forKey: Key.successfulRenderCount)
    }

    /// Pure cadence decision: should we surface the feedback prompt right now?
    /// Delegates entirely to ``FeedbackGate`` with the live state + wall clock.
    func shouldShowPrompt() -> Bool {
        FeedbackGate.shouldShowPrompt(state: currentState, now: Date())
    }

    /// Call the moment the prompt is shown to the user. Starts the cooldown
    /// clock so we don't re-ask on the very next watched render.
    func recordPromptShown() {
        let now = Date()
        lastPromptAt = now
        defaults.set(now, forKey: Key.lastPromptAt)
    }

    /// User dismissed/ignored the prompt without answering. Lengthens the
    /// backoff (the gate uses `ignoreStreak` to pick a longer cooldown) and
    /// resets the cooldown clock.
    func recordDismissed() {
        let now = Date()
        ignoreStreak += 1
        lastPromptAt = now
        defaults.set(ignoreStreak, forKey: Key.ignoreStreak)
        defaults.set(now, forKey: Key.lastPromptAt)
    }

    /// User gave positive feedback. Resets the ignore streak, records the
    /// answer time, and — if we're past the App Store review interval cap —
    /// asks StoreKit for a native review prompt and records that we did so.
    func recordThumbsUp() {
        let now = Date()
        ignoreStreak = 0
        lastAnswerAt = now
        defaults.set(ignoreStreak, forKey: Key.ignoreStreak)
        defaults.set(now, forKey: Key.lastAnswerAt)

        if FeedbackGate.appStoreReviewEligible(state: currentState, now: now) {
            requestAppStoreReview()
            lastAppStorePromptAt = now
            defaults.set(now, forKey: Key.lastAppStorePromptAt)
        }
    }

    /// User gave negative feedback. Resets the ignore streak and records the
    /// answer time. We never trigger an App Store review on a thumbs-down.
    func recordThumbsDown() {
        let now = Date()
        ignoreStreak = 0
        lastAnswerAt = now
        defaults.set(ignoreStreak, forKey: Key.ignoreStreak)
        defaults.set(now, forKey: Key.lastAnswerAt)
    }

    // MARK: - StoreKit review

    /// Requests the native StoreKit "Rate This App" prompt via the active
    /// window scene. iOS rate-limits this system-side regardless of how often
    /// we call it; our own 90-day cap (the ``FeedbackGate`` eligibility check)
    /// keeps us well under that. Best-effort — any failure is non-fatal.
    private func requestAppStoreReview() {
        guard let scene = UIApplication.shared.connectedScenes
            .first(where: { $0.activationState == .foregroundActive }) as? UIWindowScene
            ?? UIApplication.shared.connectedScenes.first as? UIWindowScene else {
            print("[feedback] no active window scene for review request")
            return
        }
        AppStore.requestReview(in: scene)
    }

    // MARK: - Network submission (best-effort)

    /// POSTs the user's feedback to `/api/feedback` using the app's authorized
    /// request pattern. Best-effort: any auth/network/encoding failure is
    /// caught and swallowed so feedback submission never surfaces an error to
    /// the user.
    func submitFeedback(rating: String?, text: String?, jobId: String?) async {
        guard let token = await AuthService.shared.getValidToken() else {
            print("[feedback] submit skipped — no valid token")
            return
        }

        guard let url = URL(string: "https://usepromptly.app/api/feedback") else { return }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")

        let body: [String: String?] = [
            "rating": rating,
            "text": text,
            "job_id": jobId,
            "app_version": Self.appVersion
        ]

        do {
            request.httpBody = try JSONEncoder().encode(body)
            _ = try await APIService.shared.requestData(request)
        } catch {
            print("[feedback] submit error (non-fatal): \(error.localizedDescription)")
        }
    }

    /// Short marketing version string (e.g. "1.1.5") for the feedback payload.
    private static var appVersion: String {
        (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "unknown"
    }
}
