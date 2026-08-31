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
    init() {
        let n = Int(UserDefaults.standard.string(forKey: "snapshotState") ?? "0") ?? 0
        let o = OnboardingState.shared
        switch n {
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
                    for (i, token) in tokens.enumerated() {
                        try? await Task.sleep(for: .milliseconds(11_000))
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
#endif
