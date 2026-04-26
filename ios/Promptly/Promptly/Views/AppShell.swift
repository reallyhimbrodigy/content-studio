import SwiftUI

/// Top-level shell that wraps MainTabView in a ChatGPT-style sidebar
/// drawer.
///
/// Visual treatment matches ChatGPT iOS:
///   - drawer width = (screen − 56), so a thin 56pt strip of the main
///     content peeks on the right when open.
///   - main content scales to 0.94 anchored leading, clips to 18pt
///     rounded corners, and is desaturated + heavily dimmed while the
///     drawer is open. The desaturation + dim pair is what makes the
///     peek read as "inactive" rather than "competing for attention".
///   - tab bar (inside MainTabView) gets pushed off-screen along with
///     the content because the offset/scale apply to MainTabView, not
///     just its inner content.
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
                // Sidebar — always laid out at the leading edge.
                ChatListView(store: chatStore) { closeSidebar() }
                    .frame(width: drawerWidth)
                    .frame(maxHeight: .infinity, alignment: .topLeading)

                // Main content. Offsets right + scales + desaturates +
                // dims when the drawer opens.
                ZStack(alignment: .leading) {
                    MainTabView()
                        .frame(width: geo.size.width)
                        .background(Color(.systemBackground))
                        .saturation(appState.sidebarOpen ? 0.0 : 1.0)
                        .allowsHitTesting(!appState.sidebarOpen)

                    // Layered dim: dark scrim + ultra-thin material so
                    // the peek reads as fully inactive. Catches taps
                    // (close on tap) and gates drag-to-close.
                    if appState.sidebarOpen {
                        ZStack {
                            Color.black.opacity(0.55)
                            Rectangle().fill(.ultraThinMaterial).opacity(0.35)
                        }
                        .ignoresSafeArea()
                        .contentShape(Rectangle())
                        .onTapGesture { closeSidebar() }
                        .gesture(
                            DragGesture(minimumDistance: 12)
                                .onEnded { value in
                                    if value.translation.width < -60 { closeSidebar() }
                                }
                        )
                        .transition(.opacity)
                    }
                }
                .frame(width: geo.size.width)
                .offset(x: appState.sidebarOpen ? drawerWidth : 0)
                .scaleEffect(appState.sidebarOpen ? 0.94 : 1.0, anchor: .leading)
                .clipShape(RoundedRectangle(cornerRadius: appState.sidebarOpen ? 18 : 0, style: .continuous))
                .shadow(color: .black.opacity(appState.sidebarOpen ? 0.25 : 0), radius: 24, x: -6, y: 0)

                // Edge-swipe-to-open. Only listening while drawer is closed
                // so we don't fight scroll gestures inside the chat.
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
        .onChange(of: appState.sidebarOpen) { _, isOpen in
            // Keyboard always dismisses on drawer open. We dismiss on
            // close too so a stale focus from the sidebar's search
            // field doesn't pop the keyboard back when the user lands
            // on the editor.
            EditorView.dismissKeyboard()
            if isOpen {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                // Re-pull whenever the sidebar opens, so a chat created
                // on another device (or just-applied SQL migration)
                // shows up without needing to relaunch the app.
                Task { await chatStore.loadChats() }
            }
        }
        // Auto-retry on app foreground. Common case: user just ran
        // the chats migration in their browser and tabbed back to the
        // app — the cached "404 / table missing" error should clear
        // automatically on focus, not require a manual "Try again".
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            Task { await chatStore.loadChats() }
        }
        .task {
            if chatStore.chats.isEmpty {
                await chatStore.loadChats()
            }
        }
    }

    private func openSidebar() {
        withAnimation(Self.openSpring) { appState.sidebarOpen = true }
    }

    private func closeSidebar() {
        withAnimation(Self.openSpring) { appState.sidebarOpen = false }
    }
}
