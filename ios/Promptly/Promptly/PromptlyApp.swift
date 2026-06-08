import SwiftUI
import UIKit
import Sentry
import UserNotifications

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
        // were terminated.
        Task { @MainActor in
            BackgroundUploadManager.shared.savedCompletionHandler = completionHandler
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

    /// User tapped the notification. For render-complete pushes, jump to
    /// the Library tab and (later, if we want) auto-open the matching edit.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        let type = userInfo["type"] as? String
        Task { @MainActor in
            if type == "render-complete" || type == "render-failed" {
                AppState.shared.selectedTab = 1  // Library
            }
            completionHandler()
        }
    }
}

@main
struct PromptlyApp: App {
    @State private var auth = AuthService.shared
    @UIApplicationDelegateAdaptor(PromptlyAppDelegate.self) private var appDelegate

    init() {
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

        // Boot RevenueCat. Pulls offerings + initial CustomerInfo so the
        // paywall has data ready the first time it's presented. Once the
        // Supabase user resolves below in `.task`, we call identify() to
        // alias their RC ID to the Supabase user.id — that's what the
        // webhook uses to write pro_until back to profiles.
        SubscriptionService.shared.bootstrap()
    }

    @StateObject private var appState = AppState.shared

    var body: some Scene {
        WindowGroup {
            ZStack {
                if auth.isLoading {
                    LaunchView()
                        .transition(.opacity.combined(with: .scale(scale: 1.04)))
                } else if auth.isAuthenticated {
                    AppShell()
                        .transition(.opacity)
                } else {
                    AuthView()
                        .transition(.opacity)
                }
            }
            // Crossfade between launch ↔ authed ↔ unauthed roots so the
            // logo doesn't hard-cut to the app shell when checkSession()
            // resolves. The logo's slight scale-up on exit reads as a
            // soft hand-off rather than a slam. Crossfade durations are
            // intentionally short — once auth resolves, the user wants
            // to be IN the app, not watching another transition.
            .animation(.easeOut(duration: 0.22), value: auth.isLoading)
            .animation(.easeOut(duration: 0.22), value: auth.isAuthenticated)
            .environmentObject(appState)
            .preferredColorScheme(.dark)
            .task {
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
                    await UsageService.shared.refresh()
                }
            }
        }
    }
}

/// Branded splash shown while `auth.checkSession()` resolves.
///
/// Designed around the actual Promptly mark — a runner with motion
/// lines baked into the artwork. Rather than layering synthetic speed
/// rays on top (which would compete with the brand), the animation
/// uses the runner's own motion direction: the logo SPRINTS IN from
/// off-screen left (where the existing motion lines trail), brakes to
/// a stop at center with a small overshoot, then "runs in place"
/// during the wait — a subtle vertical bob plus an occasional thin
/// streak passing behind the runner suggesting wind/speed.
///
/// Phases:
///   1. ~60ms black hold — the breath before motion.
///   2. SPRINT IN (~320ms) — logo enters from offset x=-280 to 0,
///      scale 0.78 → 1.08, opacity 0 → 1, horizontal motion blur
///      14 → 0. Timing curve decelerates at the end so it reads as
///      braking to a stop, not skidding past.
///   3. LAND (~200ms) — spring overshoot 1.08 → 1.0 (the brake), soft
///      glow bloom from beneath the runner, brief light kiss across
///      the screen (eased to 24% peak — felt, not seen).
///   4. RUN IN PLACE (idle) — subtle 1.0 ↔ 1.025 breathe + 0 ↔ -2pt
///      vertical bob over 1.4s loops (the runner's stride). Every
///      ~1.6s a thin horizontal streak passes behind the runner from
///      right to left, fading in/out — the wind still moving past.
///      This is what carries the long-wait case (5s+ on slow auth
///      resolves) so the splash never reads as frozen.
///
/// Exit hand-off: when auth.isLoading flips false, the WindowGroup's
/// .animation(.easeOut(duration: 0.22)) crossfades LaunchView out.
/// Same crossfade timing applies on a fast resolve that cuts the
/// sprint short — the exit blends with whatever animation phase the
/// view happens to be in, no special-case needed.
struct LaunchView: View {
    // Sprint-in entrance state (withAnimation-driven, settles to
    // identity values once the entrance completes).
    @State private var logoOffsetX: CGFloat = -280
    @State private var logoScale: CGFloat = 0.78
    @State private var logoOpacity: Double = 0
    @State private var logoBlur: CGFloat = 14

    // Ambient glow under the logo (blooms on land, settles for idle).
    @State private var glowBaseOpacity: Double = 0

    // Brief light kiss at landing — softer than a full flash.
    @State private var landFlashOpacity: Double = 0

    // Idle starts after the entrance settles. Used to gate the
    // sinusoidal stride animations inside the TimelineView.
    @State private var strideStart: Date? = nil

