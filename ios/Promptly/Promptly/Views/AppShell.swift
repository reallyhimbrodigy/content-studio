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
/// Gestures (build 180 rewrite — was a 22pt edge strip + plain
/// .gesture, both of which felt unreliable):
///   - Open: horizontal-dominant right-swipe starting ANYWHERE on the
///     main content. Direction-locked so vertical scrolls in the
///     chat list still work. Live-tracks the finger.
///   - Close: horizontal-dominant left-swipe starting anywhere on the
///     open sidebar. Live-tracks. Uses .simultaneousGesture so it
///     coexists with List row taps + swipe-to-delete instead of
///     swallowing them.
///   - Tap-to-close: chat selection / new-chat / avatar all auto-close
///     via the `onSelect` callback the sidebar already calls.
struct AppShell: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var chatStore = ChatStore.shared
    @ObservedObject private var authGate = AuthGate.shared
    // @Observable, not ObservableObject — SwiftUI tracks it directly.
    @State private var auth = AuthService.shared

    private static let openSpring = Animation.spring(response: 0.32, dampingFraction: 0.86)

    /// Width of the leading edge zone that opens the drawer. Narrow + deliberate
    /// (iOS system-edge-swipe scale) so it never competes with horizontal content
    /// like the composer's preset-chip scroller — a chip swipe starts mid-screen,
    /// outside this zone, so it scrolls freely with zero drawer movement (Bug A).
    private static let edgeSwipeZone: CGFloat = 20

    /// Tracks the user's in-flight swipe in points. Positive when
    /// pulling the drawer open from a closed state, negative when
    /// dragging the drawer closed from an open state. Zero when no
    /// drag is active or after the gesture commits/cancels. Driven
    /// by .onChanged so the drawer follows the finger in real time —
    /// snap-on-release felt non-interactive vs. ChatGPT.
    @State private var sidebarDragX: CGFloat = 0

    var body: some View {
        GeometryReader { geo in
            let drawerWidth = geo.size.width

            ZStack(alignment: .leading) {
                // Sidebar — always laid out at the leading edge, full width.
                // .simultaneousGesture so the close drag coexists with the
                // List's row taps (a plain .gesture was swallowing some
                // taps because it had higher priority than children).
                ChatListView(store: chatStore) { closeSidebar() }
                    .frame(width: drawerWidth)
                    .frame(maxHeight: .infinity, alignment: .topLeading)
                    .simultaneousGesture(closeSwipeGesture)

                // Main content. Slides fully off-screen to the right.
                // The applied offset = open-state base + active drag,
                // clamped to [0, drawerWidth] so a fling can't overshoot
                // or invert.
                //
                // Open-swipe lives ONLY in a narrow leading edge strip (the
                // .overlay below), NOT the whole surface. Build 213 shipped a
                // full-surface .simultaneousGesture for "swipe anywhere" reach,
                // but that (a) fired on the composer's horizontal chip scroll,
                // creeping the drawer open (Bug A), and (b) ran simultaneously
                // with the content under the finger, so the chat panned with the
                // drawer (Bug B). Zac's directive: open via hamburger + a
                // deliberate leading-edge swipe only.
                MainTabView()
                    .frame(width: geo.size.width)
                    .background(Color(.systemBackground))
                    // Inert while the drawer is open AND while ANY drawer drag is
                    // in flight (sidebarDragX != 0). The edge strip owns the
                    // open-drag exclusively; this guarantees the content receives
                    // nothing for that touch's whole lifecycle — no bleed-through
                    // to the chat underneath (Bug B). Applied BEFORE the overlay,
                    // so the strip's own gesture is unaffected by this gate.
                    .allowsHitTesting(!appState.sidebarOpen && sidebarDragX == 0)
                    .offset(x: max(0, min(drawerWidth, (appState.sidebarOpen ? drawerWidth : 0) + sidebarDragX)))
                    .shadow(
                        color: .black.opacity(appState.sidebarOpen ? 0.35 : 0),
                        radius: 24, x: -8, y: 0
                    )
                    // Leading edge-swipe zone. Exclusive .gesture (NOT
                    // .simultaneousGesture) so the edge drag captures the touch
                    // and the chat never pans with it. Present only on the Edit
                    // tab while closed; the drawer's own List owns the close drag.
                    // Inset from the top (build 216) so it clears the custom top
                    // bar — the hamburger's tap target is never eaten by the strip.
                    .overlay(alignment: .leading) {
                        if appState.selectedTab == 0 && !appState.sidebarOpen {
                            Color.clear
                                .frame(width: Self.edgeSwipeZone)
                                .frame(maxHeight: .infinity)
                                .contentShape(Rectangle())
                                .gesture(openSwipeGesture)
                                .padding(.top, 104)
                        }
                    }
            }
            .background(Color(.systemBackground))
        }
        .ignoresSafeArea(.keyboard)
        // Paywall presentation. Any view can request it by setting
        // AppState.shared.paywallReason; the sheet rises and clears the
        // reason on dismiss.
        // DEFERRED AUTH — the account ask, at the action that needs one.
        //
        // Anchored on AppShell rather than at each call site: purchase, export
        // and profile writes all funnel through AuthGate, and a per-site sheet
        // would mean a surface could raise the requirement and forget to
        // present it. On success the pending intent is REPLAYED, so the user
        // lands back in what they were doing instead of at the start.
        .sheet(isPresented: Binding(
            get: { authGate.isPresenting },
            set: { if !$0 { authGate.cancel() } }
        )) {
            AuthView()
                .onAppear {
                    Analytics.track("signup_start", props: ["step": "auth_gate"])
                }
        }
        .onChange(of: auth.isAuthenticated) { _, authed in
            guard authed, let intent = authGate.takePending() else { return }
            authGate.resume(intent)
        }
        .sheet(
            isPresented: Binding(
                get: { appState.paywallReason != nil },
                set: { if !$0 { appState.dismissPaywall() } }
            )
        ) {
            if let reason = appState.paywallReason {
                UpgradePaywall(
                    isPresented: Binding(
                        get: { appState.paywallReason != nil },
                        set: { if !$0 { appState.dismissPaywall() } }
                    ),
                    reason: reason
                )
            }
        }
        // The trial WALL (distinct from the upgrade paywall): a full-screen
        // cover so an enforced `.none` account reaches no usable screen when it
        // hits a gated door post-flip (APIError.wallRequired → presentWall()).
        // Inert while the wall knob is off. Passing only when trial/Pro starts.
        .fullScreenCover(isPresented: $appState.wallPresented) {
            TrialWallView(context: .door) {
                appState.dismissWall()
            }
        }
        // Sidebar-restructure: Account is a sheet opened from the drawer. The Library
        // was DELETED — every video now lives permanently in its own chat, so there is
        // no separate grid to browse. Edit stays the full-screen surface.
        .sheet(isPresented: Binding(
            get: { appState.showAccount },
            set: { appState.showAccount = $0 }
        )) {
            AccountView()
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

    /// Right-swipe anywhere on the main content opens the sidebar.
    /// Direction-locked to horizontal-dominant drags so it doesn't
    /// fight with the vertical scrolls inside the chat list. Live-
    /// tracks the finger via sidebarDragX → main offset, so the
    /// drawer creeps in proportional to the drag. Commits on
    /// release past 50pt OR with rightward velocity > 200pt/s
    /// (lowered from 60pt/300 so short fast flicks register too).
    private var openSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .local)
            .onChanged { value in
                // Chat sidebar belongs to the Edit tab only. On Library (1) /
                // Account (2) a right-swipe must NOT pull it open. Both handlers
                // gate on this — .onEnded computes shouldOpen independently, so
                // guarding only .onChanged would still let a flick commit.
                guard !appState.sidebarOpen, appState.selectedTab == 0 else { return }
                let dx = value.translation.width
                let dy = value.translation.height
                // Direction lock — vertical scrolls in chat / library
                // must keep working. If the drag is vertical-dominant
                // we don't move the drawer, but the gesture stays
                // alive so a curve into a horizontal direction can
                // still pick up.
                guard abs(dx) > abs(dy) else { return }
                // Right-only — left drags on closed main are no-ops.
                guard dx > 0 else { return }
                sidebarDragX = dx
            }
            .onEnded { value in
                guard !appState.sidebarOpen, appState.selectedTab == 0 else {
                    sidebarDragX = 0
                    return
                }
                let dx = value.translation.width
                let velocityX = value.predictedEndLocation.x - value.location.x
                let horizontalDominant = abs(dx) >= abs(value.translation.height)
                let shouldOpen = horizontalDominant && (dx > 50 || velocityX > 200)
                withAnimation(Self.openSpring) {
                    sidebarDragX = 0
                    if shouldOpen {
                        appState.sidebarOpen = true
                    }
                }
            }
    }

    /// Left-swipe anywhere on the open sidebar closes it. Direction-
    /// locked so vertical scrolls in the chat list keep working.
    /// Live-tracks the finger. Same generous commit thresholds as
    /// open: 50pt distance OR 200pt/s leftward velocity.
    private var closeSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .local)
            .onChanged { value in
                guard appState.sidebarOpen else { return }
                let dx = value.translation.width
                let dy = value.translation.height
                guard abs(dx) > abs(dy) else { return }
                guard dx < 0 else { return }  // left-only
                sidebarDragX = dx
            }
            .onEnded { value in
                guard appState.sidebarOpen else {
                    sidebarDragX = 0
                    return
                }
                let dx = value.translation.width
                let velocityX = value.predictedEndLocation.x - value.location.x
                let horizontalDominant = abs(dx) >= abs(value.translation.height)
                let shouldClose = horizontalDominant && (dx < -50 || velocityX < -200)
                withAnimation(Self.openSpring) {
                    sidebarDragX = 0
                    if shouldClose {
                        appState.sidebarOpen = false
                    }
                }
            }
    }
}
