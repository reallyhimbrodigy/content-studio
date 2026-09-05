import SwiftUI
import UIKit
import Sentry
import PostHog
import UserNotifications
#if DEBUG
import AVFoundation
#endif

final class PromptlyAppDelegate: NSObject, UIApplicationDelegate {

    /// iOS calls this when the OS finishes a background URLSession's
    /// pending events. We stash the completion handler on the
    /// BackgroundUploadManager and call it back from the session's
    /// `urlSessionDidFinishEvents(forBackgroundURLSession:)` so iOS
    /// knows it can suspend us again.
    func application(
        _ application: UIApplication,
        handleEventsForBackgroundURLSession identifier: String,
        completionHandler: @escaping () -> Void
    ) {
        // Touching the singleton instantiates its background URLSession
        // with the matching identifier, which lets iOS deliver the
        // queued delegate callbacks for tasks that completed while we
        // were terminated. Route by identifier — the single-PUT and the
        // 226 multipart sessions are distinct and each drains its own events.
        Task { @MainActor in
            if identifier == ResumableMultipartUploader.shared.sessionIdentifier {
                ResumableMultipartUploader.shared.savedCompletionHandler = completionHandler
            } else {
                BackgroundUploadManager.shared.savedCompletionHandler = completionHandler
            }
        }
    }

    /// APNs delivered a fresh device token. iOS rotates these periodically,
    /// so registering on every launch keeps the server in sync.
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            PushService.shared.setDeviceToken(deviceToken)
        }
    }

    /// APNs registration failed. Most common cause is missing entitlements
    /// or no internet — log and move on, the next launch will retry.
    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        print("[Push] APNs registration failed: \(error.localizedDescription)")
    }

    /// Silent push (content-available) handler. iOS calls this when a
    /// background-priority push arrives — including when the app is
    /// suspended or fully terminated, in which case iOS launches the
    /// app for up to 30 seconds to do the work.
    ///
    /// We use this to pre-warm the local video cache the moment a render
    /// finishes, so by the time the user taps the alert push the file
    /// is already on disk and playback is Photos-app instant.
    ///
    /// CRITICAL: must call completionHandler within ~30s or iOS kills
    /// the app and counts it against future background runtime budget.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        let type = userInfo["type"] as? String
        guard type == "render-complete-prefetch",
              let jobId = userInfo["jobId"] as? String,
              let videoUrl = userInfo["videoUrl"] as? String else {
            completionHandler(.noData)
            return
        }
        let hlsManifestUrl = userInfo["hlsManifestUrl"] as? String
        print("[Push] silent prefetch for jobId=\(jobId) hls=\(hlsManifestUrl ?? "-")")
        Task { @MainActor in
            // Warm the AVPlayer asset for whichever path we'll actually
            // play (HLS preferred when available). This loads the manifest
            // / moov atom up front so the next tap is sub-100ms even when
            // the app was terminated and just woke for this push.
            if let hlsManifestUrl, !hlsManifestUrl.isEmpty {
                PlayerAssetPrewarm.shared.warm(hlsManifestUrl)
            } else {
                PlayerAssetPrewarm.shared.warm(videoUrl)
            }

            // 25s budget — leave a few seconds of headroom under iOS's
            // 30s background runtime limit so we always get the
            // completion handler back to the OS.
            let result: UIBackgroundFetchResult = await withTaskGroup(of: UIBackgroundFetchResult.self) { group in
                group.addTask {
                    // MP4 still downloads to disk for offline replay; HLS
                    // segments are intentionally NOT cached (they stream
                    // adaptively, on-disk caching would defeat the bitrate
                    // ladder). VideoCache itself skips HLS URLs.
                    let url = await VideoCache.shared.downloadIfNeeded(jobId: jobId, from: videoUrl)
                    return url == nil ? .failed : .newData
                }
                group.addTask {
                    try? await Task.sleep(for: .seconds(25))
                    return .noData
                }
                let first = await group.next() ?? .noData
                group.cancelAll()
                return first
            }
            completionHandler(result)
        }
    }
}

/// Foreground-presentation behavior for incoming pushes. By default iOS
/// suppresses the banner when the app is in the foreground — we want it
/// to show like a normal notification (matches iMessage / ChatGPT).
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .list])
    }

    /// User tapped the notification. For render-complete pushes we resolve the
    /// job carried in the payload and present its finished video directly.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let type = userInfo["type"] as? String
        Task { @MainActor in
            // The Library was DELETED — a finished render lives permanently in its
            // own chat. The tap must land on the ACTUAL video, not just open the
            // app: resolve the payload's jobId and present the player (deferred past
            // the cold-launch window if the UI isn't up yet), so a re-tap no longer
            // dead-ends on the home surface. Falls back to the "Your video is ready"
            // banner refresh only when the push carries no jobId.
            if type == "render-complete" {
                if let jobId = userInfo["jobId"] as? String {
                    ReadyStateStore.shared.requestOpenJob(jobId)
                } else {
                    await ReadyStateStore.shared.refresh()
                }
            }
            completionHandler()
        }
    }
}

@main
struct PromptlyApp: App {
    @State private var auth = AuthService.shared
    /// Needed by the paywall/funnel guards: an existing subscriber must never
    /// be shown either surface.
    @ObservedObject private var subscription = SubscriptionService.shared
    @UIApplicationDelegateAdaptor(PromptlyAppDelegate.self) private var appDelegate

