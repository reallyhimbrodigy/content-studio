import SwiftUI

/// Top-level shell that wraps MainTabView in a ChatGPT-style sidebar
/// drawer. Drives drawer state from AppState.sidebarOpen so EditorView's
/// hamburger button can open/close it without binding plumbing.
///
/// Layout: a ZStack with the sidebar pinned to the left edge (always
/// laid out, just hidden behind the main content when closed) and the
/// main content offsetting right + dimming when open. Tap-on-dim or
/// any chat-row tap calls back to `dismiss` to slide the drawer shut.
struct AppShell: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var chatStore = ChatStore.shared

    private static let drawerWidth: CGFloat = 300
    private static let openSpring = Animation.spring(response: 0.32, dampingFraction: 0.86)

    var body: some View {
        ZStack(alignment: .leading) {
            ChatListView(store: chatStore) {
                close()
            }
            .frame(width: Self.drawerWidth)
            .frame(maxHeight: .infinity, alignment: .topLeading)

            MainTabView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemBackground))
                .offset(x: appState.sidebarOpen ? Self.drawerWidth : 0)
                .scaleEffect(appState.sidebarOpen ? 0.96 : 1.0, anchor: .leading)
                .overlay {
                    if appState.sidebarOpen {
                        Color.black.opacity(0.32)
                            .ignoresSafeArea()
                            .contentShape(Rectangle())
                            .onTapGesture { close() }
                            .transition(.opacity)
                    }
                }
                // Disable interaction with main content when the sidebar
                // is open — prevents accidental taps bleeding through to
                // the editor while the user is browsing chats.
                .allowsHitTesting(!appState.sidebarOpen || true)  // overlay catches taps when open
        }
        .background(Color(.systemBackground))
        .task {
            if chatStore.chats.isEmpty {
                await chatStore.loadChats()
            }
        }
    }

    private func close() {
        withAnimation(Self.openSpring) {
            appState.sidebarOpen = false
        }
    }
}
