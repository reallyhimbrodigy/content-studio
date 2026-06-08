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
            // soft hand-off rather than a slam.
            .animation(.easeOut(duration: 0.35), value: auth.isLoading)
            .animation(.easeOut(duration: 0.28), value: auth.isAuthenticated)
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

/// Cinematic branded splash shown while `auth.checkSession()` resolves.
///
/// Sequence:
///   1. ~60ms black hold (gives the eye a quiet beat before action)
///   2. ZOOM: logo rockets in from scale 0.18 to 1.15 over ~260ms,
///      blur clearing from 22 → 0, opacity 0 → 1, with 8 radial speed
///      rays sweeping outward behind it (the "running / whoosh" the
///      user asked for).
///   3. IMPACT: spring overshoot snaps logo back to 1.0 (~180ms),
///      glow ring shockwaves outward, and a white flash briefly
///      veils the screen — reads as a soft camera-flash on landing.
///   4. SETTLE: speed rays fade, shockwave finishes, ambient halo
///      relaxes to a low persistent value, and the logo enters a
///      barely-perceptible 1.0 ↔ 1.025 breathing loop so the splash
///      never looks "stuck" while the auth check finishes.
///
/// Total entrance is ~450ms — short enough that a fast checkSession()
/// resolve cuts to the app shell mid-breathe (the parent crossfade
/// modifier in WindowGroup handles the hand-off), but slow enough
/// that the user clocks the brand moment on a cold start.
struct LaunchView: View {
    // Logo
    @State private var logoScale: CGFloat = 0.18
    @State private var logoOpacity: Double = 0
    @State private var logoBlur: CGFloat = 22
    @State private var breathing = false

    // Ambient glow beneath the logo (persists at low opacity after the
    // entrance so the mark reads as luminous rather than flat).
    @State private var glowOpacity: Double = 0

    // Speed rays — eight thin radial spokes that sweep outward during
    // the zoom phase. Suggests motion/whoosh without a particle system.
    @State private var raysScale: CGFloat = 0.6
    @State private var raysOpacity: Double = 0

    // Shockwave ring — scales outward at the landing moment so the
    // logo's arrival reads as an impact rather than a fade-in.
    @State private var shockScale: CGFloat = 0.4
    @State private var shockOpacity: Double = 0

    // Brief white flash that veils the screen at impact — the
    // camera-flash beat of the landing.
    @State private var flashOpacity: Double = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Ambient glow halo (persistent, low-opacity after entrance).
            RadialGradient(
                colors: [Color.white.opacity(0.22), Color.white.opacity(0.0)],
                center: .center,
                startRadius: 0,
                endRadius: 240
            )
            .frame(width: 480, height: 480)
            .opacity(glowOpacity)
            .blendMode(.screen)

            // Speed rays — 8 radial spokes. Sweep outward during the
            // zoom, fade as the logo lands.
            ZStack {
                ForEach(0..<8, id: \.self) { i in
                    Capsule()
                        .fill(LinearGradient(
                            colors: [Color.white.opacity(0.9), Color.white.opacity(0)],
                            startPoint: .leading, endPoint: .trailing
                        ))
                        .frame(width: 96, height: 1.5)
                        .offset(x: 86)
                        .rotationEffect(.degrees(Double(i) * 45))
                }
            }
            .scaleEffect(raysScale)
            .opacity(raysOpacity)
            .blur(radius: 0.5)
            .blendMode(.screen)
            .allowsHitTesting(false)

            // Shockwave ring — expanding circle stroke that fires at
            // the impact moment.
            Circle()
                .stroke(Color.white.opacity(0.55), lineWidth: 1.5)
                .frame(width: 220, height: 220)
                .scaleEffect(shockScale)
                .opacity(shockOpacity)
                .blur(radius: 0.5)
                .blendMode(.screen)
                .allowsHitTesting(false)

            // The logo itself — the focal point. Scale + blur + opacity
            // animate together for the cinematic zoom-in feel.
            Image("PromptlyLogo")
                .resizable()
                .renderingMode(.template)
                .foregroundColor(.white)
                .aspectRatio(contentMode: .fit)
                .frame(width: 148, height: 148)
                .scaleEffect(breathing ? logoScale * 1.025 : logoScale)
                .opacity(logoOpacity)
                .blur(radius: logoBlur)
                .animation(
                    .easeInOut(duration: 2.6).repeatForever(autoreverses: true),
                    value: breathing
                )

            // Camera-flash veil — briefly washes the screen white at
            // the impact moment, then clears.
            Color.white
                .opacity(flashOpacity)
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .blendMode(.screen)
        }
        .task {
            // Phase 1 — brief black hold. Gives the eye a quiet beat
            // so the zoom that follows reads as decisive.
            try? await Task.sleep(for: .milliseconds(60))

            // Phase 2 — ZOOM. Logo rockets in: scale 0.18 → 1.15,
            // opacity 0 → 1, blur 22 → 0. Timing curve front-loads the
            // acceleration so the motion feels like it's coming AT
            // the viewer rather than crawling. Speed rays fire in
            // parallel and sweep outward.
            withAnimation(.timingCurve(0.22, 0.6, 0.35, 1, duration: 0.26)) {
                logoScale = 1.15
                logoOpacity = 1
                logoBlur = 0
            }
            withAnimation(.easeOut(duration: 0.32)) {
                raysScale = 1.6
                raysOpacity = 1
            }

            // Phase 3 — IMPACT. Spring overshoot back to 1.0 — the
            // perceived "thunk" of the logo landing. Shockwave ring
            // expands outward simultaneously, and the camera flash
            // briefly veils the screen.
            try? await Task.sleep(for: .milliseconds(240))
            withAnimation(.spring(response: 0.34, dampingFraction: 0.62)) {
                logoScale = 1.0
            }
            withAnimation(.easeOut(duration: 0.45)) {
                shockScale = 1.9
                shockOpacity = 0.85
            }
            withAnimation(.easeOut(duration: 0.18)) {
                flashOpacity = 0.32
                glowOpacity = 0.62
            }
            // Begin fading the flash + rays back out almost immediately
            // so the "impact" reads as a snap rather than a hold.
            withAnimation(.easeInOut(duration: 0.4).delay(0.06)) {
                flashOpacity = 0
                raysOpacity = 0
            }

            // Phase 4 — SETTLE. Shockwave finishes, glow relaxes to a
            // low persistent halo, breathing loop kicks on so the
            // splash never reads as stuck during the auth wait.
            try? await Task.sleep(for: .milliseconds(280))
            withAnimation(.easeOut(duration: 0.5)) {
                shockOpacity = 0
                shockScale = 2.2
                glowOpacity = 0.18
            }
            breathing = true
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