    init() {
        #if DEBUG
        // Harness state is applied in the APP's init, before any view exists.
        // Applied in the root `.task` it raced the child tasks that read it —
        // CreditBadge's own `.task` had already run and cached a nil balance, so
        // the posed count surfaced in the composer strip but never in the
        // header. Same shape as the flag clobber: the value was right and the
        // timing was wrong.
        MainActor.assumeIsolated {
            let args = ProcessInfo.processInfo.arguments
            if let i = args.firstIndex(of: "-forceFlags"), i + 1 < args.count {
                for f in args[i + 1].split(separator: ",").map(String.init) {
                    OnboardingState.shared.debugForceFlag(f)
                }
            }
            if let i = args.firstIndex(of: "-poseCredits"), i + 1 < args.count,
               let n = Int(args[i + 1]) {
                CreditsService.shared.debugSetBalance(n)
            }
        }
        #endif
        // Crash + error reporting. DSN comes from Info.plist (SENTRY_DSN).
        // If absent, init is skipped — no-op in dev or if the user hasn't
        // wired up a Sentry project yet.
        if let dsn = Bundle.main.object(forInfoDictionaryKey: "SENTRY_DSN") as? String,
           !dsn.isEmpty,
           dsn != "$(SENTRY_DSN)" {
            SentrySDK.start { options in
                options.dsn = dsn
                #if DEBUG
                options.environment = "debug"
                options.debug = true
                #else
                options.environment = "production"
                #endif
                let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
                let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
                options.releaseName = "promptly-ios@\(version)+\(build)"
                options.attachStacktrace = true
                // Crash + hang + watchdog tracking only. Sentry's network
                // and auto-performance swizzling can interfere with the
                // background URLSession used for video uploads — leave it
                // off until we have a controlled test confirming it's safe.
                options.enableAutoPerformanceTracing = false
                options.enableNetworkTracking = false
                // RULED 2026-08-22: the default-on failed-request capture
                // buried the real crashes under 307 issue-groups of URLSession
                // 5xx noise (presigned S3 URLs shatter grouping). The same
                // signal now flows through upload_http_error in OUR sink.
                options.enableCaptureFailedRequests = false
                options.enableUIViewControllerTracing = false
                options.enableAppHangTracking = true
                options.enableWatchdogTerminationTracking = true
            }
        }

        // Configure nav bar appearance
        let navAppearance = UINavigationBarAppearance()
        navAppearance.configureWithOpaqueBackground()
        navAppearance.backgroundColor = UIColor.systemBackground
        navAppearance.titleTextAttributes = [.foregroundColor: UIColor.white]
        UINavigationBar.appearance().standardAppearance = navAppearance
        UINavigationBar.appearance().scrollEdgeAppearance = navAppearance

        // Tab bar is custom (not SwiftUI TabView) — no UITabBarAppearance needed

        // Keyboard dismiss on scroll globally — native iOS behavior
        UIScrollView.appearance().keyboardDismissMode = .interactive

        // Foreground-presentation + tap-handling for APNs pushes. Set the
        // delegate before the first push arrives — iOS only delivers
        // callbacks if a delegate is set at the time of delivery.
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared

        // PostHog — analytics-only (capture-only public key; no feature flags or
        // experiments are read, and every [REPORT] reads the Supabase
        // analytics_events mirror, not PostHog). COST CUTS (2026-08-20, authorized):
        // the SDK defaults were never priced and a receipt caught them.
        //   • Session replay SAMPLED to 10% — was UNSAMPLED, recording ~every
        //     session (37k recordings ≈ 36.6k sessions) = the whole ~$280/mo line,
        //     against zero readers. 10% ≈ 3.7k/mo, ample if anyone ever looks.
        //   • Autocapture OFF (screen views + app lifecycle) — ~623k events/mo,
        //     $screen / $application_*, unread, absent from Supabase, 72% of
        //     ingestion and 62% of the free-tier headroom.
        // Explicit Analytics.track events (the ANALYSED set) are unaffected — they
        // still dual-sink to PostHog + Supabase. Takes effect on the adoption curve,
        // not immediately. screenshotMode + masking kept.
        let phConfig = PostHogConfig(
            apiKey: "phc_zqZcVguSoeCnasjfxH9W2PSiBna3rApecQvTQtnNeetj",
            host: "https://us.i.posthog.com"
        )
        phConfig.captureScreenViews = false
        phConfig.captureApplicationLifecycleEvents = false
        phConfig.sessionReplay = true
        phConfig.sessionReplayConfig.sampleRate = NSNumber(value: 0.1)
        phConfig.sessionReplayConfig.maskAllTextInputs = true
        phConfig.sessionReplayConfig.maskAllImages = true
        // SwiftUI renders as one layer to the replay wireframe recorder —
        // screenshot mode is the supported capture path for SwiftUI apps.
        phConfig.sessionReplayConfig.screenshotMode = true
        PostHogSDK.shared.setup(phConfig)
        // The funnel key, registered before the first event so no session is
        // ever missing it. Required before deferred auth arms: without it a
        // UUID-keyed funnel reads the pre-auth top of funnel as a collapse.
        Analytics.registerDeviceIdSuperProperty()

        // Boot RevenueCat. Pulls offerings + initial CustomerInfo so the
        // paywall has data ready the first time it's presented. Once the
        // Supabase user resolves below in `.task`, we call identify() to
        // alias their RC ID to the Supabase user.id — that's what the
        // webhook uses to write pro_until back to profiles.
        SubscriptionService.shared.bootstrap()
        // conn-capture fix (UNS audit 2026-08-24): the reachability singleton is
        // LAZY, and only JobDispatchCoordinator ever touched it — so the static
        // conn snapshot read at upload_failed emit time stayed "unknown" for
        // 15 of 18 enriched-failure users. Start the NWPathMonitor at launch so
        // the snapshot is always live before any upload can fail.
        _ = ReachabilityMonitor.shared
    }

    @StateObject private var appState = AppState.shared
    @StateObject private var onboarding = OnboardingState.shared
    @ObservedObject private var versionAware = VersionAwareness.shared

