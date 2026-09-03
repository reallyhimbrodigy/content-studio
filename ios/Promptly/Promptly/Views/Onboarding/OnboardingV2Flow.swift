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
    /// `-motionProof YES` walks the flow so a screen recording can evidence
    /// motion the still-frame harness deliberately cannot.
    ///
    /// NOT wrapped in `#if DEBUG`, deliberately. It was, and the call sites
    /// below were not — so this file compiled only in Debug and the break was
    /// invisible to every simulator build. A launch-argument check that always
    /// returns false in production is far cheaper than a configuration-specific
    /// compile error discovered at archive time.
    private var motionProof: Bool { ProcessInfo.processInfo.arguments.contains("-motionProof") }

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
                                       progress: (1, 2), onSkip: {},
                                       onContinue: { picked in
                    record(step: "audience", value: picked.first) { state.v2Audience = $0 }
                    goingForward = true
                    state.v2Step = .videoType
                }, autoDriveKey: motionProof ? "clients" : nil)

            case .videoType:
                VideoTypeQuestionView(progress: (2, 2), onSkip: {},
                                      onContinue: { picked in
                    record(step: "video_type", value: picked.first) { state.v2VideoType = $0 }
                    // The ONE question that still feeds the edit: its answer
                    // becomes the composer prefill → vibe_input on the render.
                    state.preselectedVibe = OnboardingQuestion.vibeV2(forVideoType: picked.first)
                    goingForward = true
                    // THE SOFT PAYWALL. Restored after Q2 — dismissible, and
                    // dismissing ADVANCES rather than blocking. It sells before
                    // first value again, which is the trade being made
                    // knowingly; what it does not do is trap anyone.
                    state.v2Step = .paywall
                }, autoDrive: motionProof ? ("podcast", "fast") : nil)

            // ── RETIRED BEATS ────────────────────────────────────────────
            // The paywall, the reveal, the invite rung and attribution are no
            // longer steps in this flow. They are kept as enum cases ONLY so a
            // persisted `onboarding_v2_step` written by an older build still
            // parses — dropping the cases would make `V2Step(rawValue:)` return
            // nil and strand a mid-flow user on a screen that no longer exists.
            // Anyone restored into one is simply finished: they answered the
            // questions on the old build, and the money moments now live at the
            // credit wall.
            case .attribution, .reveal, .referralCatch:
                Color.black.ignoresSafeArea()
                    .task { complete() }

            case .paywall:
                // THE SOFT ASK. `onFinished` fires from FirstLaunchPaywallView's
                // single exit — the X, a completed purchase, the proof driver —
                // so every way out advances the flow and none of them strands
                // the user on a screen with no forward.
                //
                // NO EXIT-INTENT DISCOUNT HERE, and it needs no code to prevent:
                // the catch lives in `UpgradePaywall`, and this view renders
                // `TwoStepPaywall` DIRECTLY. The discount stays reserved for a
                // post-value dismissal, where the user has something to weigh it
                // against. Routing this through UpgradePaywall would hand it to
                // someone who has not made a video yet — the automatic reveal
                // that item 3 removed.
                FirstLaunchPaywallView(onFinished: { complete() })

            case .done:
                Color.black.ignoresSafeArea()
            }
        }
        .transition(beatTransition)
        .animation(OnboardingMotion.step(reduceMotion), value: state.v2Step)
        .onAppear {
            Analytics.track("onboarding_v2_step", props: ["step": "start", "context": "onboarding_v2"])
            state.markFlowStarted()
            let before = state.v2Step
            state.restoreV2()
            if state.hasCompletedOnboarding { state.v2Step = .done }
            // Q1's ARRIVAL WAS NEVER COUNTED. `v2Step` emits `phase:"arrive"`
            // from its `didSet`, and a `didSet` does not fire for the property's
            // INITIAL value — and `.audience` is that initial value. So every
            // user who started at Q1 emitted an arrive for Q2, Q3 and the
            // reveal but never for Q1: measured over the last 7 days,
            // video_type arrive = 472 users against audience arrive = 10.
            //
            // The first question is exactly where a funnel needs its
            // denominator, so the one step with no arrival was the one whose
            // drop-off could not be computed at all. Emitted here only when
            // restore did NOT move the step — if it did, the didSet already
            // fired and a second event would double-count the beat.
            if state.v2Step == before {
                Analytics.track("onboarding_v2_step",
                                props: ["step": state.v2Step.analyticsName,
                                        "phase": "arrive",
                                        "context": "onboarding_v2"])
            }
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




    /// One answer seam: emit, store, and treat Skip honestly (a skipped
    /// question stores nothing — never a placeholder value).
    private func record(step: String, value: String?, store: (String) -> Void) {
        // `phase` distinguishes this from the ARRIVAL event the v2Step didSet
        // emits for the same beat. Both used to write `step` alone, which made
        // Q1's arrival and answer the same row. `\(step)_skip` is kept as the
        // step value so the 23 existing rows on 237 stay comparable, and the
        // phase is carried alongside for readers that want the clean split.
        if let value {
            store(value)
            Analytics.track("onboarding_v2_step",
                            props: ["step": step, step: value,
                                    "phase": "answer", "context": "onboarding_v2"])
        } else {
            Analytics.track("onboarding_v2_step",
                            props: ["step": "\(step)_skip",
                                    "phase": "skip", "context": "onboarding_v2"])
        }
    }

    /// The ONE completion seam. Order matters: `hasCompletedOnboarding` must
    /// be set BEFORE the v2Step flip, because the flip's objectWillChange is
    /// what makes PromptlyApp re-evaluate its branch.
    private func complete() {
        Analytics.track("onboarding_completed", props: ["context": "onboarding_v2"])
        state.persistAnswersToProfile()
        state.hasCompletedOnboarding = true
        // The first run is over, recorded in the KEYCHAIN so a reinstall does
        // not replay it. `hasCompletedOnboarding` lives in UserDefaults and is
        // erased with the app, which is exactly the case this guards.
        FirstRun.markSeen()
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

// MARK: - The decline catch rung

/// THE LAST RUNG of the first-run ask — shown to a user who has just declined
/// the discount. 2026-09-02.
///
/// WHY IT EXISTS. "Decline offer" was a dead end: the user said no and the flow
/// ended. The referral was present, but as one LINE on the reveal — a line
/// beside a price, on a screen the declining user has already decided to
/// ignore. Someone who has just refused to pay is the one person for whom "not
/// ready to pay?" is the right question, and it deserves the whole screen
/// rather than a footnote on the screen they rejected.
///
/// NOT AN ARGUMENT. There is no second attempt to sell here and no discount
/// restated. A user who has declined twice is owed an exit that does not
/// bargain, so the skip is a plain text link with plain words, and it is always
/// visible without scrolling.
///
/// COPY COMES FROM `ReferralCopy`, the one file allowed to write the referral
/// promise. Four surfaces once spelled it themselves and disagreed about the
/// reward by a factor of seven; a fifth spelling it here would be that defect
/// returning through a new door.
struct ReferralCatchBeat: View {
    let onSkip: () -> Void

    @ObservedObject private var onboarding = OnboardingState.shared
    @State private var shared = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer(minLength: 24)

                Image("PromptlyLogo")
                    .renderingMode(.original)
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 28, height: 28)
                    .padding(.bottom, 18)

                Text(ReferralCopy.catchHeading)
                    .cType(26, .bold)
                    .foregroundColor(.white)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)

                Text(ReferralCopy.catchOffer)
                    .cType(15, .medium)
                    .foregroundColor(.white.opacity(0.7))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 28)
                    .padding(.top, 10)

                // The live count, when the user has already shared. It reports
                // where they are rather than restating the ask — and it is the
                // reason this rung is worth returning to.
                if onboarding.referralProgressEnabled {
                    ReferralProgressRow(source: "decline_catch", compact: true)
                        .padding(.top, 18)
                        .padding(.horizontal, 24)
                }

                Spacer(minLength: 16)

                Button {
                    Analytics.track("referral_share", props: ["source": "decline_catch"])
                    shared = true
                    Task { await ReferralService.shared.presentShareSheet(source: "decline_catch") }
                } label: {
                    Text(ReferralCopy.shareAction)
                        .cType(16, .semibold)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(
                            RoundedRectangle(cornerRadius: 28, style: .continuous)
                                .fill(Color(hex: "6C5CE7"))
                        )
                }
                .padding(.horizontal, 20)

                Button(action: onSkip) {
                    Text(ReferralCopy.catchSkip)
                        .cType(14, .medium)
                        .foregroundColor(.white.opacity(0.55))
                        .padding(.vertical, 14)
                }
                .padding(.bottom, 8)
            }
        }
        .onAppear {
            Analytics.track("referral_shown", props: ["source": "decline_catch"])
        }
    }
}
