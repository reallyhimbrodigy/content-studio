import SwiftUI
import PhotosUI
import UIKit

struct EditorView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var chatStore = ChatStore.shared
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var showVideoPicker = false
    @State private var pendingVideos: [PendingVideo] = []
    @State private var isSending = false
    @State private var conversationHistory: [[String: String]] = []
    @State private var sseClients: [String: SSEClient] = [:]
    @State private var reeditSession: ReeditSession?
    @State private var loadedChatId: String? = nil
    @FocusState private var isInputFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if messages.isEmpty && pendingVideos.isEmpty {
                    emptyState
                } else {
                    messagesList
                }

                if !pendingVideos.isEmpty {
                    pendingAttachments
                }

                reeditChip

                vibeChipsBar

                inputBar
            }
            .background(Color(.systemBackground))
            .navigationTitle(chatStore.activeChat?.title ?? "Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(.systemBackground), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Self.dismissKeyboard()
                        isInputFocused = false
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
                            appState.sidebarOpen.toggle()
                        }
                    } label: {
                        Image(systemName: "sidebar.leading")
                            .font(.system(size: 17, weight: .semibold))
                    }
                    .tint(.white)
                    .buttonStyle(.plain)
                    .accessibilityLabel("Show chats")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        Self.dismissKeyboard()
                        Task { await startNewChat() }
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.system(size: 17, weight: .semibold))
                    }
                    .tint(.white)
                    .buttonStyle(.plain)
                    .accessibilityLabel("New chat")
                }
            }
            .sheet(isPresented: $showVideoPicker) {
                NativeVideoPicker(maxSelection: 10) { videos in
                    handlePickedVideos(videos)
                }
                .ignoresSafeArea()
            }
            .onAppear {
                // Pick up any pending re-edit session posted by Library and consume it.
                if let pending = appState.pendingReedit {
                    reeditSession = pending
                    appState.pendingReedit = nil
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    isInputFocused = true
                }
            }
            .task {
                // Pull chat history once per session so the sidebar populates
                // even if the user never opens it. Idempotent in ChatStore.
                if chatStore.chats.isEmpty {
                    await chatStore.loadChats()
                }
            }
            .onChange(of: appState.pendingReedit) { _, newSession in
                if let s = newSession {
                    reeditSession = s
                    appState.pendingReedit = nil
                    isInputFocused = true
                }
            }
            .onChange(of: chatStore.activeChatId) { oldId, newId in
                handleActiveChatChange(oldId: oldId, newId: newId)
            }
        }
    }

    // MARK: - Keyboard

    /// Force-resign whatever responder currently owns the keyboard.
    /// `@FocusState` mutations inside `withAnimation` are unreliable
    /// because the animation transaction defers the state write —
    /// dropping straight to UIKit guarantees the keyboard hides
    /// synchronously regardless of SwiftUI's focus bookkeeping.
    static func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil, from: nil, for: nil
        )
    }

    // MARK: - Chat persistence wiring

    /// Called whenever the user picks a different chat in the sidebar (or
    /// the sidebar's "+" creates one). Saves the current chat's messages
    /// before swapping, then loads the new chat's history into the local
    /// `messages` state and rebuilds conversationHistory for chat-API calls.
    private func handleActiveChatChange(oldId: String?, newId: String?) {
        // Skip the load when we've already loaded this chat — `ensureActiveChat`
        // and `startNewChat` set `loadedChatId` before flipping
        // `chatStore.activeChatId`, so the onChange firing is purely
        // cosmetic in those paths. Without this guard, lazy-creating a
        // chat during send() would clobber the in-flight `messages`
        // (the user-message + processing-message we just appended).
        if let newId, newId == loadedChatId { return }

        // Persist whatever was on screen for the old chat before switching.
        if let oldId = oldId, oldId != newId {
            persistMessagesNow(chatId: oldId)
        }
        // Tear down any in-flight SSE connections — they belonged to the old chat.
        sseClients.values.forEach { $0.disconnect() }
        sseClients.removeAll()

        guard let newId = newId, let chat = chatStore.chats.first(where: { $0.id == newId }) else {
            messages = []
            conversationHistory = []
            loadedChatId = nil
            return
        }
        let restored = chat.messages.map { $0.toChatMessage() }
        messages = restored
        conversationHistory = restored.compactMap { msg in
            if msg.role == .user, !msg.content.isEmpty {
                return ["role": "user", "content": msg.content]
            }
            if msg.role == .assistant, !msg.content.isEmpty {
                return ["role": "assistant", "content": msg.content]
            }
            return nil
        }
        loadedChatId = newId
        reeditSession = nil
    }

    /// Snapshot the on-screen messages → SerializedMessage and hand them
    /// to ChatStore for debounced PATCH. Called at every meaningful
    /// mutation point (send, job complete, fail).
    private func persistMessagesNow(chatId: String) {
        let serialized = messages.compactMap { msg in
            SerializedMessage.shouldPersist(msg) ? SerializedMessage(from: msg) : nil
        }
        chatStore.scheduleSave(chatId: chatId, messages: serialized)
    }

    /// Persist into the currently active chat. No-op if there isn't one yet.
    private func persistMessages() {
        if let id = chatStore.activeChatId {
            persistMessagesNow(chatId: id)
        }
    }

    /// Lazily create a chat on first send. Returns the chat id we're now
    /// targeting (the existing active chat, or a freshly-created one).
    /// Returns nil only on auth/network failure during creation.
    ///
    /// Order matters: `loadedChatId` must be set BEFORE
    /// `chatStore.activeChatId` so the `onChange` handler skips the load
    /// (which would otherwise wipe the in-memory `messages` we're about to
    /// populate).
    private func ensureActiveChat() async -> String? {
        if let id = chatStore.activeChatId {
            return id
        }
        guard let chat = await chatStore.createChat() else { return nil }
        loadedChatId = chat.id
        chatStore.activeChatId = chat.id
        return chat.id
    }

    /// Start a fresh chat. Persists the current chat first, clears local
    /// state, then creates a new chat and activates it. Triggered by the
    /// new-chat toolbar button and by sidebar.
    @MainActor
    private func startNewChat() async {
        if let id = chatStore.activeChatId {
            persistMessagesNow(chatId: id)
        }
        sseClients.values.forEach { $0.disconnect() }
        sseClients.removeAll()
        messages = []
        conversationHistory = []
        reeditSession = nil
        inputText = ""
        pendingVideos.forEach { $0.uploadTask?.cancel() }
        pendingVideos = []
        guard let chat = await chatStore.createChat() else { return }
        loadedChatId = chat.id
        chatStore.activeChatId = chat.id
        isInputFocused = true
    }

    // MARK: - Re-edit context chip

    @ViewBuilder
    private var reeditChip: some View {
        if let session = reeditSession {
            HStack(spacing: 10) {
                if let thumbUrl = session.thumbnailUrl, let url = URL(string: thumbUrl) {
                    AsyncImage(url: url) { phase in
                        if let img = phase.image {
                            img.resizable().aspectRatio(contentMode: .fill)
                        } else {
                            Color(.tertiarySystemBackground)
                        }
                    }
                    .frame(width: 36, height: 36)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                } else {
                    Image(systemName: "wand.and.stars")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(.white)
                        .frame(width: 36, height: 36)
                        .background(Color(.tertiarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text("Re-editing")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(.secondary)
                    Text(session.oldVibe.isEmpty ? "Previous edit" : session.oldVibe)
                        .font(.system(size: 13))
                        .foregroundColor(.white)
                        .lineLimit(1)
                }

                Spacer(minLength: 8)

                Button {
                    withAnimation(.easeOut(duration: 0.2)) { reeditSession = nil }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.white)
                        .frame(width: 20, height: 20)
                        .background(Color.black.opacity(0.6))
                        .clipShape(Circle())
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Color(.tertiarySystemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .padding(.horizontal, 12)
            .padding(.bottom, 4)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: - Empty State

    /// Empty state. Apple HIG-shaped: thin SF Symbol in secondary color
    /// (no decorative tinted background), a brand-name title, a single
    /// concise subtitle, and a borderless prominent button. Avoids the
    /// "AI startup hero" feel — no accent-color circles, no marketing
    /// copy, no white capsule. Reads like a native iOS app.
    private var emptyState: some View {
        VStack(spacing: 0) {
            Spacer()

            Image(systemName: "video.badge.plus")
                .font(.system(size: 56, weight: .thin))
                .foregroundStyle(.secondary)
                .padding(.bottom, 22)

            Text("Promptly")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(.primary)
                .padding(.bottom, 6)

            Text("Upload a video to start editing.")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .padding(.bottom, 28)

            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                showVideoPicker = true
            } label: {
                Text("Upload Video")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 220, height: 48)
            }
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(.black)
            .controlSize(.large)

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
        .onTapGesture { Self.dismissKeyboard() }
    }

    // MARK: - Messages

    private var messagesList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 8) {
                    ForEach(messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            // Tap on empty area between input + messages dismisses the
            // keyboard. simultaneousGesture so it doesn't steal taps from
            // the message bubbles.
            .simultaneousGesture(
                TapGesture().onEnded { Self.dismissKeyboard() }
            )
            .onChange(of: messages.count) { oldCount, newCount in
                if newCount > oldCount, let lastId = messages.last?.id {
                    proxy.scrollTo(lastId, anchor: .bottom)
                }
            }
        }
    }

    // MARK: - Pending Attachments

    private var pendingAttachments: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(pendingVideos) { video in
                    PendingVideoThumb(video: video) {
                        withAnimation(.easeOut(duration: 0.2)) {
                            pendingVideos.removeAll { $0.id == video.id }
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(Color(.systemBackground))
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 0) {
            Button { showVideoPicker = true } label: {
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .accessibilityHidden(true)
            }
            .accessibilityLabel("Add video")
            .sensoryFeedback(.impact(weight: .light), trigger: showVideoPicker)

            TextField("Describe your edit...", text: $inputText, axis: .vertical)
                .focused($isInputFocused)
                .lineLimit(1...6)
                .foregroundColor(.white)
                // Dynamic Type — input scales with user preference,
                // capped to keep the chat input from eating the screen.
                .font(.body)
                .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                .tint(.white)
                .submitLabel(.send)
                .onSubmit { send() }
                .padding(.vertical, 9)
                .padding(.trailing, 4)
                .accessibilityLabel("Describe your edit")

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(.black)
                    .frame(width: 30, height: 30)
                    .background(Color.white)
                    .clipShape(Circle())
                    .accessibilityHidden(true)
            }
            .padding(.trailing, 5)
            .padding(.bottom, 5)
            .opacity(canSend ? 1 : 0)
            .scaleEffect(canSend ? 1 : 0.5)
            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: canSend)
            .disabled(!canSend)
            .accessibilityLabel("Send")
            .sensoryFeedback(.impact(weight: .medium), trigger: isSending)
        }
        .background(
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .fill(Color(.tertiarySystemBackground))
        )
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(Color(.systemBackground))
        .overlay(alignment: .top) {
            Rectangle()
                .fill(Color(.separator))
                .frame(height: 0.5)
        }
    }

    private var canSend: Bool {
        (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingVideos.isEmpty) && !isSending
    }

    // MARK: - Video Selection (INSTANT — no copy, uses PHAsset directly)

    private func handlePickedVideos(_ videos: [PickedVideo]) {
        for video in videos {
            let pending = PendingVideo()
            pending.fileName = "\(video.id).mp4"
            pending.isLoading = false

            // Thumbnail comes from the Photos cache immediately — local, no
            // iCloud bytes needed. Tile shows up the instant the picker
            // dismisses.
            Task {
                let thumb = await PHAssetResolver.thumbnail(for: video.asset)
                await MainActor.run { pending.thumbnail = thumb }
            }

            withAnimation(.easeOut(duration: 0.15)) {
                pendingVideos.append(pending)
            }

            // Resolve → (maybe compress) → upload pipeline. Heavy lifting
            // runs in the background; the pending tile and upload progress
            // appear immediately on the main thread.
            pending.uploadTask = Task {
                do {
                    let t0 = Date()

                    // Step 0: Pick the fastest resolution strategy. Local-
                    // only videos upload straight from the Photos file URL;
                    // iCloud-only videos stream download→upload in parallel
                    // so the two transfers overlap instead of serialising.
                    let resolveStart = Date()
                    let strategy = await PHAssetResolver.resolveStrategy(asset: video.asset)
                    print(String(format: "[perf] strategy-probe %.2fs", Date().timeIntervalSince(resolveStart)))

                    var publicUrl: String?

                    // Fire prewarm the moment we know the eventual S3 URL.
                    // That's before the upload bytes have landed — Modal's
                    // prewarm handler polls for the object to appear and
                    // kicks off source download + Deepgram the instant it
                    // does, shaving most of the post-send latency.
                    let firePrewarmOnce = PrewarmOnce()

                    switch strategy {
                    case .local(let sourceUrl):
                        print("[perf] path=local")
                        await MainActor.run { pending.fileUrl = sourceUrl }
                        let sourceSize = (try? FileManager.default.attributesOfItem(atPath: sourceUrl.path)[.size] as? Int64) ?? 0

                        // Sharp thumbnail from the real video frames.
                        Task {
                            if let sharp = await ThumbnailGenerator.generate(from: sourceUrl) {
                                await MainActor.run { pending.thumbnail = sharp }
                            }
                        }

                        // Compression skip for typical camera-roll sources
                        // (see shouldSkipCompression). Keeps quality byte-
                        // identical for the 99% case.
                        let uploadSourceUrl: URL
                        let compressStart = Date()
                        if Self.shouldSkipCompression(url: sourceUrl, size: sourceSize) {
                            uploadSourceUrl = sourceUrl
                            print("[perf] compress skipped")
                        } else {
                            uploadSourceUrl = try await VideoCompressor.compress(sourceUrl: sourceUrl)
                            await MainActor.run { pending.fileUrl = uploadSourceUrl }
                            print(String(format: "[perf] compress %.2fs", Date().timeIntervalSince(compressStart)))
                        }

                        // Single deterministic upload path per file size. No
                        // multipart-fail → single-PUT fallback: if multipart
                        // fails, the upload fails. Same for sub-threshold
                        // files: single PUT only, no recovery.
                        let uploadStart = Date()
                        if APIService.shouldUseMultipart(fileUrl: uploadSourceUrl) {
                            publicUrl = try await APIService.shared.uploadFileToS3Multipart(
                                fileName: pending.fileName,
                                fileUrl: uploadSourceUrl,
                                onPublicUrlKnown: { url in firePrewarmOnce.fire(url) }
                            ) { progress in
                                pending.uploadProgress = progress
                            }
                        } else {
                            let urlResponse = try await APIService.shared.getUploadUrl(fileName: pending.fileName)
                            guard let uploadUrl = urlResponse.uploadUrl,
                                  let pub = urlResponse.publicUrl else {
                                throw APIError.uploadFailed
                            }
                            firePrewarmOnce.fire(pub)
                            // Single PUT routes through the background URLSession
                            // — survives app suspend (and kill, when paired
                            // with the orphan-reconcile path in ChatStore).
                            try await APIService.shared.uploadFileToS3(
                                url: uploadUrl,
                                fileUrl: uploadSourceUrl,
                                mimeType: "video/mp4",
                                messageId: pending.id.uuidString,
                                chatId: chatStore.activeChatId,
                                publicUrl: pub
                            ) { progress in
                                pending.uploadProgress = progress
                            }
                            publicUrl = pub
                        }
                        print(String(format: "[perf] upload-step %.2fs", Date().timeIntervalSince(uploadStart)))

                        if uploadSourceUrl != sourceUrl {
                            try? FileManager.default.removeItem(at: uploadSourceUrl)
                        }

                    case .stream(let resource, let fileSize):
                        // iCloud-only path. Streams iCloud → S3 in parallel.
                        // No fallback: if streaming fails, the upload fails.
                        print(String(format: "[perf] path=stream fileSize=%.1fMB", Double(fileSize) / 1_048_576.0))
                        let uploadStart = Date()
                        publicUrl = try await APIService.shared.streamUploadFromICloud(
                            resource: resource,
                            fileSize: fileSize,
                            fileName: pending.fileName,
                            onPublicUrlKnown: { url in firePrewarmOnce.fire(url) }
                        ) { progress in
                            pending.uploadProgress = progress
                        }
                        print(String(format: "[perf] stream-step %.2fs", Date().timeIntervalSince(uploadStart)))

                    case .none:
                        // Strategy probe couldn't resolve the asset — fail.
                        print("[perf] strategy unresolved — failing")
                        throw APIError.uploadFailed
                    }

                    if let publicUrl = publicUrl {
                        await MainActor.run {
                            pending.uploadProgress = 1.0
                            pending.uploadedUrl = publicUrl
                        }
                        firePrewarmOnce.fire(publicUrl)
                    }

                    print(String(format: "[perf] TOTAL tap-to-uploaded %.2fs", Date().timeIntervalSince(t0)))
                } catch {}
            }
        }
    }

    // MARK: - Prewarm One-Shot
    //
    // Guarantees prewarmRender is dispatched at most once per upload, no
    // matter how many code paths call it. Called eagerly from
    // `onPublicUrlKnown` (before upload completes) AND defensively after
    // upload completes. The class is needed because we want call-site
    // semantics like "fire from any closure" — a plain Bool captured by
    // reference in Task closures would need to be an actor.
    final class PrewarmOnce: @unchecked Sendable {
        private let lock = NSLock()
        private var fired = false
        func fire(_ videoUrl: String) {
            lock.lock()
            let already = fired
            fired = true
            lock.unlock()
            guard !already else { return }
            Task.detached(priority: .utility) {
                await APIService.shared.prewarmRender(videoUrl: videoUrl)
            }
        }
    }

    /// Camera-roll footage is already in a container S3 and our server
    /// pipeline accept (mp4 / mov / m4v), typically H.264 or HEVC. Running
    /// it back through an AVAssetExportSession just to get "MP4-with-moov-
    /// at-front" costs 1-5s for zero render benefit. Only fall through to
    /// compression for exotic extensions or files so large that transport
    /// cost matters.
    private static func shouldSkipCompression(url: URL, size: Int64) -> Bool {
        let ext = url.pathExtension.lowercased()
        let acceptableExtensions: Set<String> = ["mp4", "mov", "m4v"]
        guard acceptableExtensions.contains(ext) else { return false }
        let maxSkippableBytes: Int64 = 300 * 1024 * 1024
        return size > 0 && size <= maxSkippableBytes
    }

    // MARK: - Vibe chips
    //
    // Quick-tap suggestions that drop a vibe into the input. Shows only
    // when there's a video staged + the input is empty + we're not in a
    // re-edit. Mirrors the "smart reply" chip pattern in iMessage and
    // the suggestion row in ChatGPT iOS. Horizontal scroll, capsule
    // styling, glass-fill background. Tap a chip → fill input + light
    // haptic, leave keyboard up so the user can edit if they want.

    private static let vibeSuggestions: [String] = [
        "Cinematic",
        "Punchy and fast",
        "Aesthetic and dreamy",
        "Hype edit with bass drops",
        "Vlog-style storytelling",
        "Documentary feel",
        "TikTok viral style",
        "Cozy and warm",
        "High-energy montage",
        "Slow and emotional"
    ]

    @ViewBuilder
    private var vibeChipsBar: some View {
        if inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           reeditSession == nil {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(Self.vibeSuggestions, id: \.self) { vibe in
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            inputText = vibe
                        } label: {
                            Text(vibe)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(.primary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 8)
                                .background(
                                    Capsule(style: .continuous)
                                        .fill(Color(.tertiarySystemFill))
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .frame(height: 44)
            .transition(.opacity.combined(with: .move(edge: .bottom)))
        }
    }

    // MARK: - Send

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasVideos = !pendingVideos.isEmpty
        let reeditActive = reeditSession != nil
        guard !text.isEmpty || hasVideos else { return }

        // First-edit moment is the ideal time to ask for notification
        // permission — the user is about to wait 30–90s for a render and
        // the value of the prompt ("Get notified when your edit is ready")
        // is felt right now, not in the abstract.
        if !PushService.shared.hasAskedForPermission {
            Task { @MainActor in
                await PushService.shared.requestPermissionIfNeeded()
            }
        }

        // ── Re-edit path — no upload; server loads source from DB
        if reeditActive, let session = reeditSession {
            let changeRequest = text.isEmpty ? "Apply the requested changes." : text
            inputText = ""
            let activeSession = session
            reeditSession = nil
            isSending = true

            var userMsg = ChatMessage(role: .user, content: changeRequest)
            userMsg.videoAttachment = VideoAttachment(
                localUrl: URL(fileURLWithPath: ""),
                fileName: "",
                thumbnail: nil,
                remoteThumbnailUrl: activeSession.thumbnailUrl
            )
            messages.append(userMsg)

            var processingMsg = ChatMessage(role: .assistant, content: "", jobStatus: "processing", stepMessage: "Figuring out exactly what to change...")
            processingMsg.stageTimeline = StageTimeline(mode: "tweak")
            processingMsg.originalVibe = activeSession.oldVibe.isEmpty ? changeRequest : activeSession.oldVibe
            messages.append(processingMsg)
            let msgId = processingMsg.id

            Task { @MainActor in
                func idx() -> Int? { messages.firstIndex(where: { $0.id == msgId }) }
                _ = await ensureActiveChat()
                persistMessages()

                do {
                    let newJobId = try await APIService.shared.reeditFromJob(
                        originalJobId: activeSession.originalJobId,
                        changeRequest: changeRequest
                    )
                    if let i = idx() {
                        messages[i].jobId = newJobId
                        startSSE(jobId: newJobId, messageIndex: i)
                        persistMessages()
                    }
                } catch {
                    if let i = idx() {
                        messages[i].jobStatus = "failed"
                        messages[i].error = error.localizedDescription
                        persistMessages()
                    }
                }
                isSending = false
            }
            return
        }

        isSending = true
        let videos = pendingVideos
        let vibe = text.isEmpty ? "Create a clean, engaging edit" : text

        inputText = ""
        withAnimation { pendingVideos = [] }

        // Pin everything to the main actor explicitly. Swift 5 mode does
        // NOT auto-inherit @MainActor for `Task {}` and StageTimeline +
        // ChatMessage mutations are MainActor-isolated, so a non-isolated
        // task body would crash on first @MainActor call.
        Task { @MainActor in
            _ = await ensureActiveChat()

            if hasVideos {
                for video in videos {
                    var userMsg = ChatMessage(role: .user, content: vibe)
                    userMsg.videoAttachment = VideoAttachment(localUrl: video.fileUrl ?? URL(fileURLWithPath: ""), fileName: video.fileName, thumbnail: video.thumbnail)
                    messages.append(userMsg)
                    conversationHistory.append(["role": "user", "content": vibe])

                    var processingMsg = ChatMessage(role: .assistant, content: "", jobStatus: "processing", stepMessage: "Getting started...")
                    processingMsg.stageTimeline = StageTimeline(mode: "full")
                    processingMsg.originalVibe = vibe
                    messages.append(processingMsg)
                    let msgId = processingMsg.id  // capture id, not index — safer if messages get mutated externally

                    persistMessages()

                    Task { @MainActor in
                        // Helper: find the live index of the processing
                        // message by id. Returns nil if it's been removed
                        // (chat switch, delete, etc.) so we silently no-op
                        // instead of crashing on out-of-bounds.
                        func indexOfProcessingMsg() -> Int? {
                            messages.firstIndex(where: { $0.id == msgId })
                        }
                        do {
                            var videoUrl = video.uploadedUrl

                            if videoUrl == nil, let task = video.uploadTask {
                                if let i = indexOfProcessingMsg() { messages[i].stepMessage = "Uploading..." }

                                let mirror = Task { @MainActor in
                                    while !Task.isCancelled {
                                        if let i = indexOfProcessingMsg() {
                                            let pct = max(1, Int(video.uploadProgress * 30))
                                            if pct > (messages[i].jobProgress ?? 0) {
                                                messages[i].jobProgress = pct
                                            }
                                        }
                                        try? await Task.sleep(nanoseconds: 100_000_000)
                                    }
                                }

                                await task.value
                                mirror.cancel()
                                videoUrl = video.uploadedUrl
                            }

                            guard let finalUrl = videoUrl else { throw APIError.uploadFailed }
                            if let i = indexOfProcessingMsg() {
                                messages[i].stepMessage = "Starting your edit..."
                                if (messages[i].jobProgress ?? 0) < 35 {
                                    messages[i].jobProgress = 35
                                }
                            }
                            let jobId = try await APIService.shared.createVideoJob(videoUrl: finalUrl, vibe: vibe)
                            if let i = indexOfProcessingMsg() {
                                messages[i].jobId = jobId
                                startSSE(jobId: jobId, messageIndex: i)
                                persistMessages()
                            }
                        } catch {
                            if let i = indexOfProcessingMsg() {
                                messages[i].jobStatus = "failed"
                                messages[i].error = error.localizedDescription
                                persistMessages()
                            }
                        }
                    }
                }
            } else {
                let thinkingMsg = ChatMessage(role: .assistant, content: "", isThinking: true)
                messages.append(thinkingMsg)
                let msgId = thinkingMsg.id
                func idx() -> Int? { messages.firstIndex(where: { $0.id == msgId }) }

                do {
                    let reply = try await APIService.shared.chat(message: text, history: Array(conversationHistory.suffix(20)))
                    if let i = idx() {
                        messages[i] = ChatMessage(role: .assistant, content: reply)
                        conversationHistory.append(["role": "assistant", "content": reply])
                        persistMessages()
                    }
                } catch {
                    if let i = idx() {
                        messages[i] = ChatMessage(role: .assistant, content: "Sorry, I couldn't respond right now.")
                        persistMessages()
                    }
                }
            }
            isSending = false
        }
    }

    // MARK: - SSE

    private func startSSE(jobId: String, messageIndex: Int) {
        let client = SSEClient(jobId: jobId)
        sseClients[jobId] = client

        client.onEvent = { event in
            guard messageIndex < messages.count else { return }
            // Pass through every status EXCEPT "completed". The completed
            // flip is gated on the local video cache being warm — see the
            // dedicated branch below — so the play UI never appears until
            // the file is on disk and tapping is guaranteed instant.
            if let status = event.status, status != "completed", status != "complete" {
                messages[messageIndex].jobStatus = status
            }
            if let progress = event.progress {
                // Server reports render progress 0-100. Upload takes 0-35 client-side,
                // so map render into the 35-100 band and never go backwards.
                let mapped = 35 + Int(Double(progress) * 0.65)
                if mapped > (messages[messageIndex].jobProgress ?? 0) {
                    messages[messageIndex].jobProgress = mapped
                }
            }
            // Suppress the server-provided stepMessage during the post-render
            // "finalizing" phase below — we own the copy there ("Finalizing
            // your video...") and don't want a stale render-stage message
            // overwriting it on a late SSE tick.
            let isCompletedEvent = event.status == "completed" || event.status == "complete"
            let alreadyFinalizing = messages[messageIndex].stepMessage == "Finalizing your video..."
            if let msg = event.message, !isCompletedEvent, !alreadyFinalizing {
                messages[messageIndex].stepMessage = msg
            }
            if let err = event.error { messages[messageIndex].error = err }

            // Feed the authoritative step token into the stage timeline. Unknown
            // or missing tokens are silently ignored — the timeline stays on the
            // previous stage and the old dumb ProcessingIndicator fallback kicks
            // in only when no timeline exists at all.
            if let step = event.step, !step.isEmpty {
                messages[messageIndex].stageTimeline?.receive(stepToken: step)
            }

            if isCompletedEvent {
                // Stash URLs immediately so the player + push handler can
                // reach them — but DON'T flip jobStatus to "completed" yet.
                if let url = event.videoUrl {
                    messages[messageIndex].renderedVideoUrl = url
                    print("[sse] videoUrl=\(url)")
                } else {
                    print("[sse] WARNING: completion event missing videoUrl")
                }
                if let thumb = event.thumbnailUrl {
                    messages[messageIndex].thumbnailUrl = thumb
                    print("[sse] thumbnailUrl=\(thumb)")
                } else {
                    print("[sse] WARNING: completion event missing thumbnailUrl")
                }
                messages[messageIndex].stepMessage = "Finalizing your video..."
                persistMessages()

                // Spawn the cache-then-flip task. Capped at 30s — if the
                // download still hasn't landed by then we flip to playable
                // anyway and let AVPlayer stream (8M cap means a watchable
                // fallback). For the typical 30-60s clip on Wi-Fi, the
                // download finishes in 3-10s and the user never notices
                // anything beyond a slightly-longer "rendering" spinner.
                let videoUrl = event.videoUrl
                let messageId = messages[messageIndex].id
                let isFinalEvent = event.final == true
                Task { @MainActor in
                    if let videoUrl {
                        await withTaskGroup(of: Void.self) { group in
                            group.addTask {
                                _ = await VideoCache.shared.downloadIfNeeded(jobId: jobId, from: videoUrl)
                            }
                            group.addTask {
                                try? await Task.sleep(for: .seconds(30))
                            }
                            await group.next()
                            group.cancelAll()
                        }
                    }
                    guard let idx = messages.firstIndex(where: { $0.id == messageId }) else { return }
                    messages[idx].jobStatus = "completed"
                    messages[idx].content = "Your video is ready!"
                    messages[idx].stageTimeline?.finish()
                    persistMessages()
                    if isFinalEvent {
                        client.disconnect()
                        sseClients.removeValue(forKey: jobId)
                    }
                }
            }

            if event.status == "failed" || event.status == "error" {
                messages[messageIndex].jobStatus = "failed"
                messages[messageIndex].error = event.error ?? "Something went wrong."
                messages[messageIndex].stageTimeline?.finish()
                persistMessages()
                client.disconnect(); sseClients.removeValue(forKey: jobId)
            }

            // Re-edit plan-diff asked for clarification — surface the question as a
            // regular assistant message and stop the spinner. User can start over
            // from Library with a clearer description.
            if event.status == "needs_clarification" {
                let q = (event.message ?? "").isEmpty ? "Can you describe the change in more detail?" : (event.message ?? "")
                messages[messageIndex].jobStatus = "completed"
                messages[messageIndex].content = q
                messages[messageIndex].renderedVideoUrl = nil
                messages[messageIndex].stageTimeline?.finish()
                persistMessages()
                client.disconnect(); sseClients.removeValue(forKey: jobId)
            }
        }
        client.onError = { errorMsg in
            guard messageIndex < messages.count else { return }
            messages[messageIndex].jobStatus = "failed"
            messages[messageIndex].error = errorMsg
            messages[messageIndex].content = ""
            persistMessages()
            sseClients.removeValue(forKey: jobId)
        }

        client.connect()
    }
}

// MARK: - Pending Video Thumbnail (Claude-style: small square with subtle progress ring)

struct PendingVideoThumb: View {
    @ObservedObject var video: PendingVideo
    let onRemove: () -> Void

    private var isUploading: Bool {
        video.uploadedUrl == nil && video.uploadProgress > 0 && video.uploadProgress < 1
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ZStack {
                if let thumb = video.thumbnail {
                    Image(uiImage: thumb)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(.tertiarySystemBackground))
                        .frame(width: 56, height: 56)
                }

                if isUploading {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .frame(width: 56, height: 56)

                    CircularProgressRing(progress: video.uploadProgress)
                        .frame(width: 22, height: 22)
                } else if video.thumbnail == nil {
                    ProgressView()
                        .tint(.white)
                        .scaleEffect(0.7)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Attached video")
            .accessibilityValue(isUploading ? "Uploading, \(Int(video.uploadProgress * 100)) percent" : (video.uploadedUrl != nil ? "Ready" : "Loading"))

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 18, height: 18)
                    .background(Color.black.opacity(0.7))
                    .clipShape(Circle())
                    .accessibilityHidden(true)
            }
            .accessibilityLabel("Remove video")
            .offset(x: 5, y: -5)
        }
    }
}

struct CircularProgressRing: View {
    let progress: Double
    var body: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.25), lineWidth: 2)
            Circle()
                .trim(from: 0, to: max(0.02, progress))
                .stroke(Color.white, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeOut(duration: 0.2), value: progress)
        }
    }
}
