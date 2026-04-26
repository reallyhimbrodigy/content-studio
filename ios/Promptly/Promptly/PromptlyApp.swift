import SwiftUI
import UIKit

#if canImport(TikTokOpenShareSDK)
import TikTokOpenShareSDK
#endif

/// App delegate stub for SDKs that require AppDelegate hooks (TikTok Open SDK
/// in particular wants application(_:open:options:) to route share-completion
/// URLs back to the SDK). Guarded by canImport so the project compiles fine
/// without the TikTok SDK linked.
final class PromptlyAppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        #if canImport(TikTokOpenShareSDK)
        // TikTok's share-result callback comes back as tiktoksharesdk{ClientKey}://
        if let scheme = url.scheme, scheme.hasPrefix("tiktoksharesdk") {
            TikTokURLHandler.handle(url: url)
            return true
        }
        #endif
        return false
    }

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
}

@main
struct PromptlyApp: App {
    @State private var auth = AuthService.shared
    @UIApplicationDelegateAdaptor(PromptlyAppDelegate.self) private var appDelegate

    init() {
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