    /// RETENTION-funnel: app foreground lifecycle. Fires `session_started` on the
    /// first `.active` (cold launch) and on every real background→active resume —
    /// NOT on transient inactive↔active blips (Control Center, notification
    /// banners), which would inflate the count.
    @Environment(\.scenePhase) private var scenePhase
    @State private var didStartSession = false

    /// The 1.2.0 wall-onboarding branch, gated on the ONE knob (read pre-auth
    /// from /api/health — same knob as the server gates; flip once, both
    /// halves move). Knob off (default / fetch-failed) → today's branches,
    /// byte-for-byte. GRANDFATHER: an already-authenticated user who never
    /// entered the flow is not forced through a signup they've already done —
    /// the server's rollout policy governs when THEY meet the wall.

    /// Conversion item 1: the first-launch dismissible paywall — 100% paid-tier
    /// exposure before signup/onboarding, shown exactly once per install.
    /// Knob-gated (/api/health.first_launch_paywall, default OFF = dark).
    /// Authenticated users never see it (they're past first launch by
    /// definition — the grandfather rule the wall-onboarding branch also uses).
    #if DEBUG
    /// `-motionProof` records the ENTIRE sequence in one take — paywall,
    /// three questions, reveal — from a cold launch. Zac reviewed a take
    /// that began at question one and was missing its first screen and two
    /// of three questions; that is not a reviewable artifact. The override
    /// only relaxes the AUTH precondition (a proof sim is signed in); every
    /// other gate below still applies.
    var motionProof: Bool { ProcessInfo.processInfo.arguments.contains("-motionProof") }
    /// One take, every time: clear the show-once stamps so the recording
    /// always starts at screen one.
    ///
    /// FIXED 2026-08-28, and the bug is worth stating because it made the
    /// harness lie. This used to write ONLY to UserDefaults. But
    /// `OnboardingState.hasSeenFirstLaunchPaywall` is initialised FROM
    /// UserDefaults when the singleton is constructed, which happens before
    /// this runs — so after any previous run had completed the flow, the
    /// in-memory value was already `true`, the root branch skipped the paywall,
    /// and the recording silently started at question one. It looked like a
    /// clean take. The first proof run on a fresh simulator passed, every run
    /// after it quietly lost screen one, and nothing failed.
    ///
    /// So reset the LIVE state, not just the persisted copy. The defaults
    /// writes stay for the next cold launch; the in-memory assignments are what
    /// make THIS launch start at screen one.
    @MainActor
    static func motionProofReset() {
        let d = UserDefaults.standard
        d.set(false, forKey: "first_launch_paywall_seen")
        d.set(false, forKey: "onboarding_completed")
        d.set(false, forKey: "attribution_gate_seen")
        d.set("audience", forKey: "onboarding_v2_step")
        d.removeObject(forKey: OnboardingState.preselectedPlanKey)

        let s = OnboardingState.shared
        s.hasSeenFirstLaunchPaywall = false
        s.hasCompletedOnboarding = false
        s.preselectedPlanID = nil
        s.v2Step = .audience
    }
    #endif

    /// AFTER SIGNUP, not before (2026-08-30).
    ///
    /// This guard read `!auth.isAuthenticated` — the paywall showed ONLY to
    /// signed-out users, deliberately, as a deferred-auth design. A real-install
    /// trace showed the consequence: session_started → signup_start → the whole
    /// funnel → offer_reveal → onboarding_completed → signup_complete, with
    /// picker_opened the FIRST event carrying a user_id. The entire funnel and
    /// the paid offer ran inside the signup window, so every funnel event was
    /// anonymous and unjoinable, and any purchase taken there landed on an
    /// anonymous RevenueCat identity needing aliasing — the known
    /// no_profile_matched failure.
    ///
    /// Three things this fixes at once: funnel events carry a real user_id so
    /// the canonical join can attribute them; a purchase is made under an
    /// identified RC customer; and the order matches the standing ruling —
    /// onboarding after signup, ending at the picker.
    private var showFirstLaunchPaywall: Bool {
        #if DEBUG
        if motionProof { return !onboarding.hasSeenFirstLaunchPaywall }
        #endif
        // V2 OWNS FIRST LAUNCH, AND ITS FUNNEL HAS NO PAYWALL (2026-09-02).
        //
        // The stand-down was deleted with the `.paywall` beat, which put this
        // branch back in the running — and it sits ABOVE `showOnboardingV2` in
        // the chain while its own RevenueCat guard flips it TRUE about a second
        // after launch. So a new user began answering Q1 and was then yanked
        // onto the first-launch paywall the moment the receipt resolved: the
        // exact screen item 1 removes, arriving mid-question.
        //
        // The walk did not catch it because the beats advance faster than
        // RevenueCat answers; it only appears when a real person pauses on the
        // question, which is everyone.
        //
        // Not a re-litigation of item 1 — the funnel still sells nothing. This
        // says the ROOT may not present a paywall while v2 is the flow, which
        // is what "questions -> chat" means once the branch order is accounted
        // for. The legacy path (v2 off) is unchanged.
        guard !onboarding.onboardingV2Enabled else { return false }
        guard onboarding.firstLaunchPaywallEnabled == true,
              !onboarding.hasSeenFirstLaunchPaywall,
              // DEFERRED AUTH (flag): the funnel runs before sign-in again, and
              // "first run" is keyed on the KEYCHAIN so a reinstall does not
              // replay a paywall at someone who may already be paying.
              // UserDefaults would; it is erased with the app.
              (onboarding.deferredAuthEnabled ? !FirstRun.seen : auth.isAuthenticated),
              // NEVER to an existing subscriber. This guard became necessary
              // BECAUSE of the reordering above: while the surface was gated on
              // `!auth.isAuthenticated`, a signed-out user had no known Pro
              // status and the case could not arise. Requiring auth to fix
              // anonymous purchases opened it — a paying subscriber would be
              // sold what they already pay for, once per install. The fix for
              // one defect created the other, which is why the user-type matrix
              // exists rather than spot-checking the happy path.
              !subscription.isPro,
              // AND WAIT FOR REVENUECAT TO ANSWER (2026-09-02, deferred auth).
              //
              // `isPro` starts false and becomes true a moment after launch when
              // the receipt resolves. Under deferred auth the reinstall case is
              // covered by the Keychain, but a NEW DEVICE on the same Apple ID
              // has no Keychain entry and IS an existing subscriber — so
              // deciding while `isPro` is merely not-yet-known flashes a paywall
              // at someone who already pays. Decided, not accepted: the branch
              // waits for the first resolution rather than reading an unread
              // value. LaunchView is already on screen for its own 700ms, so the
              // wait is usually invisible; `resolveDeadlinePassed` bounds it at
              // 2s so a dead network cannot suppress the funnel forever.
              // countdown-ok: a bounded internal wait for RevenueCat's first
              // answer. Nothing counts down on screen and no time is shown to
              // the user; this only stops a paywall being decided on an unread
              // entitlement.
              (subscription.hasResolvedCustomerInfo || resolveDeadlinePassed)
        else { return false }
        return true
    }

