import SwiftUI

/// Onboarding v2 — the `onboarding_v2` knob. It ENDS AT THE PICKER: NO
/// PAYWALL ANYWHERE in this flow (that placement was removed for cause — the
/// money ask lives on its own surfaces now).
///
/// Beat order (amendment 2026-08-27 — THREE questions, the third earns its
/// place by naming the editing register the composer opens on):
///   1. LANGUAGE — LanguageSelectionView verbatim, and AUTO-SKIPPED when a
///      language is already set (so the returning/正 configured user pays 3
///      beats, not 4).
///   2. PLATFORM — primary platform. Shapes aspect/pacing expectations and
///      the render-wait copy.
///   3. MAKING — content type. The strongest prefill signal.
///   4. STYLE — "Whose editing style do you like?" Style DESCRIPTORS, not
///      creator names (see `styleV2` for why).
///   5. ATTRIBUTION — the shared ask (AttributionAskView), skippable.
///   6. SIGN-IN — the real AuthView embedded, only when unauthenticated.
/// Then DONE → `hasCompletedOnboarding` + PromptlyApp swaps to the normal
/// app (the picker path).
///
/// WHERE THE ANSWERS GO (the honest account — no dead fields):
///   • All three compose ONE natural-language vibe line into the composer
///     prefill (`preselectedVibe`). That line becomes `vibe_input` on the
///     render request, which IS the editorial channel the pipeline reads —
///     so the answers do reach the edit, as text.
///   • There is NO structured editorial-style preset field in the pipeline
///     today (server takes `vibe` as free text; no style_preset column). So
///     the style answer is NOT stored into any structured style field — it
///     shapes the vibe text and rides profile_settings for segmentation.
///     If a preset system lands later, `v2Style` is the key to map.
///
/// PRECEDENCE: onboarding_v2 (when on) SUPERSEDES the standalone
/// attribution_gate — this flow CONTAINS the same attribution screen, so
/// PromptlyApp's `showAttributionGate` stands down while this knob is on.
/// Both knobs off = today's flow, byte-for-byte — PromptlyApp makes that
/// branch, not us.
struct OnboardingV2Flow: View {
    @StateObject private var state = OnboardingState.shared
    @State private var auth = AuthService.shared

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch state.v2Step {
            case .language:
                LanguageSelectionView {
                    state.v2Step = .platform
                }
                .transition(.opacity)

            case .platform:
                OnboardingQuestionView(question: .platformV2,
                                       progress: (beat(1), totalBeats), onSkip: {}) { picked in
                    record(step: "platform", value: picked.first) { state.v2Platform = $0 }
                    state.v2Step = .making
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .making:
                OnboardingQuestionView(question: .makingV2,
                                       progress: (beat(2), totalBeats), onSkip: {}) { picked in
                    record(step: "making", value: picked.first) { state.v2Making = $0 }
                    state.v2Step = .style
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .style:
                OnboardingQuestionView(question: .styleV2,
                                       progress: (beat(3), totalBeats), onSkip: {}) { picked in
                    record(step: "style", value: picked.first) { state.v2Style = $0 }
                    // All three answers compose ONE prefill line (see doc
                    // comment): the composer opens on a style, never blank.
                    state.preselectedVibe = OnboardingQuestion.composedVibeV2(
                        platform: state.v2Platform,
                        making: state.v2Making,
                        style: state.v2Style)
                    state.persistAnswersToProfile()
                    state.v2Step = .attribution
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .attribution:
                AttributionAskView(context: "onboarding_v2", progress: (beat(4), totalBeats)) {
                    if auth.isAuthenticated { complete() }
                    else { state.v2Step = .signin }
                }
                .transition(.move(edge: .trailing).combined(with: .opacity))

            case .signin:
                // The real AuthView, untouched, embedded mid-flow. The flow
                // (not the root) reacts to the auth flip via onChange below,
                // so success completes onboarding instead of jumping branches.
                AuthView()
                    .transition(.opacity)

            case .done:
                // PromptlyApp re-branches on the v2Step flip inside complete();
                // this is just the last frame before AppShell.
                Color.black.ignoresSafeArea()
            }
        }
        .animation(.spring(response: 0.34, dampingFraction: 1.0), value: state.v2Step)
        .onChange(of: auth.isAuthenticated) { _, isAuthed in
            if isAuthed && state.v2Step == .signin {
                // The real signup moment → done (nothing is asked after it).
                Analytics.track("signup_completed", props: ["context": "onboarding_v2"])
                complete()
            }
        }
        .onAppear {
            Analytics.track("onboarding_v2_step", props: ["step": "start", "context": "onboarding_v2"])
            state.markFlowStarted()
            state.restoreV2()
            // Beat 1 is skipped outright when the language is already set —
            // a returning/localised user walks the three questions only.
            if state.v2Step == .language && languageAlreadySet {
                state.v2Step = .platform
            }
            // Completed → straight to done. Resumed on the sign-in beat while
            // already authed (killed between auth and completion) → nothing
            // left to ask, complete now.
            if state.hasCompletedOnboarding {
                state.v2Step = .done
            } else if auth.isAuthenticated && state.v2Step == .signin {
                complete()
            }
        }
    }

    /// Language auto-skips when already chosen, so the progress numerator
    /// tracks what the user actually walks. Questions are beats 1-3,
    /// attribution 4 (sign-in is structural, never numbered).
    private var languageAlreadySet: Bool { state.preferredLanguage != nil }
    private var totalBeats: Int { 4 }
    private func beat(_ n: Int) -> Int { n }

    /// One answer seam: emit, store, and treat Skip honestly (a skipped
    /// question stores nothing — never a placeholder value).
    private func record(step: String, value: String?, store: (String) -> Void) {
        if let value {
            store(value)
            Analytics.track("onboarding_v2_step",
                            props: ["step": step, step: value, "context": "onboarding_v2"])
        } else {
            Analytics.track("onboarding_v2_step",
                            props: ["step": "\(step)_skip", "context": "onboarding_v2"])
        }
    }

    /// The ONE completion seam. Order matters: `hasCompletedOnboarding` must
    /// be set BEFORE the v2Step flip, because the flip's objectWillChange is
    /// what makes PromptlyApp re-evaluate its branch (hasCompletedOnboarding
    /// itself is UserDefaults-computed, not @Published).
    private func complete() {
        Analytics.track("onboarding_completed", props: ["context": "onboarding_v2"])
        state.hasCompletedOnboarding = true
        state.v2Step = .done
    }
}

// MARK: - V2 question data

extension OnboardingQuestion {
    /// V2 beat 2 — "What are you making?" Three honest buckets. `step` is
    /// inert metadata here (v2 keeps its own position in
    /// `OnboardingState.v2Step`) — .intent is the closest semantic slot.
    static let makingV2 = OnboardingQuestion(
        step: .intent,
        title: String(localized: "What are you making?"),
        subtitle: String(localized: "We'll start you on a matching style."),
        options: [
            ("podcast", String(localized: "Podcast clips")),
            ("talkinghead", String(localized: "Talking-head videos")),
            ("other", String(localized: "Something else")),
        ],
        event: "onboarding_v2_step",
        propKey: "making"
    )

