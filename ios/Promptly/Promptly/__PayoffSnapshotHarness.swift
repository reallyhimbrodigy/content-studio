#if DEBUG
import SwiftUI

/// DEBUG-only snapshot harness for the §6 payoff + paywall-copy review.
///
/// Standing law: presentations proven by presentations. Zac reviews every visual
/// change as a delivered screenshot, so this renders the REAL views (MessageBubble,
/// PaywallView, TrialWallView) with mock data and lets an external
/// `xcrun simctl io booted screenshot` capture each state.
///
/// Launch with:  -snapshotPayoff YES -snapshotState N
///   N = 0  §6 result  (video + post package + Share hero)
///       1  failure card (credit note + one-tap retry)
///       2  paywall (feature list — copy audit)
///       3  upgrade wall (trial-wall bullets — copy audit)
///       4  paywall + AUTO purchase invoke after 3s (sandbox E2E-to-sheet)
///       5  upgrade wall + AUTO purchase invoke after 3s (sandbox E2E-to-sheet)
///       6  attribution ask, STANDALONE (flag attribution_gate; seen-flag reset)
///       7  onboarding v2 — beat 2 "What are you making?" (flag onboarding_v2,
///          v2Step forced to .making; progress 2/4, Continue disabled until pick)
///       8  onboarding v2 — beat 3 embedded attribution ask (flag onboarding_v2,
///          v2Step forced to .attribution; progress 3/4)
///       9  push primer — pure VIEW render (self-contained; no flag needed)
///      10  push primer — LIVE FLOW: flag push_primer + primer/soft/asked keys
///          cleared, then a delivered mock lands through ChatStore.scheduleSave
///          (the one persist choke point) → sheet presents ~0.9s later.
///          Requires: signed-in sim with ≥1 chat AND notification permission
///          notDetermined (fresh install or `xcrun simctl privacy ... reset`).
///
/// `-motionProof YES` — PERMANENT, not scaffolding (ruled 2026-08-27).
/// The settled-state assertion below deliberately kills animation so a
/// still can never catch a transition mid-flight; that makes this harness
/// structurally incapable of evidencing motion. `-motionProof` suppresses
/// the suppression and auto-drives the flow through the SAME state changes
/// a tap makes, for `xcrun simctl io booted recordVideo`. It earned its
/// keep on day one: the recording caught a personalisation bug (compound
/// Q2 keys read raw) that every still-frame proof had passed over, because
/// video exercises the flow end-to-end where a hand-posed still cannot.
///
///   xcrun simctl io booted recordVideo -f out.mp4 &
///   xcrun simctl launch booted app.usepromptly.ios \
///     -snapshotPayoff YES -snapshotState 11 -motionProof YES
///
/// Never compiled into Release; no effect without the launch argument.
struct PayoffSnapshotHarnessView: View {
    private var state: Int { Int(UserDefaults.standard.string(forKey: "snapshotState") ?? "0") ?? 0 }

    /// SETTLED-STATE ASSERTION (2026-08-27). A mid-transition screenshot once
    /// passed as evidence: the flow was animating between two beats and every
    /// capture caught it in flight, which read as a layout bug that did not
    /// exist. Two mechanisms, so it cannot recur:
    ///   1. Animations are DISABLED for the whole harness — no transition can
    ///      be in flight when the shutter opens.
    ///   2. The harness prints `SNAPSHOT_SETTLED <state>` only after the view
    ///      has been on screen, unchanged, for two consecutive runloop
    ///      settles. The capture script MUST wait for that marker; a
    ///      screenshot taken without it is not evidence.
    @State private var settled = false
    static var motionProof: Bool { ProcessInfo.processInfo.arguments.contains("-motionProof") }

    /// Flags MUST be forced before any child view is constructed. A `.task`
    /// on the presented view races that view's OWN `.task` (which reads the
    /// flag to seed its state) — render-caught 2026-08-27: the two-page
    /// export gate proved out as the single-page gate because the flag was
    /// still false when PaywallView's task ran. init() is the only
    /// deterministic seam.
    /// Side effects run ONCE per process, not once per init.
    ///
    /// SwiftUI re-creates a View struct on every update, so `init` is not a
    /// lifecycle hook — it is a function called an unbounded number of times.
    /// Mutating global state there means every mutation schedules the update
    /// that calls it again. With `@Published` firing on equal assignments too,
    /// state 25 pinned the main thread hard enough for Sentry to file an app
    /// hang, and the harness correctly refused to screenshot a screen that
    /// never settled.
    private static var didApplyFlags = false

    init() {
        if Self.didApplyFlags { return }
        Self.didApplyFlags = true
        Self.applyFlags()
    }