    /// Conversion build (post-235) — ATTRIBUTION RESURRECTION. The question
    /// flow hangs off wall_enforcement, which is OFF and coupled to the server
    /// billing gates, so `onboarding_attribution` has fired ZERO times ever.
    /// This is the question with no flow around it: ONE skippable screen at
    /// the first-session moment (same population as the first-launch paywall —
    /// new installs, pre-auth; shown just BEFORE that wall so the two knobs
    /// coexist), at most once per install, never blocks the session.
    /// STANDS DOWN when onboarding_v2 is on (that flow CONTAINS the question)
    /// or when the wall flow is armed (its Q3 already asks it).
    /// Moved after signup with the rest of the sequence (2026-08-30). It stands
    /// down whenever v2 is armed — which is now always — so this is currently
    /// unreachable; inverting it anyway means the one path that could re-admit
    /// an anonymous funnel event cannot do so if v2 is ever turned off.
    /// RETIRED 2026-09-03 — the attribution question is gone from the product.
    ///
    /// It changed no pixel of the output, gated nothing, and was WRITE-ONLY:
    /// `persistAnswersToProfile` posted `attribution` into profile_settings and
    /// nothing on either side ever read it back. Verified rather than assumed —
    /// the server's only occurrence is the analytics allowlist, not a consumer.
    /// Two questions of friction for a field with no reader.
    ///
    /// The property stays (returning false) rather than the branch being cut
    /// from `body`: `attribution_gate` is still a live server flag and other
    /// code reads it, so retiring the SURFACE here keeps the knob honest
    /// instead of leaving a flag that appears armed and does nothing.

    /// Conversion build (post-235) — ONBOARDING V2: language → making →
    /// attribution → sign-in; ends at the picker, NO paywall in the flow.
    /// Same guard shape as the wall branch above, incl. the GRANDFATHER rule.
    /// PRECEDENCE: when on, v2 SUPERSEDES the standalone attribution gate
    /// V1 (`OnboardingFlow`) and the standalone attribution ask were DELETED
    /// 2026-09-04 — not left dark. Both were reachable only by flipping a
    /// server knob, which is a second funnel waiting for someone to flip it.
    private var showOnboardingV2: Bool {
        #if DEBUG
        if motionProof { return !onboarding.hasCompletedOnboarding }
        #endif
        // Same inversion as the paywall above: the flow runs AFTER signup so its
        // steps carry a user_id. The old `startedFlow` clause existed to let a
        // user who began pre-auth finish post-auth — with the sequence moved
        // wholly after signup there is no pre-auth beginning to carry over, and
        // keeping it would re-admit exactly the anonymous window being closed.
        guard onboarding.onboardingV2Enabled,
              !onboarding.hasCompletedOnboarding,
              (onboarding.deferredAuthEnabled ? !FirstRun.seen : auth.isAuthenticated),
              // Same reasoning as the paywall. The reveal already self-skips for
              // Pro users, but the three questions would still have run — an
              // existing subscriber walked through an upsell funnel.
              !subscription.isPro else { return false }
        return true
    }

    /// LaunchView must remain on screen long enough for its entrance
    /// animation to complete and the brand moment to register. Without
    /// this gate, a fast auth.checkSession() resolve (~300ms on a warm
    /// device) would cut to AppShell while the logo is still mid-zoom
    /// — the user would see a half-formed mark snap away. 700ms is the
    /// floor: ~280ms entrance + ~420ms of idle "the runner is alive"
    /// before any handoff is allowed.
    @State private var launchMinElapsed = false

    /// Bounds the wait for RevenueCat's first answer. Without a deadline a
    /// device that cannot reach RevenueCat would never see the first-run funnel
    /// at all — trading a brief flash for a permanent disappearance.
    // countdown-ok: internal timeout flag, never rendered.
    @State private var resolveDeadlinePassed = false

    #if DEBUG
    /// `-forceFlags a,b` — turn server flags on locally so the REAL app path can
    /// be exercised, rather than a harness rendering a view in isolation. The
    /// difference matters for deferred auth: the question is not what AppShell
    /// looks like, it is what the SERVICES do when nothing is signed in, and
    /// only the real root reaches them.
    private static var forcedFlags: [String] {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-forceFlags"), i + 1 < args.count else { return [] }
        return args[i + 1].split(separator: ",").map(String.init)
    }
    #endif

