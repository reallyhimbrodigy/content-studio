import SwiftUI

/// Sidebar content — the ChatGPT-style list of past chats with a "New
/// Chat" button at the top. Tapping a row activates that chat in the
/// editor; long-pressing a row opens a delete confirmation. Chats live
/// in Supabase; nothing here is destroyed unless the user hits delete.
struct ChatListView: View {
    @ObservedObject var store: ChatStore
    let onSelect: () -> Void  // dismiss the drawer after selection

    @State private var pendingDelete: Chat?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 12)

            Divider()
                .background(Color(.separator))

            if store.isLoading && store.chats.isEmpty {
                loading
            } else if store.chats.isEmpty {
                empty
            } else {
                list
            }
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
                    Task { await store.deleteChat(id: chat.id) }
                }
                pendingDelete = nil
            }
        } message: {
            if let chat = pendingDelete {
                Text("\"\(chat.title)\" will be permanently removed.")
            }
        }
    }

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

    private var loading: some View {
        VStack {
            Spacer()
            ProgressView().tint(.secondary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var empty: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 32))
                .foregroundColor(.secondary)
            Text("No chats yet")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.secondary)
            Text("Tap the new chat icon to start.")
                .font(.system(size: 13))
                .foregroundColor(Color(.tertiaryLabel))
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 24)
        .multilineTextAlignment(.center)
    }

    @ViewBuilder
    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(grouped, id: \.0) { (sectionTitle, chatsInSection) in
                    Text(sectionTitle)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(Color(.tertiaryLabel))
                        .textCase(.uppercase)
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .padding(.bottom, 6)

                    ForEach(chatsInSection) { chat in
                        ChatRow(
                            chat: chat,
                            isSelected: store.activeChatId == chat.id
                        ) {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            store.activeChatId = chat.id
                            onSelect()
                        }
                        .contextMenu {
                            Button(role: .destructive) {
                                pendingDelete = chat
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                }
                Color.clear.frame(height: 24)
            }
        }
    }

    /// Group chats into "Today" / "Yesterday" / "Previous 7 Days" /
    /// "Earlier" buckets — the same mental model ChatGPT uses so users
    /// can scan recent activity at a glance.
    private var grouped: [(String, [Chat])] {
        let cal = Calendar.current
        let now = Date()
        var today: [Chat] = []
        var yesterday: [Chat] = []
        var lastWeek: [Chat] = []
        var earlier: [Chat] = []

        for chat in store.chats {
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
        if !today.isEmpty       { result.append(("Today", today)) }
        if !yesterday.isEmpty   { result.append(("Yesterday", yesterday)) }
        if !lastWeek.isEmpty    { result.append(("Previous 7 Days", lastWeek)) }
        if !earlier.isEmpty     { result.append(("Earlier", earlier)) }
        return result
    }
}

private struct ChatRow: View {
    let chat: Chat
    let isSelected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Text(chat.title)
                    .font(.system(size: 15, weight: isSelected ? .semibold : .regular))
                    .foregroundColor(isSelected ? .primary : Color(.label))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(isSelected ? Color(.tertiarySystemBackground) : Color.clear)
            )
            .padding(.horizontal, 8)
        }
        .buttonStyle(.plain)
    }
}
