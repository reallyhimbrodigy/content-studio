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
    @Published var activeChatId: String? = nil {
        didSet {
            // Remember the last real active chat so a cold relaunch can reopen
            // it to resume an in-flight render (see loadChats). Only persist
            // non-nil — a transient nil (active-chat-gone reset, deletion) must
            // not wipe the remembered chat.
            if let id = activeChatId {
                UserDefaults.standard.set(id, forKey: Self.lastActiveChatKey)
            }
        }
    }
    @Published private(set) var isLoading: Bool = false
    @Published var loadError: String? = nil

    private static let lastActiveChatKey = "lastActiveChatId"

    private var saveDebounceTask: Task<Void, Never>?
    private var pendingSaves: [String: (messages: [SerializedMessage], title: String?)] = [:]

    private init() {}

    #if DEBUG
    /// Seed a chat locally so a harness can render the REAL `EditorView` —
    /// thread, composer and all — instead of a bubble in isolation. Store
    /// screenshots have to be shipping pixels, and `chats` is otherwise only
    /// ever filled from the server, which needs a signed-in account.
    func debugSeed(_ chat: Chat) {
        chats = [chat]
        activeChatId = chat.id
    }
    #endif

    /// Reset to a clean slate. Called from AuthService.signOut so the next
    /// user on this device doesn't see the previous user's chat list
    /// lingering in memory. Cancels any in-flight save so we don't write
    /// the previous user's chats under the new user's token.
    func clearForSignOut() {
        chats = []
        UserDefaults.standard.removeObject(forKey: Self.lastActiveChatKey)
        activeChatId = nil
        isLoading = false
        loadError = nil
        saveDebounceTask?.cancel()
        saveDebounceTask = nil
        pendingSaves.removeAll()
    }

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
            //
            // Cold-relaunch resume: if nothing is active yet, reopen the last
            // active chat ONLY when it still has a render in flight — so the
            // progress bar resumes at true progress (or jumps to the finished
            // video) without waiting for a manual sidebar tap. We don't reopen
            // otherwise, to leave normal launch UX unchanged.
            if activeChatId == nil,
               let saved = UserDefaults.standard.string(forKey: Self.lastActiveChatKey),
               let chat = fetched.first(where: { $0.id == saved }),
               chat.messages.contains(where: { $0.isInFlightRender }) {
                self.activeChatId = saved
            }
            isLoading = false
            // Retry-on-launch: walk every completed message and prefetch
            // any rendered video that isn't already on disk. Closes the
            // "previous app run's eager download failed" gap. Bounded to
            // most-recent ~50 across all chats — enough to cover an
            // active user's recent history; serialized inside VideoCache
            // so it doesn't burst the network.
            prefetchUncachedVideos(limit: 50)
        } catch {
            self.loadError = error.localizedDescription
            isLoading = false
            print("[chats] loadChats failed: \(error.localizedDescription)")
        }
    }

    // The one-time client backfill for stranded (chat-less) videos was REMOVED per
    // the owner's ruling: it's a server-side migration (owner-run, verified to zero
    // before ship) — a fire-and-forget client backfill on the INVISIBLE-video cohort
    // is a silent failure by construction (no way to see it didn't run). See the
    // server migration SQL (IOS_LIBRARY_MERGE_MIGRATION.sql) + the live-leak fix
    // (flush-on-background + persistMessagesAndFlush) that stops NEW stranding.

    private func prefetchUncachedVideos(limit: Int) {
        struct Candidate { let jobId: String; let url: String }
        var queue: [Candidate] = []
        for chat in chats {
            for msg in chat.messages {
                guard let jobId = msg.jobId,
                      let url = msg.renderedVideoUrl,
                      msg.jobStatus == "completed" else { continue }
                if VideoCache.shared.localUrl(forJobId: jobId) != nil { continue }
                queue.append(Candidate(jobId: jobId, url: url))
                if queue.count >= limit { break }
            }
            if queue.count >= limit { break }
        }
        for candidate in queue {
            Task.detached(priority: .background) {
                await VideoCache.shared.downloadIfNeeded(jobId: candidate.jobId, from: candidate.url)
            }
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

    /// Create a brand new chat. Inserts into the local list but does NOT
    /// automatically set it as the active chat. Caller is responsible for
    /// the activation step — separating creation from activation lets
    /// EditorView's `ensureActiveChat()` set its `loadedChatId` BEFORE the
    /// onChange-of-activeChatId handler fires, which otherwise would
    /// clobber the in-memory messages that send() is about to populate.
    @discardableResult
    func createChat() async -> Chat? {
        do {
            let chat = try await ChatService.shared.createChat()
            self.chats.insert(chat, at: 0)
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

        // Post-first-delivery push primer (flag: push_primer; inert off). A
        // message flipping to completed-WITH-video in this save, versus the
        // prior local snapshot, is the first moment a delivered render is
        // visible to the user — every completion sink (SSE finish beat, the
        // legacy cache-then-flip, the reconcile heal, off-screen heals via
        // updateStoredMessage) persists through here, so this is the one
        // choke point. Must run BEFORE the snapshot below is overwritten,
        // and synchronously, so the legacy explainer check on the caller's
        // next line already sees the primer's claim (no double ask on the
        // same beat). PushService owns every other gate (once per install,
        // OS permission state).
        if OnboardingState.shared.pushPrimerEnabled,
           let prior = chats.first(where: { $0.id == chatId })?.messages {
            let delivered: (SerializedMessage) -> Bool = {
                $0.jobStatus == "completed" && ($0.renderedVideoUrl != nil || $0.hlsManifestUrl != nil)
            }
            let priorDelivered = Set(prior.filter(delivered).map(\.id))
            if messages.contains(where: { delivered($0) && !priorDelivered.contains($0.id) }) {
                PushService.shared.maybeOfferDeliveryPrimer()
            }
        }

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

    /// Mutate a single persisted message in any chat — even one that isn't
    /// currently on screen — then schedule a save. Used by the render dispatch
    /// to land a jobId (or a failure) on the right bubble after the user has
    /// navigated away to another chat mid-upload, so it's there on return.
    /// No-op if the chat or message isn't found.
    func updateStoredMessage(chatId: String, messageId: String, _ transform: (inout SerializedMessage) -> Void) {
        guard let cIdx = chats.firstIndex(where: { $0.id == chatId }) else { return }
        var msgs = chats[cIdx].messages
        guard let mIdx = msgs.firstIndex(where: { $0.id == messageId }) else { return }
        transform(&msgs[mIdx])
        scheduleSave(chatId: chatId, messages: msgs)
        // Live-leak fix: this path lands a jobId on an OFF-SCREEN bubble (the user
        // switched chats mid-upload). Flush immediately so that jobId reaches the
        // server even if the user never returns to that chat — the debounce alone
        // would drop it on suspend and strand the durable video_job in no chat.
        Task { [weak self] in await self?.flushNow() }
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
    /// then commits server-side; rolls back if the server rejects. Also
    /// clears any locally-cached thumbnails for this chat's messages so
    /// we don't leak disk space.
    func deleteChat(id: String) async {
        let prior = chats
        let chatToDelete = chats.first(where: { $0.id == id })
        let messageIdsToCleanup: [String] = chatToDelete?.messages.map(\.id) ?? []
        let jobIdsToCleanup: [String] = chatToDelete?.messages.compactMap { $0.jobId } ?? []
        chats.removeAll { $0.id == id }
        if activeChatId == id { activeChatId = nil }
        do {
            try await ChatService.shared.deleteChat(id: id)
            // Server delete succeeded — purge thumbnail + video disk caches
            // for this chat's messages so the user's storage doesn't leak.
            ThumbnailCache.shared.delete(forMessageIds: messageIdsToCleanup)
            for jobId in jobIdsToCleanup { VideoCache.shared.remove(jobId: jobId) }
        } catch {
            print("[chats] deleteChat \(id) failed: \(error.localizedDescription)")
            self.chats = prior
        }
    }
}