    var body: some Scene {
        WindowGroup {
            ZStack {
                if auth.isLoading || !launchMinElapsed {
                    LaunchView()
                        .transition(.opacity.combined(with: .scale(scale: 1.04)))
                } else if versionAware.updateRequired {
                    // FORCED update (broken-build emergency only): its own
                    // server flag, default off; bundle below the supported
                    // floor. Non-dismissible by design.
                    UpdateRequiredView()
                        .transition(.opacity)
                } else if showFirstLaunchPaywall {
                    FirstLaunchPaywallView()
                        .transition(.opacity)
                } else if showOnboardingV2 {
                    OnboardingV2Flow()
                        .transition(.opacity)
                } else if auth.isAuthenticated || onboarding.deferredAuthEnabled {
                    // Deferred auth: browsing needs no account. The account is
                    // asked for at the first action that requires one, through
                    // AuthGate, which remembers the action and resumes it.
                    AppShell()
                        .transition(.opacity)
                } else {
                    AuthView()
                        .transition(.opacity)
                        .onAppear { Analytics.track("signup_start", props: ["step": "auth_shown"]) }
                }

                #if DEBUG
                // Snapshot harness (presentations-proven-by-presentations): when
                // launched with -snapshotPayoff, cover the app with the real §6 /
                // paywall views on mock data for an external screenshot capture.
                if ProcessInfo.processInfo.arguments.contains("-snapshotPayoff") {
                    PayoffSnapshotHarnessView()
                }
                #endif
            }
            // k, once, for the whole window. See RootScale.
            .modifier(RootScale())
            #if DEBUG
            .onAppear {
                ReeditProofHarness.runIfRequested()
                FirstRunProofHarness.runIfRequested()
            }
            #endif
            // Spring-driven crossfade between launch ↔ authed ↔ unauthed
            // roots. WWDC23 'Animate with springs' (10158): ease curves
            // "jerk to a halt" when retargeted because a Bezier cannot
            // encode initial velocity; springs uniquely preserve in-
            // flight velocity across interruption. Bounce 0
            // (dampingFraction 1.0) keeps the handoff itself calm —
            // the runner's overshoot already carries the bounce.
            .animation(.spring(response: 0.32, dampingFraction: 1.0), value: auth.isLoading)
            .animation(.spring(response: 0.32, dampingFraction: 1.0), value: launchMinElapsed)
            .animation(.spring(response: 0.32, dampingFraction: 1.0), value: auth.isAuthenticated)
            .animation(.spring(response: 0.32, dampingFraction: 1.0), value: onboarding.hasSeenFirstLaunchPaywall)
            // Referral intake: a ?ref=CODE on ANY URL that reaches the app
            // (custom scheme today; universal links when provisioned) persists
            // pre-auth and claims at sign-in. Non-referral URLs are ignored.
            .onOpenURL { url in
                ReferralService.shared.handleIncomingURL(url)
            }
            // Post-auth landing reset (build 217): every sign-in lands on chat
            // with the composer focused; sign-out clears the nav so it can't
            // persist a stale Account/Library sheet into the next session.
            .onAppear {
                // Report every pick a PREVIOUS session left unresolved. Must run at
                // launch: the app dying mid-upload is itself one of the
                // hypotheses, so an in-memory-only report would be lost exactly
                // when it matters most.
                UploadOutcomeReporter.shared.sweepOnLaunch()
                #if DEBUG
                // -unsProof: exercise the terminal emit path end-to-end without
                // needing a real failing upload on a real network.
                if ProcessInfo.processInfo.arguments.contains("-unsProof") {
                    let a = UUID(), b = UUID()
                    UploadOutcomeReporter.shared.recordPick(id: a, sizeMB: 12.5)
                    UploadOutcomeReporter.shared.recordPick(id: b, sizeMB: 40.0)
                    // b uploaded fine but was never sent — the split under test.
                    UploadOutcomeReporter.shared.recordUploadSettled(id: b, srcKey: "sources/demo-b.mp4")
                    UploadOutcomeReporter.shared._debugMarkAllRecordsStale()
                    UploadOutcomeReporter.shared.sweepOnLaunch()
                    print("[unsProof] records remaining after sweep = \(UploadOutcomeReporter.shared._debugRecordCount)")
                }
                #endif
                #if DEBUG
                if motionProof { Self.motionProofReset(); OnboardingState.shared.debugForceFlag("first_launch_paywall"); OnboardingState.shared.debugForceFlag("onboarding_v2") }
                #endif
            }
            .onChange(of: auth.isAuthenticated) { _, authed in
                if authed {
                    AppState.shared.landOnChat()
                    // Answers given PRE-AUTH can't reach profile_settings (no
                    // token yet) — re-fire the best-effort persist the moment
                    // auth lands. The attribution surfaces are gone, but the
                    // stored answer from an older build may still be here, and
                    // Q1/Q2 are asked pre-auth on the live path.
                    if onboarding.onboardingV2Enabled, onboarding.attribution != nil {
                        onboarding.persistAnswersToProfile()
                    }
                }
                else { AppState.shared.clearNavForSignOut() }
            }
            .onChange(of: scenePhase) { previous, phase in
                if phase == .active {
                    if !didStartSession || previous == .background {
                        didStartSession = true
                        // Carries the UI language so the twelve-language
                        // translation work is measurable at all. There is no
                        // language or locale field anywhere else in analytics —
                        // `language_selected` has zero rows — so before this,
                        // "did translating the funnel change conversion?" could
                        // not be asked, only guessed at from territory, which is
                        // a different variable. `AppLanguage.current` is the
                        // language actually in force: the device's resolved
                        // choice, or the account override.
                        Analytics.track("session_started",
                                        props: ["language": AppLanguage.current,
                                                "language_is_override": AppLanguage.override != nil])
                    }
                    // 226 item 7b: on every foreground (and cold launch), touch the
                    // multipart uploader so its background session reconnects, then
                    // reconcile + resume in-flight uploads and abort any that expired.
                    // Abandoned parts bill forever, so the sweep must NEVER wait for the
                    // user to revisit a screen.
                    Task { @MainActor in ResumableMultipartUploader.shared.resumeAndSweepOnForeground() }
                } else if phase == .background {
                    // LIVE-LEAK FIX: force-flush the 600ms-debounced chat saves the
                    // MOMENT the app resigns, so a just-dispatched render's jobId reaches
                    // the server before suspension instead of being lost in the debounce.
                    // The video_job is durable server-side but the chat write was
                    // best-effort — the gap that stranded ~10% of completed videos from
                    // any chat. `ChatStore.flushNow()` existed but had ZERO callers; this
                    // wires it. A background task gives the flush time to finish.
                    var bgTask = UIBackgroundTaskIdentifier.invalid
                    bgTask = UIApplication.shared.beginBackgroundTask {
                        if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
                    }
                    Task { @MainActor in
                        await ChatStore.shared.flushNow()
                        if bgTask != .invalid { UIApplication.shared.endBackgroundTask(bgTask); bgTask = .invalid }
                    }
                }
            }
            .environmentObject(appState)
            // Apply the onboarding language choice app-wide this session (the
            // String Catalog resolves Text() against this locale). Persisted via
            // AppleLanguages for full effect on the next launch. Defaults to the
            // system locale when unset.
            .environment(\.locale, onboarding.locale ?? .current)
            .preferredColorScheme(.dark)
            .task {
                #if DEBUG
                // Applied before anything reads a flag, and re-applied is free
                // (every setter is guarded).
                for f in Self.forcedFlags { OnboardingState.shared.debugForceFlag(f) }
                // `-firstRunSeen` / `-firstRunReset`: the funnel is once per
                // DEVICE and stored in the Keychain, so it cannot be replayed or
                // skipped by reinstalling. Testing what comes AFTER it needs a
                // way to say it already happened.
                let args = ProcessInfo.processInfo.arguments
                if args.contains("-firstRunReset") { FirstRun.reset() }
                if args.contains("-firstRunSeen") { FirstRun.markSeen() }
                // The claim under test: the funnel is once per DEVICE, and a
                // reinstall must not replay it. UserDefaults would; the Keychain
                // should not. Printed so it can be read across an uninstall.
                print("FIRSTRUN seen=\(FirstRun.seen)")
                // `-poseCredits N`: show the counter in a capture without an
                // account. Posed, and labelled as such in the report — a
                // screenshot of an invented balance presented as real would be
                // the worst kind of review artifact.
                if let i = args.firstIndex(of: "-poseCredits"), i + 1 < args.count,
                   let n = Int(args[i + 1]) {
                    CreditsService.shared.debugSetBalance(n)
                }
                // `-probeAuthSeams`: RUN the deferred-auth guards signed out
                // instead of reading them. A gate that greps the source proves
                // the line exists; this proves it does something.
                if args.contains("-probeAuthSeams") {
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(6))
                        await AuthSeamProbe.run()
                    }
                }
                // Measure, do not guess. Two rounds of safe-area fixes changed
                // nothing visible, which means the assumption about WHAT the app
                // is being given is wrong. Print the actual insets.
                if args.contains("-probeInsets") {
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(4))
                        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
                        for sc in scenes {
                            for w in sc.windows {
                                print("INSETPROBE window=\(type(of: w)) frame=\(w.frame) safeArea=\(w.safeAreaInsets) key=\(w.isKeyWindow)")
                            }
                        }
                    }
                }
                #endif
                // Minimum LaunchView display time so the entrance
                // animation always completes. Runs in parallel with
                // the auth check; whichever finishes later determines
                // when the handoff fires.
                Task {
                    try? await Task.sleep(for: .seconds(2))
                    resolveDeadlinePassed = true   // countdown-ok: internal timeout, not UI
                }
                Task {
                    try? await Task.sleep(for: .milliseconds(700))
                    launchMinElapsed = true
                }
                // The one knob, resolved in parallel with the auth check
                // (pre-auth endpoint; last-known value on failure). Skipped
                // under the presentation-proof harness so it can't override
                // the forced-on flag.
                #if DEBUG
                if !ProcessInfo.processInfo.arguments.contains("-reproOnboarding") {
                    Task { await onboarding.resolveExposure() }
                }
                #else
                Task { await onboarding.resolveExposure() }
                #endif
                await auth.checkSession()
                // If we already have permission from a prior install, kick
                // off remote-registration so the server learns this run's
                // (potentially rotated) token. No prompt — that comes after
                // the first send.
                if PushService.shared.hasAskedForPermission && auth.isAuthenticated {
                    await PushService.shared.requestPermissionIfNeeded()
                }
                // Tell RevenueCat which Supabase user is signed in so its
                // webhook can write pro_until back to the right profiles row.
                // Also pull the initial usage snapshot for the badge.
                if auth.isAuthenticated, let uid = auth.currentUser?.id {
                    await SubscriptionService.shared.identify(userId: uid)
                    // PostHog identity: merge this device's anonymous history
                    // onto the signed-in person (same Supabase uid the server's
                    // RC-webhook mirror captures under — funnels join across
                    // the client/server seam).
                    // FREEMIUM tier super-property is free/pro (the funnel's
                    // segmentation dimension) — never the internal none/trial/paid.
                    Analytics.identify(
                        userId: uid,
                        tier: SubscriptionService.shared.effectiveIsPro ? "pro" : "free"
                    )
                    await UsageService.shared.refresh()
                }
            }
        }
    }
}

