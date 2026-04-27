import SwiftUI

struct MainTabView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            // Keep all three tab views alive via ZStack + opacity. UITabBarController
            // does this — switching tabs preserves view state, in-flight uploads,
            // chat history, scroll position, etc. The previous `switch` rebuilt
            // the entire view tree on every tab change, wiping @State.
            // `allowsHitTesting` ensures inactive tabs don't intercept touches.
            ZStack {
                EditorView()
                    .opacity(appState.selectedTab == 0 ? 1 : 0)
                    .allowsHitTesting(appState.selectedTab == 0)
                LibraryView()
                    .opacity(appState.selectedTab == 1 ? 1 : 0)
                    .allowsHitTesting(appState.selectedTab == 1)
                AccountView()
                    .opacity(appState.selectedTab == 2 ? 1 : 0)
                    .allowsHitTesting(appState.selectedTab == 2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Full-width tab bar — edge to edge, no floating pill
            HStack(spacing: 0) {
                TabBarButton(icon: "bubble.left.fill", label: "Edit", isSelected: appState.selectedTab == 0) {
                    appState.selectedTab = 0
                }
                TabBarButton(icon: "square.grid.2x2.fill", label: "Library", isSelected: appState.selectedTab == 1) {
                    appState.selectedTab = 1
                }
                TabBarButton(icon: "person.fill", label: "Account", isSelected: appState.selectedTab == 2) {
                    appState.selectedTab = 2
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 2)
            .background(Color(.systemBackground))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color(.separator))
                    .frame(height: 0.5)
            }
        }
        .ignoresSafeArea(.keyboard)
        .background(Color(.systemBackground))
    }
}

struct TabBarButton: View {
    let icon: String
    let label: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }) {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 20))
                    .accessibilityHidden(true)
                Text(label)
                    .font(.system(size: 10, weight: .medium))
            }
            .foregroundColor(isSelected ? .white : .secondary)
            .frame(maxWidth: .infinity)
            .frame(height: 44)
        }
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }
}