    /// Re-assertable, because a one-shot at init is not enough.
    ///
    /// `OnboardingState` restores its flags from UserDefaults and from the
    /// server AFTER init, so a flag forced once at construction is overwritten
    /// a moment later and the screen renders in the wrong configuration —
    /// state 28 lost its credits lines exactly this way. It went unnoticed
    /// before only because `init` was being called in a loop, re-forcing the
    /// flag on every pass; fixing the loop exposed the race it was hiding.
    /// Every assignment underneath is guarded, so calling this again is free.
    @MainActor
    static func applyFlags() {
        let n = Int(UserDefaults.standard.string(forKey: "snapshotState") ?? "0") ?? 0
        let o = OnboardingState.shared
        switch n {
        case 25:
            // The capture must show suppression happening, not a hidden row.
            SubscriptionService.shared.debugSetMax(true)
            o.debugForceFlag("referral_progress")
        case 32, 33, 34:
            o.debugForceFlag("credits")
            o.debugSetCreditsAllowance(200)
        case 28, 29, 30:
            // Credits armed: the claims must switch to the real allowances —
            // Pro "20 videos a month", Max "5x the usage". Both derived from
            // CreditAllowance (200 / 1000), neither typed.
            o.debugForceFlag("credits")
            // Pro maps to 200 credits => 20 videos a month. Posed, because the
            // real source is a server field a simulator never receives.
            o.debugSetCreditsAllowance(200)
        case 6:  o.debugForceFlag("attribution_gate"); o.hasSeenAttributionGate = false
        case 7, 8, 11, 12, 15:
            o.debugForceFlag("onboarding_v2")
            // Render-caught 2026-08-27: setting v2Step from .task fought the
            // flow's own restoreV2() on appear, so the view animated between
            // two beats forever and every screenshot caught a frozen
            // mid-transition. Seed the PERSISTED key instead — restoreV2()
            // then restores exactly the beat under proof, with nothing to
            // fight.
            UserDefaults.standard.set(
                ["7": "videoType", "8": "attribution", "11": "audience",
                 "12": "videoType", "15": "reveal"][String(n)] ?? "audience",
                forKey: "onboarding_v2_step")
        case 21: break   // width proof needs no flag
        case 20: o.debugForceFlag("progress_ring")
        case 19: o.debugForceFlag("progress_ring")
        case 17: o.debugForceFlag("progress_ring")
        case 18: o.debugForceFlag("before_after")
        case 13:
            o.debugForceFlag("render_transparency")
            o.v2VideoType = "podcast"
        case 14:
            o.debugForceFlag("exportgate_two_page")
            o.debugForceFlag("exportgate_personalization")
            o.v2VideoType = "podcast"
        default: break
        }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch state {
            case 1: labeled("FAILURE — credit note + one-tap retry") { failureBubble }
            case 2: PaywallView(isPresented: .constant(true), reason: .manual)
            case 3: TrialWallView(context: .door, onPassed: {})
            case 4: PaywallView(isPresented: .constant(true), reason: .manual)
                .task { await autoInvokePurchase() }
            case 5: TrialWallView(context: .door, onPassed: {})
                .task { await autoInvokePurchase() }
            case 6: AttributionAskView(context: "attribution_gate", onDone: {})
                .task {
                    OnboardingState.shared.debugForceFlag("attribution_gate")
                    // Precondition: the ask is show-once; reset the seen flag so
                    // the standalone surface proves out on a reused proof sim.
                    OnboardingState.shared.hasSeenAttributionGate = false
                }
            case 7: OnboardingV2Flow()
                .task {
                    OnboardingState.shared.debugForceFlag("onboarding_v2")
                    // .task runs after the flow's onAppear/restoreV2, so this
                    // forced beat wins. The didSet fires its analytics event in
                    // the harness — same as OnboardingProofHarness behavior.
                }
            case 8: OnboardingV2Flow()
                .task {
                    OnboardingState.shared.debugForceFlag("onboarding_v2")
                }
            case 9: labeled("PUSH PRIMER — pure view (live = 360pt sheet)") {
                    PushPrimerView(onAccept: {}, onDecline: {})
                }
            case 10: labeled("PUSH PRIMER — LIVE FLOW (sheet expected ~0.9s after delivery)") {
                    Text("Waiting for a chat + delivered mock…")
                        .font(.system(size: 13))
                        .foregroundColor(.gray)
                }
                .task { await drivePrimerLiveFlow() }
            // Amendment 2026-08-27 states.
            case 11: OnboardingV2Flow()
                .task {
                    OnboardingState.shared.debugForceFlag("onboarding_v2")
                }
            case 12: OnboardingV2Flow()
                .task {
                    OnboardingState.shared.debugForceFlag("onboarding_v2")
                }
            case 15: OnboardingV2Flow()
                .task {
                    OnboardingState.shared.debugForceFlag("onboarding_v2")
                }
            case 21: WidthProofView()
            case 20: RingThreadView()
            case 19: RingStillView()
            case 17: labeled("RENDER RING — live ramp, cold through completion") {
                    RingMotionDriver()
                }
            case 13: labeled("RENDER TRANSPARENCY — survey-personalised header over the live stage feed") {
                    MessageBubble(message: Self.renderingMock)
                }
                .task {
                    OnboardingState.shared.debugForceFlag("render_transparency")
                    OnboardingState.shared.v2VideoType = "podcast"
                }
            case 14: PaywallView(isPresented: .constant(true), reason: .exportGate,
                                 exportContextOverride: Self.exportCtxMock)
                .task {
                    OnboardingState.shared.debugForceFlag("exportgate_two_page")
                    OnboardingState.shared.debugForceFlag("exportgate_personalization")
                    OnboardingState.shared.v2VideoType = "podcast"
                }
            case 32: bleed("CREDITS TOP-UP — packs POSED (SKUs not created yet)") {
                // Prices posed. The real screen reads them from StoreKit and
                // shows an honest empty state until the SKUs exist.
                CreditsTopUpView(posedPacks: [
                    CreditPack(id: "promptly_credits_5",  videos: 5,  price: "$9.99"),
                    CreditPack(id: "promptly_credits_10", videos: 10, price: "$19.99"),
                    CreditPack(id: "promptly_credits_20", videos: 20, price: "$39.99"),
                ])
            }
            case 33: bleed("CREDITS TOP-UP — 20-pack selected, Max upsell") {
                CreditsTopUpView(posedPacks: [
                    CreditPack(id: "promptly_credits_5",  videos: 5,  price: "$9.99"),
                    CreditPack(id: "promptly_credits_10", videos: 10, price: "$19.99"),
                    CreditPack(id: "promptly_credits_20", videos: 20, price: "$39.99"),
                ], preselectLargest: true)
            }
            case 31: bleed("UpgradePaywall — the REAL switch, flag as shipped") {
                // NOT TwoStepPaywall directly. This renders the switch every
                // entry point goes through, with no flag forced, so what appears
                // is what a user tapping Upgrade gets. Rendering the two-step
                // view here would prove only that the view exists.
                UpgradePaywall(isPresented: .constant(true), reason: .manual)
            }
            case 22: bleed("step one — credits dark") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,)
            }
            case 23: bleed("Max selected") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,)
            }
            case 24: bleed("Pro selected") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,)
            }
            case 25: bleed("PRO selected, viewer holds MAX — no referral") {
                // showsReferral stays TRUE. The row must disappear on its own,
                // through ReferralService.shouldOffer, or the suppression is
                // not actually working — passing false here would prove
                // nothing except that false hides a row.
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,)
            }
            case 28: bleed("step one CREDITS ARMED") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,)
            }
            case 29: bleed("Max selected CREDITS ARMED") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,
                    
                    initialSelectionId: "promptly_pro_yearly")
            }
            case 34: bleed("MAX selected — title must follow the tier") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,
                    
                    initialSelectionId: "promptly_max_yearly")
            }
            case 30: FitProbe(label: "FIT step one CREDITS ARMED") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,)
            }
            case 26: FitProbe(label: "FIT step one") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,)
            }
            case 27: FitProbe(label: "FIT with a duration selected") {
                PaywallLayout(
                    title: String(localized: "Unlock Promptly Pro"),
                    tiers: HarnessPaywallMock.tiers,
                    durations: { HarnessPaywallMock.durations($0) },
                    sharedFeatures: HarnessPaywallMock.shared,
                    maxFeatures: HarnessPaywallMock.maxLines,
                    
                    initialSelectionId: "promptly_pro_yearly")
            }
            case 16: OnboardingQuestionView(question: .audienceV2,
                                            progress: (1, 3), onSkip: {}) { _ in }
            default: labeled("§6 RESULT — video · post package · Share hero") { resultBubble }
            }
        }
        .preferredColorScheme(.dark)
        // (1) nothing can be in flight — EXCEPT under -motionProof, whose
        // whole purpose is to record the motion this assertion suppresses.
        .transaction { if !Self.motionProof { $0.animation = nil } }
        .task {
            // (2) two settles: one for the initial layout, one to prove the
            // view did not re-enter an animation (the step-fight symptom).
            if !Self.motionProof { UIView.setAnimationsEnabled(false) }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 400_000_000)
            await Task.yield()
            // Re-assert after OnboardingState's own restore has had a chance to
            // run, so the capture shows the configuration that was asked for.
            Self.applyFlags()
            try? await Task.sleep(nanoseconds: 400_000_000)
            settled = true
            print("SNAPSHOT_SETTLED \(state)")
        }
    }

    /// Sandbox purchase E2E (pre-submit check, 2026-08-26): waits for offerings,
    /// then drives SubscriptionService.purchase on the computed default
    /// selection — the same call the CTA makes — so a screenshot captures
    /// whatever Apple's sandbox does next (sheet / sign-in / error alert).
    /// Proves the purchase path is wired end-to-end from BOTH surfaces.
    private func autoInvokePurchase() async {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        let sub = SubscriptionService.shared
        let pkgs = SubscriptionService.sortedByDuration(
            sub.offerings?.current?.availablePackages ?? [])
        guard let pkg = PlanSavings.defaultSelection(in: pkgs) else {
            print("[snapshotE2E] NO PACKAGES — offerings empty")
            return
        }
        print("[snapshotE2E] invoking purchase: \(pkg.identifier)")
        let ok = await sub.purchase(pkg)
        print("[snapshotE2E] purchase returned ok=\(ok) err=\(sub.lastError ?? "nil")")
    }

    /// Push-primer LIVE-FLOW proof (state 10): arms the push_primer flag,
    /// clears the once-per-install claims, then lands a NEWLY-delivered mock
    /// through ChatStore.scheduleSave — the single persist choke point every
    /// real completion sink (SSE finish, cache-then-flip, reconcile,
    /// updateStoredMessage) routes through. A fresh message id can never be in
    /// the prior delivered snapshot, so the primer trigger fires regardless of
    /// the chat's history. The sheet presents via PushPrimerPresenter (UIKit,
    /// top VC) ~0.9s later — visible above this harness overlay — provided the
    /// sim's notification permission is still notDetermined.
    private func drivePrimerLiveFlow() async {
        OnboardingState.shared.debugForceFlag("push_primer")
        let d = UserDefaults.standard
        d.removeObject(forKey: "promptly.pushService.didOfferDeliveryPrimer")
        d.removeObject(forKey: "promptly.pushService.didOfferSoftPrompt")
        d.removeObject(forKey: "promptly.pushService.didAskForPermission")
        // The chat list loads after auth; give it up to ~8s on a cold launch.
        for _ in 0..<40 where ChatStore.shared.chats.isEmpty {
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
        guard let chat = ChatStore.shared.chats.first else {
            print("[snapshotPrimer] NO CHATS — sign in on this sim (with ≥1 chat) first")
            return
        }
        var msgs = chat.messages
        msgs.append(SerializedMessage(from: Self.completedMock))
        ChatStore.shared.scheduleSave(chatId: chat.id, messages: msgs)
        print("[snapshotPrimer] delivered mock appended to chat \(chat.id) — sheet expected ~0.9s (OS permission must be notDetermined)")
    }

    /// Full-bleed: the surface exactly as it ships, with a caption OVERLAID so
    /// the capture is self-identifying without changing a single point of the
    /// layout being reviewed.
    @ViewBuilder
    private func bleed<V: View>(_ caption: String, @ViewBuilder _ content: @escaping () -> V) -> some View {
        // WIDTH MUST BE CONSTRAINED, and this is not cosmetic. Handed an
        // unbounded width proposal, `frame(maxWidth: .infinity)` resolves to the
        // content's IDEAL width — so with credits armed, "Early access to new
        // features" preferred one line, the cards grew past 375pt, and the
        // capture showed a paywall running off both edges. Nothing was wrong
        // with the paywall: a sheet or full-screen cover always proposes the
        // screen width. A harness that proposes something else is testing a
        // layout the app never renders, and the resulting screenshot is a bug
        // report about the harness.
        GeometryReader { geo in
            content()
                .frame(width: geo.size.width, height: geo.size.height)
                // NO CAPTION IN THE FRAME. The grey state label read as part of
                // the product — it was reported as "the grey subtitle above the
                // cards" and asked to be removed. A review capture must contain
                // shipping pixels and nothing else; the state is identified by
                // the filename instead.
                .onAppear { print("SNAPSHOT_CAPTION \(caption)") }
        }
        .ignoresSafeArea(.container, edges: .bottom)
    }

    private func labeled<V: View>(_ title: String, @ViewBuilder _ content: () -> V) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.gray)
                content()
                Spacer(minLength: 40)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var resultBubble: some View { MessageBubble(message: Self.completedMock) }
    private var failureBubble: some View {
        MessageBubble(message: Self.failedMock, onRetry: {}, onMakeAnother: {})
    }

    /// Amendment 2026-08-27 mocks: an in-flight render (stage feed alive) and
    /// an export-gate context carrying a thumbnail.
    static var renderingMock: ChatMessage {
        var m = ChatMessage(role: .assistant, content: "")
        m.jobId = "snapshot-rendering"
        m.jobStatus = "processing"
        m.jobProgress = 42
        m.originalVibe = "podcast clips, best moments, fast cuts, high energy"
        m.stepMessage = "Timing cuts to the beat"
        let t = StageTimeline(mode: "full", startWith: "analyze")
        t.receive(stepToken: "render")
        m.stageTimeline = t
        return m
    }

    /// WIDTH PROOF — a conversion surface rendered at an exact point width.
    ///
    /// WHY WIDTH RATHER THAN ROTATION. The question the iPad caps answer is "does
    /// this layout hold at width W". `simctl` exposes no rotation API, and the
    /// GUI-scripting route needs accessibility permissions this environment does
    /// not have — so rotating the device is not available here. Constraining the
    /// container IS available, and it tests the thing the caps actually govern.
    ///
    /// HONEST LIMIT: this proves layout-at-width. It does NOT prove
    /// orientation-specific behaviour — safe-area insets differ in landscape,
    /// and a real Split View also changes the size class. Treat a pass here as
    /// necessary and not sufficient.
    ///
    ///   -snapshotState 21 -widthPt 507
    ///     320  Slide Over, the narrowest real container
    ///     507  Split View 1/2 on an 11-inch
    ///    1024  iPad portrait
    ///    1366  iPad landscape, 12.9-inch
    struct WidthProofView: View {
        private var w: CGFloat {
            CGFloat(Int(UserDefaults.standard.string(forKey: "widthPt") ?? "1024") ?? 1024)
        }
        var body: some View {
            HStack(spacing: 0) {
                PaywallView(isPresented: .constant(true), reason: .manual)
                    .frame(width: w)
                    // A hard edge so the capture shows where the container ends
                    // and the dead space begins — without it a centred column
                    // and a stretched one look alike in a screenshot.
                    .overlay(alignment: .trailing) {
                        Rectangle().fill(Color.red.opacity(0.5)).frame(width: 2)
                    }
                Spacer(minLength: 0)
            }
        }
    }

    /// RENDER RING — IN THE THREAD.
    ///
    /// The stepped stills rendered the bubble alone on black, which is a fair
    /// test of the composition and a useless test of the only question that
    /// matters next: does it read as a MESSAGE. Alone on a screen, anything
    /// reads as a screen.
    ///
    /// So this puts it where it lives — a real user bubble above it, a real
    /// MessageBubble rendering the ring, the conversation scrollable, and the
    /// composer's own bottom edge underneath. Same views the app uses; only the
    /// data is mock.
    ///
    /// HONEST LIMIT: the bar at the bottom is a stand-in for the composer, not
    /// EditorView's own `inputBar` (which is private to a view that needs auth,
    /// a chat store and a live session to construct). It establishes the bottom
    /// edge and the sense of a conversation continuing below; it is not a proof
    /// of the composer itself.
    struct RingThreadView: View {
        private var pct: Int { Int(UserDefaults.standard.string(forKey: "ringProgress") ?? "45") ?? 45 }

        private var userMsg: ChatMessage {
            var m = ChatMessage(role: .user, content: "make this punchy with big captions")
            return m
        }

        var body: some View {
            VStack(spacing: 0) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        MessageBubble(message: userMsg)
                        RingStillView()
                        Color.clear.frame(height: 8)
                    }
                    .padding(.horizontal, 16)
                    .padding(.top, 24)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                // The composer's bottom edge — enough to show the thread is a
                // conversation with somewhere to type, not a full-screen state.
                HStack(spacing: 10) {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundColor(.white.opacity(0.5))
                    Text("Reply to Promptly")
                        .font(.system(size: 16))
                        .foregroundColor(.white.opacity(0.35))
                    Spacer()
                    Image(systemName: "mic")
                        .font(.system(size: 16))
                        .foregroundColor(.white.opacity(0.5))
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .background(
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                )
                .padding(.horizontal, 12)
                .padding(.bottom, 10)
            }
        }
    }

    /// RENDER RING — STEPPED STILLS.
    ///
    /// The live-ramp driver (state 17) cannot be video-recorded: `simctl io
    /// recordVideo` starves the app's Swift concurrency timers, so the stage
    /// feed stalls and the ring — correctly — holds. Measured: 180s of
    /// recording produced ZERO driver ticks, while the identical run without
    /// recording ticked on schedule.
    ///
    /// Stills sidestep it entirely, and they can show the real arc because
    /// `TrickleProgress.rehydrate(to:)` snaps `displayed` UP to the polled value
    /// plus its allowed lead on appear. So a view constructed at progress N
    /// paints at N immediately, with no waiting and no timers to starve. Each
    /// still is the REAL ring at a real value — not a mock of one.
    ///
    ///   -snapshotState 19 -ringProgress 45
    struct RingStillView: View {
        private var pct: Int { Int(UserDefaults.standard.string(forKey: "ringProgress") ?? "0") ?? 0 }
        private static let stageForPct: [(Int, String)] = [
            (0, "upload_local"), (15, "analyze"), (30, "transcribe"), (45, "shots"),
            (60, "render"), (75, "captions"), (90, "encode"), (99, "upload"),
        ]
        var body: some View {
            let p = pct
            var m = ChatMessage(role: .assistant, content: "")
            m.jobId = "ring-still-\(p)"
            m.jobStatus = p >= 100 ? "completed" : "processing"
            m.jobProgress = p
            m.originalVibe = "podcast clips, best moments, fast cuts, high energy"
            let t = StageTimeline(mode: "full", startWith: "upload_local")
            for (threshold, token) in Self.stageForPct where p >= threshold {
                t.receive(stepToken: token)
            }
            m.stageTimeline = t
            m.isFinishing = p >= 99
            m.videoAttachment = VideoAttachment(
                localUrl: URL(string: "file:///dev/null")!,
                fileName: "source.mov",
                thumbnail: RingMotionDriver.syntheticFrame()
            )
            return MessageBubble(message: m)
        }
    }

    /// RENDER RING — a LIVE run, not a posed frame.
    ///
    /// State 13 already shows a rendering bubble, but its timeline is frozen at
    /// one token and 42%, which is a still. The ring's entire point is the
    /// TrickleProgress ramp — a self-driving continuous climb that never mirrors
    /// backend percentages and never parks at 99%. A static capture cannot
    /// evidence any of that; it can only show that a circle exists.
    ///
    /// So this drives the real thing: a fresh StageTimeline fed real stage
    /// tokens on a timer, from cold through the finishing beat to completion,
    /// against the real RenderProgressRing. If the ramp stalls, jumps backwards,
    /// or sticks at 99, this recording shows it.
    struct RingMotionDriver: View {
        @State private var msg: ChatMessage = {
            var m = ChatMessage(role: .assistant, content: "")
            m.jobId = "ring-motion"
            m.jobStatus = "processing"
            m.jobProgress = 0
            m.originalVibe = "podcast clips, best moments, fast cuts, high energy"
            m.stageTimeline = StageTimeline(mode: "full", startWith: "upload_local")
            // THE RING IS A FRAME, NOT A CIRCLE. Its centre holds the source
            // clip's own thumbnail — that is the whole idea, the user watching
            // their own footage being worked on. The first recording of this
            // had no attachment, so it captured a hollow ring and would have
            // been reviewed as a hollow ring. A synthetic frame is enough to
            // prove the composition.
            m.videoAttachment = VideoAttachment(
                localUrl: URL(string: "file:///dev/null")!,
                fileName: "source.mov",
                thumbnail: Self.syntheticFrame()
            )
            return m
        }()
        @State private var step = 0
        nonisolated(unsafe) static var renders = 0

        /// A recognisable stand-in frame. Not a real clip — this is a pacing
        /// and composition proof, and shipping a real user's footage into a
        /// review artifact would be worse than a gradient.
        static func syntheticFrame() -> UIImage {
            let size = CGSize(width: 240, height: 426)   // 9:16
            return UIGraphicsImageRenderer(size: size).image { ctx in
                let cg = ctx.cgContext
                let colors = [UIColor(red: 0.16, green: 0.14, blue: 0.28, alpha: 1).cgColor,
                              UIColor(red: 0.55, green: 0.32, blue: 0.24, alpha: 1).cgColor]
                if let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(),
                                      colors: colors as CFArray, locations: [0, 1]) {
                    cg.drawLinearGradient(g, start: .zero,
                                          end: CGPoint(x: size.width, y: size.height), options: [])
                }
                UIColor.white.withAlphaComponent(0.9).setFill()
                UIBezierPath(ovalIn: CGRect(x: size.width/2 - 26, y: size.height/2 - 26,
                                            width: 52, height: 52)).fill()
            }
        }

        // The authoritative "full" pipeline, in order.
        private let tokens = ["analyze", "transcribe", "face_detect", "shots", "trend",
                              "plan", "broll_search", "render", "timing", "captions",
                              "sfx", "transitions", "encode", "thumbnail", "upload"]

        var body: some View {
            let _ = { RingMotionDriver.renders += 1; print("RING_BODY render#\(RingMotionDriver.renders) progress=\(msg.jobProgress ?? -1)") }()
            MessageBubble(message: msg)
                .task {
                    // REAL PACING, NOT A SPED-UP FAKE. TricklePacing fills to
                    // scheduledCap (90) over estimateSeconds (390 = 6.5 min),
                    // and the backend value is only a CEILING tether — the bar
                    // never marches ahead of the clock no matter what progress
                    // arrives. That is the anti-lie design working, and it means
                    // a 20-second capture shows a ~5% arc that looks frozen.
                    //
                    // The first recording made exactly that mistake and read as
                    // "the ring is stuck". So this runs at honest wall-clock and
                    // the CAPTURE is time-lapsed instead. Speeding up the video
                    // is truthful; speeding up the pacing would be proving a
                    // ring we do not ship.
                    let t0 = Date()
                    print("RING_DRIVE_START")
                    for (i, token) in tokens.enumerated() {
                        // SHORT SLEEPS, SUMMED — measured, not guessed. A single
                        // 11s Task.sleep does not fire on schedule in the
                        // simulator: instrumented across 42s at 11s pacing the
                        // loop produced ZERO ticks and ZERO cancellations, while
                        // the same driver at 750ms ticked normally. Long sleeps
                        // get coalesced hard once the app goes idle.
                        //
                        // WHAT THAT PRODUCED IS WORTH RECORDING, because it
                        // looked exactly like a product bug: the stage feed
                        // stalled at seed, so the ring never received progress
                        // past 0, so the bar parked at overshootMargin (12) and
                        // sat there. That was the anti-lie tether doing its job —
                        // refusing to march forward on a feed that had stopped.
                        // A ring that had swept on to 40% would have been the
                        // real defect. The harness was lying, not the ring.
                        for _ in 0..<44 {
                            do { try await Task.sleep(for: .milliseconds(250)) }
                            catch { print("RING_DRIVE_CANCELLED at i=\(i) t=\(Int(Date().timeIntervalSince(t0)))s"); return }
                        }
                        print("RING_DRIVE_TICK i=\(i) token=\(token) t=\(Int(Date().timeIntervalSince(t0)))s")
                        msg.stageTimeline?.receive(stepToken: token)
                        // Deliberately NOT a linear sweep to 100. The backend
                        // feed is lumpy and the ring is supposed to absorb that
                        // into a smooth climb — a linear driver here would hide
                        // the exact behaviour under review.
                        msg.jobProgress = min(96, Int(Double(i + 1) / Double(tokens.count) * 110))
                        step = i
                    }
                    try? await Task.sleep(for: .milliseconds(2_000))
                    msg.isFinishing = true          // the finishing beat: ring may pass 99
                    try? await Task.sleep(for: .milliseconds(3_000))
                    // Completion must come through jobStatus, because that is
                    // what makes the ring call trickle.complete() and release
                    // the 99 hard cap. Setting jobProgress alone would leave it
                    // capped and capture the exact "stuck at 99" defect the ring
                    // was built to eliminate — proving the bug instead of the fix.
                    msg.jobStatus = "completed"
                    msg.jobProgress = 100
                    print("RING_MOTION_COMPLETE")   // capture script's stop marker
                }
        }
    }

    static var exportCtxMock: ExportGatePaywallContext {
        ExportGatePaywallContext(thumbnailUrl: "https://cdn.usepromptly.app/demo.jpg",
                                 sourceDuration: 92, renderDuration: 34)
    }

    static var completedMock: ChatMessage {
        var m = ChatMessage(role: .assistant, content: "Here's your edit — captioned and paced for the scroll.")
        m.jobId = "snapshot-demo"
        m.jobStatus = "completed"
        // A non-amazonaws/supabase host reads as CDN-ready (isStreamingReadyUrl),
        // so the video tile + Share hero render at full opacity, not dimmed.
        m.renderedVideoUrl = "https://cdn.usepromptly.app/demo.mp4"
        m.thumbnailUrl = "https://cdn.usepromptly.app/demo.jpg"
        m.originalVibe = "clean and engaging"
        m.postPackage = PostPackage(
            editRationale: "I tightened the intro and held on your reveal at 0:14 so the punchline lands. For a fuller edit — more B-roll and zooms — a slightly longer take gives me more to work with.",
            postCaption: "Behind every launch is a spreadsheet nobody saw #startup #buildinpublic",
            postHook: "Nobody talks about the spreadsheet."
        )
        return m
    }

    static var failedMock: ChatMessage {
        var m = ChatMessage(role: .assistant, content: "")
        m.jobId = "snapshot-fail"
        m.jobStatus = "failed"
        m.error = "That render didn't finish. Give it another go."
        m.isRetryable = true
        m.cachedSourceUrl = "https://cdn.usepromptly.app/source.mp4"
        m.cachedVibe = "clean and engaging"
        return m
    }
}

