import SwiftUI

@main
struct PromptlyApp: App {
    @State private var auth = AuthService.shared

    init() {
        // Configure nav bar appearance
        let navAppearance = UINavigationBarAppearance()
        navAppearance.configureWithOpaqueBackground()
        navAppearance.backgroundColor = UIColor(red: 0.11, green: 0.11, blue: 0.118, alpha: 1)
        navAppearance.titleTextAttributes = [.foregroundColor: UIColor.white]
        UINavigationBar.appearance().standardAppearance = navAppearance
        UINavigationBar.appearance().scrollEdgeAppearance = navAppearance

        // Classic full-width iOS tab bar (like Instagram) — NOT the iOS 18 floating pill.
        // configureWithOpaqueBackground forces the classic full-width opaque style.
        let tabAppearance = UITabBarAppearance()
        tabAppearance.configureWithOpaqueBackground()
        tabAppearance.backgroundColor = UIColor(red: 0.11, green: 0.11, blue: 0.118, alpha: 1.0)
        tabAppearance.shadowColor = UIColor.white.withAlphaComponent(0.06)
        // Unselected: gray, Selected: white
        tabAppearance.stackedLayoutAppearance.normal.titleTextAttributes = [.foregroundColor: UIColor.white.withAlphaComponent(0.4)]
        tabAppearance.stackedLayoutAppearance.selected.titleTextAttributes = [.foregroundColor: UIColor.white]
        tabAppearance.stackedLayoutAppearance.normal.iconColor = UIColor.white.withAlphaComponent(0.4)
        tabAppearance.stackedLayoutAppearance.selected.iconColor = UIColor.white
        UITabBar.appearance().standardAppearance = tabAppearance
        UITabBar.appearance().scrollEdgeAppearance = tabAppearance
        // Prevent iOS 18 from floating/morphing the tab bar
        UITabBar.appearance().isTranslucent = false

        // Keyboard dismiss on scroll globally — native iOS behavior
        UIScrollView.appearance().keyboardDismissMode = .interactive
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if auth.isLoading {
                    LaunchView()
                } else if auth.isAuthenticated {
                    MainTabView()
                } else {
                    AuthView()
                }
            }
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
            Color(hex: "121212").ignoresSafeArea()
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