/// Branded splash shown while `auth.checkSession()` resolves.
///
/// User feedback going into this rewrite: "the intro transition looks
/// kind of cheap. The logo is not animated, it just starts shaking and
/// looks super choppy. I want it to zoom ALL the way into the logo and
/// transition into a fade in that drops you into the app."
///
/// What the previous version did wrong:
///   - Sinusoidal idle motion (sub-pixel bob + 1.6° lean + breath +
///     glow pulse driven by a 60Hz TimelineView) read as JITTER, not
///     life. Especially on first impression — there was no entrance
///     context for the small motion, it just looked like the logo was
///     vibrating in place.
///   - Sprint-in from off-screen left then spring overshoot was a lot
///     of separate motion verbs strung together. Felt overdesigned.
///   - A "light kiss" white flash overlay at landing read as a glitch
///     on real devices, not the soft "camera flash" the comments
///     described.
///
/// What this version does instead — exactly what the user asked for:
///   1. Logo starts SMALL and slightly blurred (scale 0.35, blur 10)
///      with opacity 0. Reads as "far away" before the first frame.
///   2. ZOOM IN (~520ms, eased out so it decelerates as it arrives):
///      scale 0.35 → 1.0, blur 10 → 0, opacity 0 → 1. The runner is
///      pulled toward the viewer, settles cleanly at full size.
///   3. HOLD STATIC at full size. No bob, no lean, no breath, no
///      pulse. The wait carries on the ambient halo alone, which is
///      already drawn and doesn't need motion to feel alive.
///   4. When auth resolves, the parent WindowGroup's spring
///      crossfade fades the whole LaunchView out and fades AppShell
///      in. Hand-off is the fade itself, not a separate gesture.
///
/// Reduce Motion (WCAG 2.1 SC 2.3.3): skip the zoom entirely. Logo
/// just fades in at identity scale. Same end state, no kinetic
/// surprise for vestibular-sensitive users.
struct LaunchView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Single zoom + fade entrance. All motion happens once, then the
    // logo holds completely static until the parent crossfades us out
    // on auth resolve.
    @State private var logoScale: CGFloat = 0.35
    @State private var logoOpacity: Double = 0
    @State private var logoBlur: CGFloat = 10
    @State private var glowOpacity: Double = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Ambient halo behind the runner. Fades in alongside the
            // logo so the brand mark reads as luminous from frame one.
            // Static after that — no pulse, no breath. The previous
            // build had a 1.8s glow cycle that contributed to the
            // "shaking" feel the user called out; we kill it.
            RadialGradient(
                colors: [Color.white.opacity(0.22), Color.white.opacity(0.0)],
                center: .center,
                startRadius: 0,
                endRadius: 260
            )
            .frame(width: 520, height: 520)
            .opacity(glowOpacity)
            .blendMode(.screen)
            .allowsHitTesting(false)

            // The runner. PromptlyLogo PNG has a proper alpha channel
            // since build 170, so black is transparent and the halo
            // shines through every pixel the runner doesn't occupy.
            //
            // Only three modifiers participate in animation now:
            // scaleEffect (the zoom), opacity (the fade-in), blur
            // (the "far away → focused" cue). No rotation, no offset,
            // no breath multiplier. Static after the entrance completes.
            Image("PromptlyLogo")
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: 168, height: 168)
                .scaleEffect(logoScale)
                .opacity(logoOpacity)
                .blur(radius: logoBlur)
        }
        .task {
            // Reduce Motion path: skip the zoom. Logo just fades in
            // at identity scale, halo fades in alongside. Same final
            // state as the standard path, zero kinetic motion for
            // vestibular-sensitive users.
            if reduceMotion {
                logoScale = 1.0
                logoBlur = 0
                withAnimation(.easeOut(duration: 0.32)) {
                    logoOpacity = 1
                    glowOpacity = 0.22
                }
                return
            }

            // One unified zoom-in. Logo grows from scale 0.35 → 1.0
            // while blur clears from 10 → 0 and opacity rises 0 → 1.
            // 520ms with .easeOut so the motion DECELERATES as it
            // arrives — reads as "coming toward the viewer and
            // settling into focus" rather than ballistic snap.
            //
            // Glow fades in alongside on the same curve so the runner
            // is luminous from the first frame, not bare-then-glowing.
            //
            // No overshoot. No bounce. No second-phase spring. The
            // sinusoidal idle motion that used to run after this is
            // gone — that's what read as "shaking" before. The logo
            // holds completely static until the parent crossfades us
            // out on auth resolve.
            withAnimation(.easeOut(duration: 0.52)) {
                logoScale = 1.0
                logoOpacity = 1
                logoBlur = 0
                glowOpacity = 0.22
            }
        }
    }
}

