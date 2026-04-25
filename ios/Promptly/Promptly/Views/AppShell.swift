import SwiftUI

/// Top-level shell that wraps MainTabView in a ChatGPT-style sidebar
/// drawer.
///
/// Layout decisions tuned to match ChatGPT iOS:
///   - drawer width = (screen - 56), so a thin 56pt strip of the main
///     content peeks on the right when open. The peek strip is the
///     visual cue that the rest of the app is still there + acts as
///     a tap-to-close target.
///   - main content shrinks to 0.94× anchored leading and offsets
///     right by drawerWidth. The combined effect feels like the chat
///     is being "pushed aside", not slid out from under the sidebar.
///   - tab bar (inside MainTabView) gets pushed off-screen along with
///     the content because the offset/scale apply to the whole
///     MainTabView, not just its inner content.
///
/// Gestures:
///   - Edge-swipe to open: a thin invisible strip pinned to the
///     leading edge captures DragGesture so the user can pull the
///     sidebar in from the screen edge.
///   - Drag-to-close: the full main content captures DragGesture
///     while the sidebar is open, closing on a leftward swipe.
///   - Tap-to-close: the dim overlay catches taps anywhere on the
///     visible main content.
struct AppShell: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var chatStore = ChatStore.shared

    private static let openSpring = Animation.spring(response: 0.32, dampingFraction: 0.86)
    private static let edgePeek: CGFloat = 56

    var body: some View {
        GeometryReader { geo in
            let drawerWidth = max(280, geo.size.width - Self.edgePeek)

            ZStack(alignment: .leading) {
                // Sidebar — always laid out at the leading edge. Hidden
                // behind the main content when the drawer is closed.
                ChatListView(store: chatStore) {
                    closeSidebar()
                }
                .frame(width: drawerWidth)
                .frame(maxHeight: .infinity, alignment: .topLeading)

                // Main content. Offsets right + scales when drawer opens.
                ZStack(alignment: .leading) {
                    MainTabView()
                        .frame(width: geo.size.width)
                        .background(Color(.systemBackground))

                    // Dim overlay catches taps + indicates "tap to dismiss".
                    if appState.sidebarOpen {
                        Color.black.opacity(0.32)
                            .ignoresSafeArea()
                            .contentShape(Rectangle())
                            .onTapGesture { closeSidebar() }
                            .transition(.opacity)
                    }

                    // Drag-to-close gesture while open. Captures swipes on
                    // the visible peek strip and the dim overlay.
                    if appState.sidebarOpen {
                        Color.clear
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .contentShape(Rectangle())
                            .gesture(
                                DragGesture(minimumDistance: 12)
                                    .onEnded { value in
                                        let dx = value.translation.width
                                        if dx < -60 { closeSidebar() }
                                    }
                            )
                    }
                }
                .frame(width: geo.size.width)
                .offset(x: appState.sidebarOpen ? drawerWidth : 0)
                .scaleEffect(appState.sidebarOpen ? 0.94 : 1.0, anchor: .leading)
                .clipShape(RoundedRectangle(cornerRadius: appState.sidebarOpen ? 18 : 0, style: .continuous))
                .shadow(color: .black.opacity(appState.sidebarOpen ? 0.25 : 0), radius: 24, x: -6, y: 0)

                // Edge-swipe-to-open. Only listening while drawer is closed
                // to avoid stealing scroll gestures inside the chat.
                if !appState.sidebarOpen {
                    Color.clear
                        .frame(width: 22)
                        .contentShape(Rectangle())
                        .gesture(
                            DragGesture(minimumDistance: 14)
                                .onEnded { value in
                                    let dx = value.translation.width
                                    let velocity = value.predictedEndLocation.x - value.location.x
                                    if dx > 60 || velocity > 200 {
                                        openSidebar()
                                    }
                                }
                        )
                        .frame(maxHeight: .infinity, alignment: .leading)
                }
            }
            .background(Color(.systemBackground))
        }
        .ignoresSafeArea(.keyboard)
        .task {
            if chatStore.chats.isEmpty {
                await chatStore.loadChats()
            }
        }
    }

    private func openSidebar() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        withAnimation(Self.openSpring) { appState.sidebarOpen = true }
    }

    private func closeSidebar() {
        withAnimation(Self.openSpring) { appState.sidebarOpen = false }
    }
}
