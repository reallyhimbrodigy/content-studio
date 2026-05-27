import SwiftUI

/// Top-level shell that wraps MainTabView in a ChatGPT-style sidebar.
///
/// Visual treatment matches ChatGPT iOS:
///   - Sidebar takes the FULL screen width when open — no peek of the
///     main content. Reads as a destination, not a drawer.
///   - Main content slides fully off-screen to the right while the
///     sidebar is open. No scale/desaturate gimmickry needed since
///     nothing's visible to dim.
///
/// Gestures:
///   - Edge-swipe to open: a thin invisible strip pinned to the
///     leading edge captures DragGesture so the user can pull the
///     sidebar in from the screen edge.
///   - Swipe-left-to-close: any leftward swipe on the sidebar itself
///     dismisses. Mirrors ChatGPT's behavior.
///   - Tap-to-close: chat selection / new-chat / avatar all auto-close
///     via the `onSelect` callback the sidebar already calls.
struct AppShell: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var chatStore = ChatStore.shared

    private static let openSpring = Animation.spring(response: 0.32, dampingFraction: 0.86)

    var body: some View {
        GeometryReader { geo in
            let drawerWidth = geo.size.width

            ZStack(alignment: .leading) {
                // Sidebar — always laid out at the leading edge, full width.
                ChatListView(store: chatStore) { closeSidebar() }
                    .frame(width: drawerWidth)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    // Swipe-left-anywhere on the sidebar to dismiss.
                    // Only listens while open so we don't interfere with
                    // List's internal swipe-to-delete on chat rows when
                    // they're tapped (chat-row swipe is right-to-left
                    // and short; this gesture requires 60pt of travel).
                    .gesture(
                        appState.sidebarOpen
                        ? DragGesture(minimumDistance: 18)
                            .onEnded { value in
                                if value.translation.width < -60 { closeSidebar() }
                            }
                        : nil
                    )

                // Main content. Slides fully off-screen to the right.
                MainTabView()
                    .frame(width: geo.size.width)
                    .background(Color(.systemBackground))
                    .allowsHitTesting(!appState.sidebarOpen)
                    .offset(x: appState.sidebarOpen ? drawerWidth : 0)
                    .shadow(
                        color: .black.opacity(appState.sidebarOpen ? 0.35 : 0),
                        radius: 24, x: -8, y: 0
                    )

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
        // Paywall presentation. Any view can request it by setting
        // AppState.shared.paywallReason; the sheet rises and clears the
        // reason on dismiss.
        .sheet(
            isPresented: Binding(
                get: { appState.paywallReason != nil },
                set: { if !$0 { appState.paywallReason = nil } }
            )
        ) {
            if let reason = appState.paywallReason {
                PaywallView(
                    isPresented: Binding(
                        get: { appState.paywallReason != nil },
                        set: { if !$0 { appState.paywallReason = nil } }
                    ),
                    reason: reason
                )
            }
        }
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