    /// V2 beat 2 — primary platform (amendment 2026-08-27). Shapes the vibe
    /// line's pacing/format expectation and the render-wait copy.
    static let platformV2 = OnboardingQuestion(
        step: .intent,
        title: String(localized: "Where do you post?"),
        subtitle: String(localized: "We'll cut for that feed."),
        options: [
            ("tiktok", String(localized: "TikTok")),
            ("reels", String(localized: "Instagram Reels")),
            ("shorts", String(localized: "YouTube Shorts")),
            ("linkedin", String(localized: "LinkedIn")),
            ("multi", String(localized: "A few of them")),
        ],
        event: "onboarding_v2_step",
        propKey: "platform"
    )

    /// V2 beat 4 — editing style.
    ///
    /// DELIBERATE: options are style DESCRIPTORS, not creator names. Naming
    /// real creators would put third-party identities in our product copy
    /// (and in every localisation), and the pipeline consumes free text — a
    /// descriptor tells the editor exactly as much as a name does, without
    /// borrowing someone's identity. Flagged for Zac: if he wants named
    /// references, it is a one-array swap here.
    static let styleV2 = OnboardingQuestion(
        step: .intent,
        title: String(localized: "Whose editing style do you like?"),
        subtitle: String(localized: "Pick the register — you can change it any time."),
        options: [
            ("fastcut", String(localized: "Fast-cut and high energy")),
            ("clean", String(localized: "Clean and minimal")),
            ("cinematic", String(localized: "Cinematic and documentary")),
            ("captionled", String(localized: "Caption-led and meme-ish")),
            ("calm", String(localized: "Calm and conversational")),
            ("other", String(localized: "Something else")),
        ],
        event: "onboarding_v2_step",
        propKey: "style"
    )

    /// V2 beat 3 — content type (kept from the original brief).
    /// The three answers compose ONE natural-language prefill line, which
    /// becomes `vibe_input` on the render — the pipeline's actual editorial
    /// channel. nil (all skipped) → blank composer, today's behaviour.
    static func composedVibeV2(platform: String?, making: String?, style: String?) -> String? {
        var parts: [String] = []
        switch making {
        case "podcast":     parts.append("podcast clips, best moments")
        case "talkinghead": parts.append("talking-head clean-up")
        default: break
        }
        switch style {
        case "fastcut":     parts.append("fast cuts, high energy, punchy captions")
        case "clean":       parts.append("clean and minimal, restrained captions")
        case "cinematic":   parts.append("cinematic pacing, documentary feel")
        case "captionled":  parts.append("caption-led, meme energy")
        case "calm":        parts.append("calm and conversational, light captions")
        default: break
        }
        switch platform {
        case "tiktok", "reels", "shorts": parts.append("cut for vertical short-form")
        case "linkedin":                  parts.append("cut for a professional feed")
        default: break
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// Human label for the chosen content type — used by the render-wait copy
    /// and the export gate's benefit page (amendment 2026-08-27). nil when
    /// the question was skipped, so callers fall back to generic copy.
    static func makingLabelV2(_ key: String?) -> String? {
        switch key {
        case "podcast":     return String(localized: "podcast")
        case "talkinghead": return String(localized: "talking-head")
        default:            return nil
        }
    }
}
