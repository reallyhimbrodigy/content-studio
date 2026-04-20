import SwiftUI

@main
struct PromptlyApp: App {
    @State private var auth = AuthService.shared

    init() {
        // Configure nav bar appearance
        let navAppearance = UINavigationBarAppearance()
        navAppearance.configureWithOpaqueBackground()
        navAppearance.backgroundColor = UIColor.black
        navAppearance.titleTextAttributes = [.foregroundColor: UIColor.white]
        UINavigationBar.appearance().standardAppearance = navAppearance
        UINavigationBar.appearance().scrollEdgeAppearance = navAppearance

        // Tab bar is custom (not SwiftUI TabView) — no UITabBarAppearance needed

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
