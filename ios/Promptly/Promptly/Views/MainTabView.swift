import SwiftUI

struct MainTabView: View {
    @State private var selectedTab = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            EditorView()
                .tabItem {
                    Label("Edit", systemImage: "bubble.left.fill")
                }
                .tag(0)

            LibraryView()
                .tabItem {
                    Label("Library", systemImage: "square.grid.2x2.fill")
                }
                .tag(1)

            AccountView()
                .tabItem {
                    Label("Account", systemImage: "person.fill")
                }
                .tag(2)
        }
        .sensoryFeedback(.selection, trigger: selectedTab)
    }
}
