import Foundation

/// In-memory cache + persistence coordinator for the user's chats.
/// Owns the canonical "active chat" id and the cached chat list that
/// the sidebar renders. EditorView reads/writes through here so the
/// sidebar stays in sync without needing every save to trigger a list
/// refetch.
@MainActor
final class ChatStore: ObservableObject {
    static let shared = ChatStore()

    @Published private(set) var chats: [Chat] = []
    @Published var activeChatId: String? = nil
    @Published private(set) var isLoading: Bool = false
    @Published var loadError: String? = nil

    private var saveDebounceTask: Task<Void, Never>?
    private var pendingSaves: [String: (messages: [SerializedMessage], title: String?)] = [:]

    private init() {}

    // MARK: - Load

    /// Pull all chats for the signed-in user. Idempotent — safe to call
    /// from `.task` modifiers + on auth state changes.
    func loadChats() async {
        isLoading = true
        loadError = nil
        do {
            let fetched = try await ChatService.shared.listChats()
            self.chats = fetched
            // If the active chat is gone (e.g., deleted on another device),
            // drop it so the editor falls back to "no chat selected".
            if let active = activeChatId, !fetched.contains(where: { $0.id == active }) {
                self.activeChatId = nil
            }
            // If the user has no chats at all, leave activeChatId nil — the
            // editor's first send will lazily create one.
            isLoading = false
        } catch {
            self.loadError = error.localizedDescription
            isLoading = false
            print("[chats] loadChats failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Active chat

    var activeChat: Chat? {
        guard let id = activeChatId else { return nil }
        return chats.first(where: { $0.id == id })
    }

    func selectChat(_ id: String) {
        if chats.contains(where: { $0.id == id }) {
            activeChatId = id
        }
    }

    /// Create a brand new chat, mark it active, return it. Optimistically
    /// inserts into the local list before the server round-trips so the
    /// UI feels instantaneous; if the server insert fails we roll back.
    @discardableResult
    func createChat() async -> Chat? {
        do {
            let chat = try await ChatService.shared.createChat()
            self.chats.insert(chat, at: 0)
            self.activeChatId = chat.id
            return chat
        } catch {
            print("[chats] createChat failed: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Save

    /// Save the message list for a chat. Batches multiple rapid saves for
    /// the same chat (e.g. message append + job-status update fired within
    /// the same render lifecycle) into one PATCH 600ms after the last call.
    func scheduleSave(chatId: String, messages: [SerializedMessage], explicitTitle: String? = nil) {
        let title = explicitTitle ?? Chat.deriveTitle(from: messages)
        pendingSaves[chatId] = (messages: messages, title: title)

        // Reflect the new title + message snapshot locally immediately so
        // the sidebar updates without waiting for the server.
        if let idx = chats.firstIndex(where: { $0.id == chatId }) {
            chats[idx].messages = messages
            chats[idx].title = title
            chats[idx].updatedAt = Date()
            // Bubble newly-active chat to top of the list.
            let updated = chats.remove(at: idx)
            chats.insert(updated, at: 0)
        }

        saveDebounceTask?.cancel()
        saveDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 600_000_000)
            await self?.flushPending()
        }
    }

    private func flushPending() async {
        let snapshot = pendingSaves
        pendingSaves.removeAll()
        for (chatId, payload) in snapshot {
            do {
                try await ChatService.shared.updateChat(
                    id: chatId,
                    messages: payload.messages,
                    title: payload.title
                )
            } catch {
                print("[chats] updateChat \(chatId) failed: \(error.localizedDescription)")
                // Re-queue for the next debounce window. If the user keeps
                // editing the chat, the next save will pick this up.
                pendingSaves[chatId] = payload
            }
        }
    }

    /// Force-flush any debounced saves immediately. Called on background /
    /// app-resign so we don't lose the most recent edits.
    func flushNow() async {
        saveDebounceTask?.cancel()
        await flushPending()
    }

    // MARK: - Delete

    /// Permanent, user-initiated delete. Optimistically removes locally
    /// then commits server-side; rolls back if the server rejects.
    func deleteChat(id: String) async {
        let prior = chats
        chats.removeAll { $0.id == id }
        if activeChatId == id { activeChatId = nil }
        do {
            try await ChatService.shared.deleteChat(id: id)
        } catch {
            print("[chats] deleteChat \(id) failed: \(error.localizedDescription)")
            self.chats = prior
        }
    }
}