/// The forced-update cover (version awareness). Reached only when the server
/// arms force_update AND this build is below min_supported_version — a
/// broken-build emergency, so it is deliberately non-dismissible.
struct UpdateRequiredView: View {
    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                AnimatedPromptlyMark(size: 84, halo: true)
                    .padding(.bottom, 20)
                Text("Update to continue")
                    .font(.system(size: 26, weight: .heavy))
                    .foregroundColor(.white)
                Text("This version has a problem we've fixed. Grab the update and you're back in seconds.")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.7))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
                    .padding(.top, 10)
                Button {
                    VersionAwareness.shared.openAppStore(source: "forced_cover")
                } label: {
                    Text("Update Promptly")
                        .font(.system(size: 17, weight: .bold))
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity)
                        .frame(height: 54)
                        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white))
                }
                .padding(.horizontal, 32)
                .padding(.top, 28)
            }
        }
    }
}


#if DEBUG

/// `-reproFirstRun` — walk the REAL first-launch sequence, in order, through the
/// REAL root. 2026-09-02.
///
/// WHY THIS AND NOT THE SNAPSHOT HARNESS. `-snapshotPayoff` renders one view in
/// isolation, so it can prove a screen looks right and can say nothing about
/// what a new install actually SEES, or in what ORDER. The order is the thing
/// under review here, and it is decided by the `if/else if` chain in `body` from
/// live flag values — not by any single view. This drives that chain.
///
/// WHY NOT TAPS. There is no tap primitive in `simctl`, so a capture loop cannot
/// press Continue. Every beat below is instead reached by setting the state the
/// button would have set, which is what `-reproOnboarding` already does for the
/// V1 beats — this is the V2 equivalent, since `onboarding_v2` is on and the V1
/// walk therefore reaches a flow no new user can see.
///
/// SEED THE PERSISTED KEY, THEN SET THE PUBLISHED ONE. `OnboardingV2Flow`'s
/// `restoreV2()` reads UserDefaults on appear, so assigning `v2Step` before the
/// flow exists loses the race (render-caught 2026-08-27 — the view animated
/// between two beats forever). The first beat is seeded; later beats assign
/// directly, because by then the flow is on screen and its restore has run.
///
/// `hasCompletedOnboarding` is NOT `@Published` — it is a UserDefaults-backed
/// computed property, so writing it alone re-renders nothing and the walk would
/// appear to hang on the last question. Assigning `v2Step` afterwards is what
/// publishes the change that re-evaluates the root.
@MainActor
enum FirstRunProofHarness {

