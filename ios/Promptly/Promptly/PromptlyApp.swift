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

        // PostHog — the analytics backbone. The project key is a public
        // client key by design (capture-only). Autocapture (screens, taps,
        // app lifecycle) + our explicit events through Analytics.track's
        // dual-sink. Session replay ON with masking defaults: text inputs
        // and user images masked; static labels (paywall prices) visible.
        let phConfig = PostHogConfig(
            apiKey: "phc_zqZcVguSoeCnasjfxH9W2PSiBna3rApecQvTQtnNeetj",
            host: "https://us.i.posthog.com"
        )
        phConfig.captureScreenViews = true
        phConfig.captureApplicationLifecycleEvents = true
        phConfig.sessionReplay = true
        phConfig.sessionReplayConfig.maskAllTextInputs = true
        phConfig.sessionReplayConfig.maskAllImages = true
        // SwiftUI renders as one layer to the replay wireframe recorder —
        // screenshot mode is the supported capture path for SwiftUI apps.
        phConfig.sessionReplayConfig.screenshotMode = true
        PostHogSDK.shared.setup(phConfig)

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
            #if DEBUG
            .onAppear { ReeditProofHarness.runIfRequested() }
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
                    // PostHog identity: merge this device's anonymous history
                    // onto the signed-in person (same Supabase uid the server's
                    // RC-webhook mirror captures under — funnels join across
                    // the client/server seam).
                    Analytics.identify(
                        userId: uid,
                        tier: SubscriptionService.shared.effectiveIsPro ? "paid" : "none"
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

#if DEBUG
/// DEBUG-only presentation proof for the 1.1.7 re-edit P0 fix.
///
/// The live 1.1.6 bug (RACE 1): a free user taps Re-edit inside the full-screen
/// video player; the player is a UIKit `.fullScreen` modal, so setting the
/// paywall while it owns the presentation context is SILENTLY DROPPED — the user
/// is left staring at the video. The fix parks the paywall and, on the player's
/// dismissal completion, presents it via `UIHostingController` from the topmost
/// VC (`AppState.presentPaywallFromTop`) rather than through the root `.sheet`,
/// which stays dropped right after a full-screen UIKit modal dismisses.
///
/// This harness reproduces the EXACT runtime topology in the simulator using the
/// REAL `PromptlyPlayerHostVC`, the REAL `AppState.deferPaywall`/`flushDeferredPaywall`
/// seam, and the REAL `PaywallView`. Launch the app with `-reproReedit` and it:
///   1. Presents the real player as a full-screen UIKit modal (as the app does).
///   2. After it settles, fires exactly what a free user's Re-edit tap fires
///      (PromptlyVideoPlayer.swift:699-700 `deferPaywall(.reedit)` + the host's
///      onClose at :963 `dismiss { flushDeferredPaywall() }`).
///   3. If the fix holds, the real re-edit PaywallView rises. If the bug were
///      still present, the screen would fall back to whatever is behind the
///      dismissed player with no paywall — the exact live symptom.
///
/// Never compiled into Release. No effect unless the launch argument is present.
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