    var body: some View {
        // Single TimelineView drives every continuous motion in the
        // scene — runner stride (bob + lean + breath), glow pulse,
        // ambient halo modulation. Driving everything off one time
        // stream means the layers stay phase-coherent: the lean
        // peaks as the runner bobs down, the glow pulses on the
        // breath cycle, etc. Boolean .repeatForever animations
        // couldn't express this — they only toggle between two
        // states and re-trigger on a single value change. Using
        // sinusoids gives true continuous motion that feels organic
        // rather than mechanical.
        TimelineView(.animation(minimumInterval: 1.0 / 60.0)) { context in
            let elapsed = strideStart.map { context.date.timeIntervalSince($0) } ?? 0

            // Stride: ~0.7s per cycle (≈1.4 steps/sec, jogging pace).
            // All stride values start at 0 at t=0 so the transition
            // from the entrance's final state into the idle loop is
            // invisible — no scale pop, no offset jump.
            let stridePhase = elapsed * 2.0 * .pi / 0.7
            let bob = sin(stridePhase) * 3.0                       // 0 → ±3pt
            let lean = sin(stridePhase) * 1.6                      // 0 → ±1.6° (forward at bob-down)

            // Breath: longer cycle, offset from stride so they don't
            // double-pulse. (1 - cos) flavor keeps breath ≥ 1.0 so
            // the runner never visually shrinks below identity.
            // Amplitude tuned to be visibly perceptible without
            // reading as "the logo is changing size."
            let breathPhase = elapsed * 2.0 * .pi / 2.3
            let breath = 1.0 + (1.0 - cos(breathPhase)) * 0.012    // 1.0 → 1.024

            // Glow pulse: yet another cycle, layered on top of the
            // settled base opacity for an organic ambient feel.
            let glowPhase = elapsed * 2.0 * .pi / 1.8
            let glowPulseExtra = (1.0 - cos(glowPhase)) * 0.06     // 0 → 0.12

            ZStack {
                Color.black.ignoresSafeArea()

                // Ambient halo. Base opacity is @State-driven by the
                // entrance (rises on land, settles for idle). The
                // pulse extra is added on top continuously.
                RadialGradient(
                    colors: [Color.white.opacity(0.25), Color.white.opacity(0.0)],
                    center: .center,
                    startRadius: 0,
                    endRadius: 260
                )
                .frame(width: 520, height: 520)
                .opacity(glowBaseOpacity + glowPulseExtra)
                .blendMode(.screen)
                .allowsHitTesting(false)

                // The runner. The PNG is white art on a SOLID BLACK
                // background (no alpha channel). Without intervention
                // the black square would OCCLUDE the glow halo behind
                // it — a visible 168×168 dark cutout in the middle of
                // the halo. .blendMode(.screen) fixes this: screen
                // mode treats black as transparent (black + anything
                // = anything) so the glow shines through unimpeded,
                // while white runner pixels stay solid white. The
                // runner appears to FLOAT in the luminous halo
                // rather than sit on top of a flat square. This is
                // the single most important compositing decision in
                // the splash — without it nothing else looks right.
                //
                // Modifier ordering matters: rotation first (rotate
                // the art), then offset (translate the rotated art),
                // then scale (around its now-translated center). This
                // matches how a running body actually moves — torso
                // rotates, whole body bobs, breath layered on top.
                Image("PromptlyLogo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 168, height: 168)
                    .rotationEffect(.degrees(lean))
                    .offset(x: logoOffsetX, y: bob)
                    .scaleEffect(logoScale * CGFloat(breath))
                    .opacity(logoOpacity)
                    .blur(radius: logoBlur)
                    .blendMode(.screen)

                // Brief light kiss at landing — purely entrance-driven.
                Color.white
                    .opacity(landFlashOpacity)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .blendMode(.screen)
            }
        }
        .task {
            // Phase 1 — black hold (the breath before motion).
            try? await Task.sleep(for: .milliseconds(60))

            // Phase 2 — SPRINT IN. Runner enters from off-screen left
            // (motion lines on the artwork trail behind correctly).
            // Decelerating curve — reads as braking to a stop, not
            // skidding past.
            withAnimation(.timingCurve(0.16, 0.7, 0.28, 1, duration: 0.32)) {
                logoOffsetX = 0
                logoScale = 1.08
                logoOpacity = 1
                logoBlur = 0
            }

            // Phase 3 — LAND. Spring overshoot back to 1.0 (the brake),
            // glow blooms beneath, light kiss flashes briefly.
            try? await Task.sleep(for: .milliseconds(300))
            withAnimation(.spring(response: 0.32, dampingFraction: 0.66)) {
                logoScale = 1.0
            }
            withAnimation(.easeOut(duration: 0.22)) {
                glowBaseOpacity = 0.55
                landFlashOpacity = 0.18
            }
            withAnimation(.easeInOut(duration: 0.45).delay(0.10)) {
                landFlashOpacity = 0
                glowBaseOpacity = 0.22
            }

            // Phase 4 — RUN IN PLACE. Anchor strideStart so the
            // TimelineView's sinusoidal stride/breath/glow modulations
            // begin from zero phase (matches the entrance's final
            // identity values, no visible pop). From here onward the
            // continuous motion carries the wait: stride/lean at
            // 0.7s, breath at 2.3s, glow pulse at 1.8s — three
            // independent clocks so they never sync up and beat
            // against each other.
            try? await Task.sleep(for: .milliseconds(260))
            strideStart = Date()
        }
    }
}

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