    private static var didRun = false

    /// One dwell for every beat, long enough that a 1s capture loop lands at
    /// least two frames inside each and never straddles a transition.
    private static let dwell: Duration = .milliseconds(3400)

    static func runIfRequested() {
        guard !didRun else { return }
        guard ProcessInfo.processInfo.arguments.contains("-reproFirstRun") else { return }
        didRun = true
        let s = OnboardingState.shared

        // Beat 1 is whatever the root already chose from the live flags — the
        // point of the walk is that this is NOT forced. Print it so the capture
        // is labelled by what actually rendered.
        UserDefaults.standard.set(OnboardingState.V2Step.audience.rawValue,
                                  forKey: "onboarding_v2_step")

        Task { @MainActor in
            // REORDERED 2026-09-02: questions → paywall → reveal → chat. The
            // paywall used to be beat one, from a root branch above the flow.
            // 2026-09-02: attribution moved to the TAIL (after the ask), and
            // the decline catch became a rung of its own.
            for beat: OnboardingState.V2Step in [.audience, .videoType, .paywall] {
                s.v2Step = beat
                print("[FirstRunProof] beat=\(beat.rawValue)")
                try? await Task.sleep(for: dwell)
            }

            s.hasCompletedOnboarding = true
            // The REAL completion marks the Keychain key too (see
            // OnboardingV2Flow.complete). Without this the walk ended in a state
            // no user can reach — UserDefaults said done, the Keychain said
            // never started — and any test of first-run persistence run against
            // it would be testing the harness, not the app.
            FirstRun.markSeen()
            s.v2Step = .done          // publishes the change; see note above
            print("[FirstRunProof] beat=chat")
            try? await Task.sleep(for: dwell)
            print("[FirstRunProof] walk complete")
        }
    }
}

@MainActor
enum ReeditProofHarness {

    private static var didRun = false

    static func runIfRequested() {
        guard !didRun else { return }
        let args = ProcessInfo.processInfo.arguments
        guard args.contains("-reproReedit") else { return }
        didRun = true
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(1200)) // let the root UI mount
            await presentPlayerThenReedit()
        }
    }

    private static func presentPlayerThenReedit() async {
        // Wait for a topmost VC to present over.
        var top = AppState.topViewController()
        while top == nil {
            try? await Task.sleep(for: .milliseconds(500))
            top = AppState.topViewController()
        }
        guard let top else { return }

        // A dummy item is fine — we only need the full-screen UIKit modal on top
        // to reproduce RACE 1's presentation topology; playback is irrelevant.
        let url = URL(string: "https://example.com/repro.m3u8")!
        let item = AVPlayerItem(url: url)
        let session = PromptlyPlayerSession(item: item, urlString: url.absoluteString)
        let host = PromptlyPlayerHostVC(session: session, title: "Repro", posterUrl: nil, onReedit: nil)

        print("[ReeditProof] presenting real player host…")
        top.present(host, animated: true)
        try? await Task.sleep(for: .milliseconds(1500))

        // EXACTLY what a free user's Re-edit tap does (PromptlyVideoPlayer.swift
        // :699-700) + the host's onClose (:963): park, dismiss, flush.
        print("[ReeditProof] firing free-user Re-edit seam (deferPaywall + dismiss + flush)…")
        AppState.shared.deferPaywall(.reedit)
        host.dismiss(animated: true) {
            MainActor.assumeIsolated {
                AppState.shared.flushDeferredPaywall()
                print("[ReeditProof] flush complete — paywall should now be presented")
            }
        }
    }
}
#endif

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: .alphanumerics.inverted)
        var int: UInt64 = 0
        Scanner(string: hex).scanHexInt64(&int)
        let r, g, b: Double
        r = Double((int >> 16) & 0xFF) / 255.0
        g = Double((int >> 8) & 0xFF) / 255.0
        b = Double(int & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}


/// THE IPAD IS THE IPHONE LAYOUT TIMES ONE CONSTANT (ruled 2026-09-05).
///
/// k = the window's long side / 852 (iPhone 17 Pro), on a regular-width
/// container; 1.0 everywhere else. It is set HERE, at the root, so every view
/// in the window reads the same value — including the ones that sit outside
/// any conversion column, which is exactly where the Upgrade pill was still
/// rendering at phone size. A GeometryReader is safe at this level: the window
/// hands it a concrete size and nothing above it needs an intrinsic height.
struct RootScale: ViewModifier {
    @Environment(\.horizontalSizeClass) private var hSize
    func body(content: Content) -> some View {
        GeometryReader { geo in
            let long = max(geo.size.width, geo.size.height)
            content
                .environment(\.conversionScale,
                             hSize == .regular ? long / ConversionColumn.phoneReferenceHeight : 1.0)
                .frame(width: geo.size.width, height: geo.size.height)
        }
        .ignoresSafeArea()
    }
}
