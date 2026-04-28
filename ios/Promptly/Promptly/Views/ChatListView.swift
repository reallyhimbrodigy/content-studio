import SwiftUI

/// Sidebar UI. Tuned to feel like ChatGPT's iOS sidebar:
///   - rounded search field at the top, native-feeling placeholder
///   - chat rows with title + one-line preview
///   - subtle selected-state (light tinted background, no heavy fill)
///   - swipe-to-delete on rows + context-menu fallback
///   - sticky profile chip pinned to the bottom of the drawer
struct ChatListView: View {
    @ObservedObject var store: ChatStore
    let onSelect: () -> Void

    @State private var pendingDelete: Chat?
    @State private var search: String = ""
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 12)
                .padding(.bottom, 10)

            searchField
                .padding(.horizontal, 14)
                .padding(.bottom, 8)

            Divider()
                .background(Color(.separator).opacity(0.5))

            // Body
            ZStack {
                if store.isLoading && store.chats.isEmpty {
                    loadingView
                } else if let err = store.loadError, store.chats.isEmpty {
                    errorState(err)
                } else if filtered.isEmpty {
                    if search.isEmpty {
                        emptyView
                    } else {
                        noMatchesView
                    }
                } else {
                    chatScroll
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Tapping anywhere in the chat-list area dismisses the
            // search keyboard. Goes through Keyboard.dismiss() for the
            // synchronous, non-jumpy hide path; clearing searchFocused
            // keeps the @FocusState in sync.
            .simultaneousGesture(
                TapGesture().onEnded {
                    searchFocused = false
                    Keyboard.dismiss()
                }
            )

            Divider()
                .background(Color(.separator).opacity(0.5))

            profileChip
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Color(.systemBackground))
        .alert(
            "Delete chat?",
            isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            )
        ) {
            Button("Cancel", role: .cancel) { pendingDelete = nil }
            Button("Delete", role: .destructive) {
                if let chat = pendingDelete {
                    UINotificationFeedbackGenerator().notificationOccurred(.warning)
                    Task { await store.deleteChat(id: chat.id) }
                }
                pendingDelete = nil
            }
        } message: {
            if let chat = pendingDelete {
                Text("\"\(chat.title)\" will be permanently removed. This can't be undone.")
            }
        }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 10) {
            Text("Chats")
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.primary)
            Spacer()
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                Task {
                    if let chat = await store.createChat() {
                        store.activeChatId = chat.id
                        onSelect()
                    }
                }
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(.primary)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("New chat")
        }
    }

    // MARK: - Search field

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(Color(.tertiaryLabel))
            TextField("Search chats", text: $search)
                .focused($searchFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled(true)
                .submitLabel(.search)
                .foregroundColor(.primary)
                .font(.system(size: 15))
            if !search.isEmpty {
                Button {
                    search = ""
                    searchFocused = false
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundColor(Color(.tertiaryLabel))
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(.tertiarySystemFill))
        )
    }

    // MARK: - Body states

    private var loadingView: some View {
        ProgressView().tint(.secondary)
    }

    private var emptyView: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 30))
                .foregroundColor(Color(.tertiaryLabel))
            Text("No chats yet")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.secondary)
            Text("Tap the new chat icon to start.")
                .font(.system(size: 13))
                .foregroundColor(Color(.tertiaryLabel))
        }
        .padding(.horizontal, 24)
        .multilineTextAlignment(.center)
    }

    /// Backend-error state. The most common cause is "the chats table
    /// doesn't exist yet" — Supabase returns 404 from PostgREST for
    /// tables it doesn't know about. We detect that case (404 in the
    /// message) and surface a one-tap fix: copy the migration SQL,
    /// open the Supabase dashboard, paste, run.
    private func errorState(_ message: String) -> some View {
        let isMissingTable = message.contains("404")
        return VStack(spacing: 12) {
            Image(systemName: isMissingTable ? "wrench.and.screwdriver" : "exclamationmark.triangle")
                .font(.system(size: 30))
                .foregroundColor(.orange)
            Text(isMissingTable ? "Chat sync needs setup" : "Can't load chats")
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.primary)
            Text(isMissingTable
                 ? "Run the chats migration in Supabase, then come back."
                 : message)
                .font(.system(size: 12))
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .padding(.horizontal, 12)

            if isMissingTable {
                VStack(spacing: 8) {
                    Button {
                        UIPasteboard.general.string = Self.chatsMigrationSQL
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    } label: {
                        Label("Copy migration SQL", systemImage: "doc.on.doc")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.regular)

                    Button {
                        if let url = URL(string: "https://supabase.com/dashboard/project/ejxkzsfruykvgeouymfy/sql/new") {
                            UIApplication.shared.open(url)
                        }
                    } label: {
                        Label("Open Supabase SQL editor", systemImage: "arrow.up.right.square")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.regular)

                    Button {
                        Task { await store.loadChats() }
                    } label: {
                        Text("I've run it — try again")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(.secondary)
                    }
                    .padding(.top, 4)
                }
            } else {
                Button {
                    Task { await store.loadChats() }
                } label: {
                    Text("Try again")
                        .font(.system(size: 14, weight: .medium))
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .padding(.top, 4)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 24)
    }

    /// Inlined for one-tap copy. Mirrors `migrations/2026-04-25-chats.sql`.
    private static let chatsMigrationSQL = """
    CREATE TABLE IF NOT EXISTS chats (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL DEFAULT 'New Chat',
      messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS chats_user_updated_idx
      ON chats (user_id, updated_at DESC);

    ALTER TABLE chats ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "chats_select_own"   ON chats;
    DROP POLICY IF EXISTS "chats_insert_own"   ON chats;
    DROP POLICY IF EXISTS "chats_update_own"   ON chats;
    DROP POLICY IF EXISTS "chats_delete_own"   ON chats;

    CREATE POLICY "chats_select_own" ON chats
      FOR SELECT USING (auth.uid() = user_id);
    CREATE POLICY "chats_insert_own" ON chats
      FOR INSERT WITH CHECK (auth.uid() = user_id);
    CREATE POLICY "chats_update_own" ON chats
      FOR UPDATE USING (auth.uid() = user_id);
    CREATE POLICY "chats_delete_own" ON chats
      FOR DELETE USING (auth.uid() = user_id);

    CREATE OR REPLACE FUNCTION touch_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS chats_touch_updated_at ON chats;
    CREATE TRIGGER chats_touch_updated_at
      BEFORE UPDATE ON chats
      FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
    """

    private var noMatchesView: some View {
        VStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 26))
                .foregroundColor(Color(.tertiaryLabel))
            Text("No results")
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.secondary)
            Text("No chats match \"\(search)\".")
                .font(.system(size: 12))
                .foregroundColor(Color(.tertiaryLabel))
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 24)
    }

    // MARK: - Chat list

    private var chatScroll: some View {
        List {
            ForEach(grouped, id: \.0) { (sectionTitle, chatsInSection) in
                Section {
                    ForEach(chatsInSection) { chat in
                        ChatRow(
                            chat: chat,
                            isSelected: store.activeChatId == chat.id
                        ) {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            store.activeChatId = chat.id
                            onSelect()
                        }
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                        // swipeActions only fires inside a List — that's
                        // why we converted away from LazyVStack. Outside
                        // List it compiles but is a no-op.
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                pendingDelete = chat
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                pendingDelete = chat
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    Text(sectionTitle)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(Color(.tertiaryLabel))
                        .tracking(0.4)
                        .padding(.leading, 10)
                        .padding(.top, 8)
                        .padding(.bottom, 4)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
                }
                .textCase(nil)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(Color(.systemBackground))
        .animation(.spring(response: 0.35, dampingFraction: 0.86), value: store.chats.map(\.id))
    }

    // Filter + group
    private var filtered: [Chat] {
        guard !search.isEmpty else { return store.chats }
        let q = search.lowercased()
        return store.chats.filter {
            $0.title.lowercased().contains(q) || $0.preview.lowercased().contains(q)
        }
    }

    private var grouped: [(String, [Chat])] {
        let cal = Calendar.current
        let now = Date()
        var today: [Chat] = []
        var yesterday: [Chat] = []
        var lastWeek: [Chat] = []
        var earlier: [Chat] = []
        for chat in filtered {
            if cal.isDateInToday(chat.updatedAt) {
                today.append(chat)
            } else if cal.isDateInYesterday(chat.updatedAt) {
                yesterday.append(chat)
            } else if let days = cal.dateComponents([.day], from: chat.updatedAt, to: now).day, days <= 7 {
                lastWeek.append(chat)
            } else {
                earlier.append(chat)
            }
        }
        var result: [(String, [Chat])] = []
        if !today.isEmpty     { result.append(("Today", today)) }
        if !yesterday.isEmpty { result.append(("Yesterday", yesterday)) }
        if !lastWeek.isEmpty  { result.append(("Previous 7 Days", lastWeek)) }
        if !earlier.isEmpty   { result.append(("Earlier", earlier)) }
        return result
    }

    // MARK: - Profile chip

    private var profileChip: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            // Bounce to Account tab. Sidebar dismisses via onSelect callback
            // so the user lands on the destination.
            AppState.shared.selectedTab = 2
            onSelect()
        } label: {
            HStack(spacing: 12) {
                ZStack {
                    Circle()
                        .fill(Color(.tertiarySystemBackground))
                        .frame(width: 36, height: 36)
                    Text(initial)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundColor(.primary)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(displayName)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.primary)
                        .lineLimit(1)
                    Text(emailDisplay)
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Image(systemName: "ellipsis")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(Color(.tertiaryLabel))
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Account")
        .accessibilityValue("\(displayName), \(emailDisplay)")
        .accessibilityHint("Opens account settings")
    }

    private var emailDisplay: String {
        AuthService.shared.currentUser?.email ?? "Signed in"
    }

    private var displayName: String {
        if let name = AuthService.shared.currentUser?.user_metadata?.full_name, !name.isEmpty {
            return name
        }
        if let email = AuthService.shared.currentUser?.email {
            return String(email.split(separator: "@").first ?? "")
        }
        return "Account"
    }

    private var initial: String {
        let name = displayName
        guard let first = name.first else { return "?" }
        return String(first).uppercased()
    }
}

// MARK: - Row

private struct ChatRow: View {
    let chat: Chat
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 3) {
                Text(chat.title)
                    .font(.system(size: 15, weight: isSelected ? .semibold : .regular))
                    .foregroundColor(.primary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if !chat.preview.isEmpty && chat.preview != chat.title {
                    Text(chat.preview)
                        .font(.system(size: 12))
                        .foregroundColor(Color(.tertiaryLabel))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isSelected
                          ? Color.primary.opacity(0.08)
                          : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(chat.title)
        .accessibilityHint(chat.preview.isEmpty ? "" : chat.preview)
        .accessibilityAddTraits(isSelected ? [.isSelected, .isButton] : .isButton)
    }
}
