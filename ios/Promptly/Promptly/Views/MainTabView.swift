import SwiftUI

struct MainTabView: View {
    @EnvironmentObject private var appState: AppState

    var body: some View {
        VStack(spacing: 0) {
            // Content
            Group {
                switch appState.selectedTab {
                case 0: EditorView()
                case 1: LibraryView()
                case 2: AccountView()
                default: EditorView()
                }
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
