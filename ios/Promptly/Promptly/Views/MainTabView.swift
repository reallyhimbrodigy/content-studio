import SwiftUI

/// The primary surface. Sidebar-restructure (2026-07-24): the bottom Edit/Library/
/// Account tab bar was removed — Edit is now the sole full-screen surface, and
/// Library + Account are sheets opened from the drawer (AppShell). The struct name
/// is kept so AppShell's call site doesn't churn.
struct MainTabView: View {
    var body: some View {
        EditorView()
            .ignoresSafeArea(.keyboard)
            .background(Color(.systemBackground))
    }
}
