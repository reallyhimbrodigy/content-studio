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

    /// LaunchView must remain on screen long enough for its entrance
    /// animation to complete and the brand moment to register. Without
    /// this gate, a fast auth.checkSession() resolve (~300ms on a warm
    /// device) would cut to AppShell while the logo is still mid-zoom
    /// — the user would see a half-formed mark snap away. 700ms is the
    /// floor: ~280ms entrance + ~420ms of idle "the runner is alive"
    /// before any handoff is allowed.
    @State private var launchMinElapsed = false

    var body: some Scene {
        WindowGroup {
            ZStack {
                if auth.isLoading || !launchMinElapsed {
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
            .environmentObject(appState)
            .preferredColorScheme(.dark)
            .task {
                // Minimum LaunchView display time so the entrance
                // animation always completes. Runs in parallel with
                // the auth check; whichever finishes later determines
                // when the handoff fires.
                Task {
                    try? await Task.sleep(for: .milliseconds(700))
                    launchMinElapsed = true
                }
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
    // WCAG 2.1 SC 2.3.3 + iOS Reduce Motion accessibility.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Zoom-in entrance. Logo starts SMALL (scale 0.25) and very
    // BLURRED (18pt) — reads as "coming from far away / toward the
    // camera." Snaps to identity values in ~220ms with a spring
    // overshoot for the "whoosh land" feel the user asked for.
    //
    // Why zoom and not slide-in: the user explicitly said "zooming
    // in super fast all the way and then whoosh fade in." Slide-in
    // is what we built in 162-168 — wrong shape entirely.
    //
    // Speed: total entrance ~280ms. auth.checkSession() typically
    // resolves in ~300ms on a cold start so the animation needs to
    // FINISH inside that window or the user sees a half-formed
    // logo cut to the auth screen. PromptlyApp enforces a 500ms
    // minimum LaunchView display time on top of this so even a
    // truly instant resolve still lets the brand moment land.
    @State private var logoScale: CGFloat = 0.25
    @State private var logoOpacity: Double = 0
    @State private var logoBlur: CGFloat = 18

    // Ambient glow under the logo (blooms during zoom, settles low).
    @State private var glowBaseOpacity: Double = 0

    // Brief light kiss at landing.
    @State private var landFlashOpacity: Double = 0

    // Idle starts after the entrance settles.
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

            // Reduce Motion path: skip every sinusoidal modulation.
            // The runner sits at identity scale/position with a gentle
            // ambient halo only.
            let stridePhase = elapsed * 2.0 * .pi / 0.7
            let bob = reduceMotion ? 0.0 : sin(stridePhase) * 3.0
            let lean = reduceMotion ? 0.0 : sin(stridePhase) * 1.6

            let breathPhase = elapsed * 2.0 * .pi / 2.3
            let breath = reduceMotion ? 1.0 : (1.0 + (1.0 - cos(breathPhase)) * 0.012)

            let glowPhase = elapsed * 2.0 * .pi / 1.8
            let glowPulseExtra = reduceMotion ? 0.0 : (1.0 - cos(glowPhase)) * 0.06

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

                // The runner. PromptlyLogo PNG was reprocessed in build
                // 170 to have a proper alpha channel — the original
                // had a solid black background with no alpha, which
                // would have created a visible 168×168 dark cutout in
                // the middle of the halo. Now black is transparent and
                // white runner art is opaque; the halo shines through
                // every pixel the runner doesn't occupy, exactly as a
                // luminous mark should compose.
                Image("PromptlyLogo")
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 168, height: 168)
                    .rotationEffect(.degrees(lean))
                    .offset(y: bob)
                    .scaleEffect(logoScale * CGFloat(breath))
                    .opacity(logoOpacity)
                    .blur(radius: logoBlur)

                // Brief light kiss at landing — purely entrance-driven.
                Color.white
                    .opacity(landFlashOpacity)
                    .ignoresSafeArea()
                    .allowsHitTesting(false)
                    .blendMode(.screen)
            }
        }
        .task {
            // Reduce Motion path: skip zoom + overshoot + flash. Just
            // a calm fade-in at identity scale, then the static idle
            // layer (also damped to zero modulation when reduceMotion
            // is true) holds the brand moment.
            if reduceMotion {
                logoScale = 1.0
                logoBlur = 0
                withAnimation(.easeOut(duration: 0.28)) {
                    logoOpacity = 1
                    glowBaseOpacity = 0.22
                }
                try? await Task.sleep(for: .milliseconds(280))
                strideStart = Date()
                return
            }

            // Phase 1 — brief black hold (one frame of anticipation).
            try? await Task.sleep(for: .milliseconds(30))

            // Phase 2 — ZOOM IN. The user's actual ask: "zooming in
            // super fast all the way and then whoosh fade in." Logo
            // grows from scale 0.25 → 1.08 with opacity 0 → 1 and
            // blur 18 → 0 over 200ms. Front-loaded ease so it feels
            // like the logo is rushing toward the camera and braking
            // as it arrives. Slight scale overshoot (1.08) anticipates
            // the spring landing in Phase 3.
            withAnimation(.timingCurve(0.22, 0.68, 0.34, 1, duration: 0.20)) {
                logoScale = 1.08
                logoOpacity = 1
                logoBlur = 0
            }

            // Glow blooms in parallel with the zoom so the runner
            // looks luminous from the moment it's visible.
            withAnimation(.easeOut(duration: 0.24)) {
                glowBaseOpacity = 0.55
                landFlashOpacity = 0.20
            }

            // Phase 3 — WHOOSH LAND. Spring back to 1.0 (the "thunk"
            // of arrival), flash veil fades out, glow settles. Spring
            // bounce ≈ 0.34 — within WWDC23 cap of 0.4 for UI.
            try? await Task.sleep(for: .milliseconds(200))
            withAnimation(.spring(response: 0.30, dampingFraction: 0.66)) {
                logoScale = 1.0
            }
            withAnimation(.easeInOut(duration: 0.40).delay(0.04)) {
                landFlashOpacity = 0
                glowBaseOpacity = 0.22
            }

            // Phase 4 — RUN IN PLACE. Anchor strideStart so the
            // TimelineView's sinusoidal stride/breath/glow modulations
            // start at zero phase, exactly matching the entrance's
            // final identity values. From here the continuous motion
            // carries any additional wait — three independent clocks
            // (stride 0.7s, glow pulse 1.8s, breath 2.3s) so they
            // never sync up and beat into a single visible loop.
            try? await Task.sleep(for: .milliseconds(180))
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
