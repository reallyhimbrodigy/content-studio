import SwiftUI
import RevenueCat

/// Onboarding v2 — the `onboarding_v2` knob. RESTRUCTURED 2026-08-27 to the
/// verified Captions sequence:
///
///   1. FULL-PRICE PAYWALL — *not this view*. It is the existing
///      `FirstLaunchPaywallView`, reached by the `first_launch_paywall` knob,
///      whose root branch already sits ABOVE this flow in PromptlyApp: the
///      user sees the paywall, dismisses it with its X (which sets
///      hasSeenFirstLaunchPaywall), and the root falls through to here. That
///      screen deliberately says NOTHING about a discount — which is what
///      lets the reveal at the end land as news instead of a correction.
///   2-4. THREE QUESTIONS — audience → video type → attribution. Each has a
///      Skip, and Continue stays disabled until a choice is made.
///   5. OFFER REVEAL — full price struck through against the live intro
///      price. Escape hatch is a "Decline offer" TEXT LINK, never an X.
///      SKIPPED ENTIRELY when no real paid intro offer exists on any package
///      (we never invent a discount to have something to reveal) and when the
///      user already bought on screen one.
///   Then DONE → the picker.
///
/// Q3 MERGES the standalone attribution gate into this flow — that gate is
/// now retired (PromptlyApp's `showAttributionGate` stands down whenever v2
/// is armed, and v2 is the flow that will actually reach users). This is the
/// real fix for a question that has produced ZERO answers all-time: it was
/// never in a live path.
///
/// EDITORIAL SIGNAL (the cost this restructure incurred, and how it was
/// repaid): replacing the old style question with attribution left Q2 as the
/// ONLY question feeding the edit — attribution is a marketing input and
/// changes no pixel of the output. Q2 therefore carries BOTH signals: it asks
/// content type, and offers editing style as a separate optional control on
/// the same screen (see VideoTypeQuestionView). Both halves are encoded into
/// one stored key so `vibeV2` can compose the prefill from each.
struct OnboardingV2Flow: View {
    @StateObject private var state = OnboardingState.shared
    @ObservedObject private var subscription = SubscriptionService.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Beats carry DIRECTION: forward slides in from the trailing edge, a
    /// back-step from the leading edge. Without it every advance reads the
    /// same and the flow has no sense of place.
    @State private var goingForward = true
    #if DEBUG
    /// `-motionProof YES` walks the flow so a screen recording can evidence
    /// motion the still-frame harness deliberately cannot.
    private var motionProof: Bool { ProcessInfo.processInfo.arguments.contains("-motionProof") }
    #endif

    private var packages: [Package] {
        SubscriptionService.sortedByDuration(subscription.offerings?.current?.availablePackages ?? [])
    }

    var body: some View {
        // Render-caught 2026-08-27: this wrapper used to paint its own
        // `Color.black.ignoresSafeArea()` around the beat views. Each beat
        // ALREADY paints that background, and the extra safe-area-ignoring
        // layer resized the container the beats laid out in — every question
        // screen rendered shifted off the left edge ("ho are you making
        // videos for?"). Proven by rendering the same component bare, which
        // was correct. The group owns no background; the beats do.
        Group {
            switch state.v2Step {
            case .audience:
                OnboardingQuestionView(question: .audienceV2,
                                       progress: (1, 3), onSkip: {},
                                       onContinue: { picked in
                    record(step: "audience", value: picked.first) { state.v2Audience = $0 }
                    goingForward = true
                    state.v2Step = .videoType
                }, autoDriveKey: motionProof ? "clients" : nil)

            case .videoType:
                VideoTypeQuestionView(progress: (2, 3), onSkip: {},
                                      onContinue: { picked in
                    record(step: "video_type", value: picked.first) { state.v2VideoType = $0 }
                    // The ONE question that still feeds the edit: its answer
                    // becomes the composer prefill → vibe_input on the render.
                    state.preselectedVibe = OnboardingQuestion.vibeV2(forVideoType: picked.first)
                    goingForward = true
                    state.v2Step = .attribution
                }, autoDrive: motionProof ? ("podcast", "fast") : nil)

            case .attribution:
                AttributionAskView(context: "onboarding_v2", progress: (3, 3)) {
                    state.persistAnswersToProfile()
                    advanceFromAttribution()
                }
                #if DEBUG
                .task {
                    guard motionProof else { return }
                    try? await Task.sleep(nanoseconds: 1_600_000_000)
                    advanceFromAttribution()
                }
                #endif

            case .reveal:
                OfferRevealView(onDecline: { complete() }, onPurchased: { complete() })

            case .done:
                Color.black.ignoresSafeArea()
            }
        }
        .transition(beatTransition)
        .animation(OnboardingMotion.step(reduceMotion), value: state.v2Step)
        .onAppear {
            Analytics.track("onboarding_v2_step", props: ["step": "start", "context": "onboarding_v2"])
            state.markFlowStarted()
            state.restoreV2()
            if state.hasCompletedOnboarding { state.v2Step = .done }
            if packages.isEmpty { Task { await subscription.refreshOfferings() } }
        }
    }

