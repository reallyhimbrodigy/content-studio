import SwiftUI

struct MainTabView: View {
    @State private var selectedTab = 0

    var body: some View {
        VStack(spacing: 0) {
            // Content
            Group {
                switch selectedTab {
                case 0: EditorView()
                case 1: LibraryView()
                case 2: AccountView()
                default: EditorView()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Full-width tab bar — edge to edge, no floating pill
            HStack(spacing: 0) {
                TabBarButton(icon: "bubble.left.fill", label: "Edit", isSelected: selectedTab == 0) {
                    selectedTab = 0
                }
                TabBarButton(icon: "square.grid.2x2.fill", label: "Library", isSelected: selectedTab == 1) {
                    selectedTab = 1
                }
                TabBarButton(icon: "person.fill", label: "Account", isSelected: selectedTab == 2) {
                    selectedTab = 2
                }
            }
            .padding(.top, 8)
            .padding(.bottom, 2)
            .background(Color(hex: "1C1C1E"))
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(Color.white.opacity(0.06))
                    .frame(height: 0.5)
            }
        }
        .ignoresSafeArea(.keyboard)
        .background(Color(hex: "121212"))
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
                Text(label)
                    .font(.system(size: 10, weight: .medium))
            }
            .foregroundColor(isSelected ? .white : .white.opacity(0.4))
            .frame(maxWidth: .infinity)
            .frame(height: 44)
        }
    }
}