/// Measures whether a screen actually FITS, instead of leaving it to the eye.
///
/// The requirement on the two-step paywall is "fits without scrolling on the
/// smallest supported iPhone" — and a screenshot cannot prove that. A view that
/// overflows its container still renders a perfectly plausible-looking still:
/// SwiftUI clips it, and the clipped part is exactly the part not in the
/// picture. Reviewing the capture would confirm the layout every time it failed.
///
/// MEASURING THE IDEAL HEIGHT, NOT THE LAID-OUT ONE. This is the trap: read the
/// content's geometry after normal layout and you get the container height back,
/// because the container is what constrained it — the probe then prints PASS for
/// every input, including a view twice too tall. `.fixedSize(vertical: true)`
/// makes the content take the height it actually WANTS, ignoring the proposal,
/// and that number is the one worth comparing. Spacers collapse to their
/// `minLength` under fixedSize, so what is measured is the MINIMUM the screen
/// can occupy: if that exceeds the safe area, it must scroll, and no amount of
/// squeezing elsewhere will save it.
private struct FitProbe<Content: View>: View {
    let label: String
    @ViewBuilder var content: () -> Content
    /// Every distinct height, not just the first. The first layout pass is not
    /// necessarily the screen under test — a probe that latches on `onAppear`
    /// reports whatever rendered before the state settled, which on step two
    /// was step one, empty, passing comfortably. Print each change and read the
    /// last line.
    @State private var last: CGFloat = -1

