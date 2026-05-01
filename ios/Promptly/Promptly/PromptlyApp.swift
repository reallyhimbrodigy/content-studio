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
        print("[Push] silent prefetch for jobId=\(jobId)")
        Task { @MainActor in
            // 25s budget — leave a few seconds of headroom under iOS's
            // 30s background runtime limit so we always get the
            // completion handler back to the OS.
            let result: UIBackgroundFetchResult = await withTaskGroup(of: UIBackgroundFetchResult.self) { group in
                group.addTask {
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
    }

    @StateObject private var appState = AppState.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if auth.isLoading {
                    LaunchView()
                } else if auth.isAuthenticated {
                    AppShell()
                } else {
                    AuthView()
                }
            }
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
            }
        }
    }
}

struct LaunchView: View {
    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            ProgressView()
                .tint(.white)
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
