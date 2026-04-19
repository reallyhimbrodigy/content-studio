import SwiftUI

struct MainTabView: View {
    @State private var selectedTab = 0

    var body: some View {
        ZStack(alignment: .bottom) {
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

            // Custom tab bar
            CustomTabBar(selectedTab: $selectedTab)
        }
        .ignoresSafeArea(.keyboard)
    }
}

struct CustomTabBar: View {
    @Binding var selectedTab: Int

    private let tabs: [(icon: String, filledIcon: String, label: String)] = [
        ("bubble.left", "bubble.left.fill", "Edit"),
        ("square.grid.2x2", "square.grid.2x2.fill", "Library"),
        ("person", "person.fill", "Account")
    ]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(0..<tabs.count, id: \.self) { index in
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        selectedTab = index
                    }
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: selectedTab == index ? tabs[index].filledIcon : tabs[index].icon)
                            .font(.system(size: 22))

                        Text(tabs[index].label)
                            .font(.system(size: 10, weight: .medium))
                    }
                    .foregroundColor(selectedTab == index ? Color(hex: "3B82F6") : .white.opacity(0.4))
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                }
                .sensoryFeedback(.selection, trigger: selectedTab)
            }
        }
        .padding(.top, 8)
        .padding(.bottom, 2)
        .background(
            Color(hex: "1C1C1E")
                .shadow(color: .black.opacity(0.3), radius: 8, y: -2)
                .ignoresSafeArea(edges: .bottom)
        )
    }
}