    /// Directional slide, or a plain crossfade under Reduce Motion (the
    /// change still reads; it just doesn't travel).
    private var beatTransition: AnyTransition {
        if reduceMotion { return .opacity }
        return .asymmetric(
            insertion: .move(edge: goingForward ? .trailing : .leading).combined(with: .opacity),
            removal: .move(edge: goingForward ? .leading : .trailing).combined(with: .opacity))
    }

    /// After Q3: the reveal only runs when there is a REAL offer to reveal and
    /// the user has not already subscribed on screen one.
    private func advanceFromAttribution() {
        // The reveal honours the plan the user is already leaning on: yearly
        // offers now exist in all 175 territories, so an annual-leaning user
        // sees the ANNUAL offer rather than being switched to a monthly one.
        let preferred = OfferReveal.preferredPackage(in: packages)
        if subscription.isPro || !OfferReveal.isAvailable(in: packages, preferring: preferred) {
            Analytics.track("offer_reveal_skipped",
                            props: ["context": "onboarding_v2",
                                    "reason": subscription.isPro ? "already_pro" : "no_offer_on_products"])
            complete()
        } else {
            goingForward = true
            state.v2Step = .reveal
        }
    }

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
    /// what makes PromptlyApp re-evaluate its branch.
    private func complete() {
        Analytics.track("onboarding_completed", props: ["context": "onboarding_v2"])
        state.persistAnswersToProfile()
        state.hasCompletedOnboarding = true
        state.v2Step = .done
    }
}

// MARK: - V2 question data (restructured 2026-08-27)

extension OnboardingQuestion {
    /// Q1 — who the videos are for. Segmentation + the reveal's benefit copy.
    static let audienceV2 = OnboardingQuestion(
        step: .audience,
        title: String(localized: "Who are you making videos for?"),
        subtitle: String(localized: "So Promptly can tailor the edit."),
        options: [
            ("clients", String(localized: "Clients (agency or freelance)")),
            ("myself", String(localized: "Myself (creator or personal use)")),
            ("small_business", String(localized: "My small business")),
            ("employer", String(localized: "A business I work at")),
            ("other", String(localized: "Other")),
        ],
        event: "onboarding_v2_step",
        propKey: "audience"
    )

    // Q2 has NO OnboardingQuestion entry: it is not a plain option list.
    // It asks content type AND offers editing style as a second, optional
    // control, so it owns its own view (VideoTypeQuestionView). The Cartesian
    // product that used to live here — "Podcast clips — fast cuts",
    // "Podcast clips — clean and minimal", "Talking head — punchy"... —
    // repeated every noun, grew with each style, and asked two questions
    // through one control. It was deleted, not left dormant, so it cannot be
    // rewired by a later reader. The stored key shape is unchanged.

    /// The content-type half of a Q2 key ("podcast:fast" -> "podcast").
    static func contentTypeV2(_ key: String?) -> String? {
        guard let key, key != "other" else { return nil }
        return key.split(separator: ":").first.map(String.init)
    }
    /// The style half ("podcast:fast" -> "fast"). nil when unstyled.
    static func styleV2(_ key: String?) -> String? {
        guard let key, key.contains(":") else { return nil }
        return key.split(separator: ":").dropFirst().first.map(String.init)
    }

    /// Q2 answer → the vibe the editor opens on (the prefill bridge
    /// EditorView consumes once), composed from BOTH halves of the key so the
    /// style register survives into `vibe_input`. nil = blank composer.
    static func vibeV2(forVideoType key: String?) -> String? {
        guard let type = contentTypeV2(key) else { return nil }
        var parts: [String] = []
        switch type {
        case "podcast":     parts.append("podcast clips, best moments")
        case "talkinghead": parts.append("talking-head clean-up")
        case "vlogs":       parts.append("vlog cut-down, keep the story moving")
        case "promo":       parts.append("product promo, hook first")
        default: break
        }
        switch styleV2(key) {
        case "fast":      parts.append("fast cuts, high energy, punchy captions")
        case "clean":     parts.append("clean and minimal, restrained captions")
        case "punchy":    parts.append("punchy pacing, bold captions")
        case "cinematic": parts.append("cinematic pacing, documentary feel")
        default: break
        }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    /// Human label for Q2 — used by the render-wait header and the export
    /// gate's benefit page. nil when skipped, so callers stay generic.
    static func makingLabelV2(_ key: String?) -> String? {
        switch contentTypeV2(key) {
        case "podcast":     return String(localized: "podcast")
        case "talkinghead": return String(localized: "talking-head")
        case "vlogs":       return String(localized: "vlog")
        case "promo":       return String(localized: "promo")
        default:            return nil
        }
    }
}