    private func report(_ need: CGFloat, _ have: CGFloat) {
        guard abs(need - last) > 0.5 else { return }
        last = need
        let verdict = need <= have + 0.5 ? "PASS" : "FAIL"
        print(String(format: "TWOSTEP_FIT %@ | need=%.1f have=%.1f overflow=%.1f %@",
                     label, need, have, max(0, need - have), verdict))
    }

    var body: some View {
        GeometryReader { geo in
            let have = geo.size.height
            content()
                .frame(width: geo.size.width)
                .fixedSize(horizontal: false, vertical: true)
                .background(
                    GeometryReader { inner in
                        Color.clear
                            .onAppear { report(inner.size.height, have) }
                            .onChange(of: inner.size.height) { _, h in report(h, have) }
                    }
                )
                .frame(height: have, alignment: .top)
                .clipped()
                // The container's true bottom edge. If content crosses it in
                // the still, the still shows the failure too.
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Color.red.opacity(0.9)).frame(height: 1)
                }
        }
    }
}

/// The LIVE products, run through the REAL mapping.
///
/// These are the five product ids in RevenueCat's `default` offering and their
/// actual App Store Connect prices for the US storefront, read from the API on
/// 2026-09-01 — not invented numbers. They are fed through `PaywallMapping`,
/// the same code the shipping paywall calls, so what a capture shows is the
/// real derivation: which tier a product belongs to, which tier is Max, what
/// each card quotes, the saving percentage, and the per-month restatement.
///
/// WHY THIS EXISTS AT ALL. `Package` cannot be constructed, and StoreKit
/// Testing only applies inside an Xcode debug session — not to a `simctl
/// launch`. So a simulator capture of the store-wired view is a capture of an
/// empty screen. This is the closest honest thing: real ids, real prices, real
/// mapping, and only RevenueCat's own object stubbed out.
private enum HarnessPaywallMock {
    /// US storefront, from App Store Connect (2026-09-01).
    static let products: [PaywallProduct] = [
        PaywallProduct(id: "promptly_pro_weekly",  localizedPrice: "$10.99",
                       localizedPricePerMonth: nil, price: 10.99,
                       currencyLocale: Locale(identifier: "en_US"), unit: .week, introLine: nil),
        PaywallProduct(id: "promptly_pro_monthly", localizedPrice: "$29.99",
                       localizedPricePerMonth: nil, price: 29.99,
                       currencyLocale: Locale(identifier: "en_US"), unit: .month, introLine: nil),
        PaywallProduct(id: "promptly_pro_yearly",  localizedPrice: "$289.99",
                       localizedPricePerMonth: nil, price: 289.99,
                       currencyLocale: Locale(identifier: "en_US"), unit: .year, introLine: nil),
        PaywallProduct(id: "promptly_max_monthly", localizedPrice: "$89.99",
                       localizedPricePerMonth: nil, price: 89.99,
                       currencyLocale: Locale(identifier: "en_US"), unit: .month, introLine: nil),
        PaywallProduct(id: "promptly_max_yearly",  localizedPrice: "$799.99",
                       localizedPricePerMonth: nil, price: 799.99,
                       currencyLocale: Locale(identifier: "en_US"), unit: .year, introLine: nil),
    ]

    /// The shared list, from the same mapping the app uses.
    @MainActor
    static var maxLines: [String] {
        PaywallMapping.maxFeatures(products,
                                   creditsEnabled: OnboardingState.shared.creditsEnabled)
    }

    @MainActor
    static var shared: [String] {
        PaywallMapping.sharedFeatures(products,
                                      creditsEnabled: OnboardingState.shared.creditsEnabled)
    }

    @MainActor
    static var tiers: [PaywallTierOption] {
        PaywallMapping.tierOptions(products,
                                   creditsEnabled: OnboardingState.shared.creditsEnabled)
    }

    static func durations(_ allowance: Int) -> [PaywallDurationOption] {
        PaywallMapping.durationOptions(products, allowance: allowance)
    }
}

#endif
