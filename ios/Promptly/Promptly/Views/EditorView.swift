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
    @State private var ghostIndex: Int = 0
    @FocusState private var isInputFocused: Bool

    var body: some View {
        NavigationStack {
            // SwiftUI's native pattern for "scroll content above a pinned
            // bottom toolbar." The composer is attached as a bottom safe-
            // area inset, which means:
            //   - The scroll view's frame ends exactly where the composer
            //     starts. No VStack distribution math, no leftover black
            //     band between the bottom message and the composer.
            //   - The system handles keyboard avoidance automatically — the
            //     composer rises with the keyboard and the scroll content
            //     adjusts insets to match.
            //   - Same architecture as iMessage / Photos / Mail / WhatsApp.
            // Three previous builds tried VStack-based fixes; all failed
            // because SwiftUI's vertical distribution interacts with
            // ScrollView in subtle ways that produce empty space.
            Group {
                if messages.isEmpty {
                    emptyState
                } else {
                    messagesList
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(luxuryBackdrop)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                // Tight composer stack: re-edit chip (when active) +
                // input bar. The static vibe-chip row was removed in
                // favor of in-bubble ghost-text rotation (see inputBar).
                VStack(spacing: 0) {
                    reeditChip
                    inputBar
                }
                .background(
                    LinearGradient(
                        colors: [Color.black.opacity(0), Color.black.opacity(0.5)],
                        startPoint: .top, endPoint: .bottom
                    )
                )
            }
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
            .task {
                // Ghost-text rotation. 3.2 s dwell per suggestion with a
                // spring-driven fade-up between transitions. Runs for the
                // lifetime of the view; SwiftUI cancels the .task when the
                // view leaves the hierarchy.
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(3.2))
                    if Task.isCancelled { break }
                    withAnimation(.spring(response: 0.55, dampingFraction: 0.82)) {
                        ghostIndex = (ghostIndex + 1) % Self.vibeSuggestions.count
                    }
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
            // Reconcile any in-progress job's status against the database
            // when the app foregrounds. iOS suspends the app aggressively;
            // SSE sockets are killed on suspension, and the server may
            // complete a render entirely during background. Without this,
            // the chat is stuck on "processing" or, worse, marked failed
            // by an SSE transport error even though the render succeeded.
            .onChange(of: scenePhase) { _, newPhase in
                guard newPhase == .active else { return }
                Task { @MainActor in
                    await reconcileInProgressJobs()
                }
            }
            // Foreground heartbeat. SSE can silently die without iOS
            // suspending the app (carrier handoff, server restart, idle
            // timeout) — when that happens, neither scenePhase nor
            // SSE.onError fire, and the chat would sit on "processing"
            // until the user backgrounds and foregrounds. A cheap 15s
            // poll closes that gap. Function short-circuits when nothing
            // is in flight, so the cost is one no-op closure call when
            // idle.
            .task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(15))
                    if Task.isCancelled { break }
                    await reconcileInProgressJobs()
                }
            }
        }
    }

    @Environment(\.scenePhase) private var scenePhase

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

        // Heal anything older builds may have poisoned in storage. Earlier
        // versions of the SSE error handler persisted `jobStatus = "failed"`
        // with a "Connection lost" error for transport blips that didn't
        // actually fail the render. Re-check every message that has a jobId
        // against Supabase: if the DB says completed, we recover the success
        // state (and the rendered video/thumbnail). Genuine failures stay
        // failed because the DB row stays failed.
        Task { @MainActor in
            await reconcileInProgressJobs(includeFailed: true)
        }
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

            Text("AI editor for short-form talking head videos.\nUpload a clip, describe the vibe, and let Promptly do the rest.")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
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
                // Plain LazyVStack — let it size naturally. Wrapping in
                // a containerRelativeFrame(.vertical) forced content to
                // the scroll-view's container height, which under a
                // .safeAreaInset(.bottom) composer meant tall messages
                // (video card + action row ~500pt) had their bottom
                // pushed UNDER the composer with no way to scroll to it.
                // The action row was rendered but unreachable.
                //
                // Tradeoff: short conversations now sit at the TOP of
                // the visible scroll area with empty space below them,
                // rather than floating against the composer. Worth it
                // — being able to actually scroll to the action row is
                // strictly more important than aesthetic anchoring.
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
            // Re-pin to bottom when the composer grows (pending video
            // attached) or shrinks (removed). `defaultScrollAnchor`
            // only sets the INITIAL position — without these, adding a
            // pending tile slides the bottom messages off-screen
            // beneath the expanded composer and the user reads it as
            // "the bubbles disappeared."
            .onChange(of: pendingVideos.count) { _, _ in
                if let lastId = messages.last?.id {
                    withAnimation(.easeOut(duration: 0.22)) {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
            .onChange(of: isInputFocused) { _, focused in
                guard focused, let lastId = messages.last?.id else { return }
                // Defer past the keyboard-rise animation so the scroll
                // position lands on the new visible bounds, not the
                // pre-keyboard ones.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    withAnimation(.easeOut(duration: 0.22)) {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Input Bar
    //
    // Pending video tiles now live INSIDE the input bar's rounded
    // surface — same architecture as iMessage's photo attachments and
    // ChatGPT's image attachments. One unified composer bubble: tiles
    // stack at the top, input row sits below. Eliminates the previous
    // full-width black "pending row" that was visually covering the
    // bottom message bubble when keyboard was up.

    private var inputBar: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !pendingVideos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.Space.xs) {
                        ForEach(pendingVideos) { video in
                            PendingVideoThumb(video: video) {
                                withAnimation(.easeOut(duration: 0.2)) {
                                    pendingVideos.removeAll { $0.id == video.id }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.top, 10)
                    .padding(.bottom, 4)
                }
                .frame(height: 72)
            }

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

                ZStack(alignment: .leading) {
                    // Ghost-text rotation. When the field is empty, the
                    // placeholder cycles through outcome-shaped vibes —
                    // dimmed, fading-up between transitions. Swipe right
                    // on the input area to accept the current ghost; tap
                    // also works. Old chip row is gone.
                    if inputText.isEmpty && pendingVideos.isEmpty && reeditSession == nil {
                        Text(Self.vibeSuggestions[ghostIndex])
                            .font(.system(.body, design: .default).weight(.regular))
                            .tracking(0.3)
                            .foregroundColor(Color.white.opacity(0.35))
                            .id(ghostIndex)
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .move(edge: .top).combined(with: .opacity)
                            ))
                            .padding(.vertical, 9)
                            .allowsHitTesting(false)
                    }

                    TextField("", text: $inputText, axis: .vertical)
                        .focused($isInputFocused)
                        .lineLimit(1...6)
                        .foregroundColor(.white)
                        .font(.system(.body, design: .default))
                        .tracking(0.3)
                        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
                        .tint(.white)
                        .submitLabel(.send)
                        .onSubmit { send() }
                        .padding(.vertical, 9)
                        .padding(.trailing, 4)
                        .accessibilityLabel("Describe your edit")
                }
                .contentShape(Rectangle())
                .gesture(
                    // Swipe right (>= 80pt) accepts the current ghost.
                    // Only fires when the field is empty so it doesn't
                    // fight with text selection.
                    DragGesture(minimumDistance: 30)
                        .onEnded { v in
                            guard inputText.isEmpty, v.translation.width > 80 else { return }
                            inputText = Self.vibeSuggestions[ghostIndex]
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        }
                )

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
        }
        .background(
            ZStack {
                // Vision-pro glass: ultra-thin material over a subtle
                // top-to-bottom gradient. Replaces the flat
                // tertiarySystemBackground fill that was reading "cheap."
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.06),
                                Color.white.opacity(0.02)
                            ],
                            startPoint: .top, endPoint: .bottom
                        )
                    )
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
            }
        )
        .padding(.horizontal, Theme.Space.sm)
        .padding(.top, Theme.Space.xxs)
        .padding(.bottom, Theme.Space.xs)
        .animation(.spring(response: 0.45, dampingFraction: 0.78), value: pendingVideos.count)
    }

    // MARK: - Luxurious backdrop
    //
    // Replaces flat `.systemBackground` with a subtle vertical gradient —
    // soft warm-tinted white-fade-to-black at the top so the title /
    // navigation bar reads with depth, plus a faint vignette at the
    // bottom for the composer. Tiny but it's the difference between
    // "default app" and "designed app."

    private var luxuryBackdrop: some View {
        ZStack {
            Color.black
            LinearGradient(
                colors: [
                    Color.white.opacity(0.05),
                    Color.white.opacity(0.0),
                    Color.white.opacity(0.0),
                    Color.black.opacity(0.4)
                ],
                startPoint: .top, endPoint: .bottom
            )
        }
        .ignoresSafeArea()
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

            // Pause prefetch downloads NOW — before strategy probes,
            // compression, or any server roundtrip. Otherwise prefetches
            // saturate the connection pool during the 1-3s window between
            // pick and the first upload byte. Released in `defer` below.
            VideoCache.shared.setUserUploadActive(true)

            // Resolve → (maybe compress) → upload pipeline. Heavy lifting
            // runs in the background; the pending tile and upload progress
            // appear immediately on the main thread.
            pending.uploadTask = Task {
                defer {
                    Task { @MainActor in VideoCache.shared.setUserUploadActive(false) }
                }
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
                        print("[perf] path=local dual-upload")
                        await MainActor.run { pending.fileUrl = sourceUrl }
                        let sourceSize = (try? FileManager.default.attributesOfItem(atPath: sourceUrl.path)[.size] as? Int64) ?? 0

                        // Sharp thumbnail from the real video frames.
                        Task {
                            if let sharp = await ThumbnailGenerator.generate(from: sourceUrl) {
                                await MainActor.run { pending.thumbnail = sharp }
                            }
                        }

                        // Materialize source into NSTemporaryDirectory.
                        // Background URLSession requires app-accessible
                        // file URLs — Photos-library URLs work via
                        // foreground sessions but fail in nsurlsessiond.
                        let materializedSourceUrl: URL
                        if Self.shouldSkipCompression(url: sourceUrl, size: sourceSize) {
                            // Quality-preserving copy. ~1-2s for 80 MB
                            // on local SSD; needed so the background
                            // session can read after the app suspends.
                            let tmp = FileManager.default.temporaryDirectory
                                .appendingPathComponent("src-\(UUID().uuidString).mp4")
                            try FileManager.default.copyItem(at: sourceUrl, to: tmp)
                            materializedSourceUrl = tmp
                            print("[perf] compress skipped (copy-only)")
                        } else {
                            materializedSourceUrl = try await VideoCompressor.compress(sourceUrl: sourceUrl)
                            print("[perf] compressed → tmp")
                        }
                        await MainActor.run { pending.fileUrl = materializedSourceUrl }

                        // Get TWO presigned upload URLs in parallel —
                        // one for the proxy (small, foreground), one
                        // for the source (large, background).
                        async let proxyUrlResp = APIService.shared.getUploadUrl(fileName: "proxy-\(UUID().uuidString).mp4")
                        async let sourceUrlResp = APIService.shared.getUploadUrl(fileName: pending.fileName)
                        let (proxyResp, sourceResp) = try await (proxyUrlResp, sourceUrlResp)
                        guard let proxyPutUrl = proxyResp.uploadUrl,
                              let proxyPub = proxyResp.publicUrl,
                              let sourcePutUrl = sourceResp.uploadUrl,
                              let sourcePub = sourceResp.publicUrl else {
                            throw APIError.uploadFailed
                        }

                        // Fire prewarm with the SOURCE URL — worker polls
                        // S3 until the source lands, then starts the
                        // download + transcribe pipeline. Proxy is only
                        // used by Gemini visual analysis (in the main
                        // video-jobs path), so it doesn't need its own
                        // prewarm.
                        firePrewarmOnce.fire(sourcePub)

                        // Publish the eventual source URL IMMEDIATELY so
                        // send() can dispatch the job the moment the proxy
                        // is ready — the worker polls S3 for the source
                        // file regardless of whether bytes have arrived.
                        // Upload progress (0→1) is tracked separately on
                        // pending.uploadProgress so the UI still reflects
                        // real byte movement.
                        await MainActor.run { pending.uploadedUrl = sourcePub }

                        // Extract proxy. ~3-5s on iPhone 13+ for a 50s
                        // 1080p clip → ~3-6 MB output at 640x480.
                        let proxyExtractStart = Date()
                        let proxyFile = try await VideoProxyExtractor.extract(from: materializedSourceUrl)
                        print(String(format: "[perf] proxy-extract %.2fs", Date().timeIntervalSince(proxyExtractStart)))

                        // Parallel uploads:
                        //   - Proxy via foreground URLSession (small,
                        //     completes in 5-10s, blocks Send button).
                        //   - Source via background URLSession (60-120s,
                        //     survives app suspend / kill).
                        let uploadStart = Date()
                        async let proxyUpload: Void = {
                            try await APIService.shared.uploadFileToS3Foreground(
                                url: proxyPutUrl,
                                fileUrl: proxyFile,
                                mimeType: "video/mp4",
                                onProgress: { p in
                                    Task { @MainActor in pending.proxyUploadProgress = p }
                                }
                            )
                            try? FileManager.default.removeItem(at: proxyFile)
                            await MainActor.run {
                                pending.proxyUploadProgress = 1.0
                                pending.proxyUploadedUrl = proxyPub
                            }
                            print("[perf] proxy upload complete")
                        }()

                        async let sourceUpload: Void = {
                            try await APIService.shared.uploadFileToS3(
                                url: sourcePutUrl,
                                fileUrl: materializedSourceUrl,
                                mimeType: "video/mp4",
                                messageId: pending.id.uuidString,
                                chatId: chatStore.activeChatId,
                                publicUrl: sourcePub
                            ) { p in
                                Task { @MainActor in pending.uploadProgress = p }
                            }
                            try? FileManager.default.removeItem(at: materializedSourceUrl)
                            await MainActor.run {
                                pending.uploadProgress = 1.0
                                // uploadedUrl was already set early so the
                                // job could dispatch on proxy-ready; this
                                // is the byte-arrival signal.
                            }
                            print("[perf] source upload complete (background)")
                        }()

                        _ = try await proxyUpload
                        _ = try await sourceUpload
                        print(String(format: "[perf] both-uploads-done %.2fs", Date().timeIntervalSince(uploadStart)))
                        publicUrl = sourcePub

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
                } catch {
                    print("[perf] upload task failed: \(error.localizedDescription)")
                    // Clear any eagerly-set URLs so a second Send tap
                    // doesn't reuse a stale public URL pointing at S3
                    // bytes that never arrived — that produced the
                    // "jumps to 40% Preparing your footage" bug where
                    // the worker dispatched against a missing object.
                    await MainActor.run {
                        pending.uploadFailed = true
                        pending.uploadedUrl = nil
                        pending.proxyUploadedUrl = nil
                        pending.uploadProgress = 0
                        pending.proxyUploadProgress = 0
                    }
                }
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
    // Outcome-shaped vibes for short-form talking head. Cycled inside
    // the input bubble as ghost text — see inputBar above. Order
    // matters: the first one is what users see in the static frame,
    // so it should be the safe-bet default.
    static let vibeSuggestions: [String] = [
        "Engaging fast-paced",
        "Sales pitch",
        "Viral hype",
        "Storytime",
        "Make it good"
    ]

    // MARK: - Send

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasVideos = !pendingVideos.isEmpty
        let reeditActive = reeditSession != nil
        guard !text.isEmpty || hasVideos else { return }

        // Nudge: a video with no vibe is unrenderable — without a
        // creative direction the worker has nothing to optimize for.
        // Instead of silently substituting a generic prompt and burning
        // a render slot, ask the user for a vibe (and surface the
        // chip suggestions). Re-edit is exempt — it operates on the
        // existing edit recipe so empty text means "no further change."
        if hasVideos && text.isEmpty && !reeditActive {
            let nudge = ChatMessage(
                role: .assistant,
                content: "Tell me the vibe you want and I'll edit it. Try one of the suggestions below — or describe it in your own words."
            )
            messages.append(nudge)
            isInputFocused = true
            return
        }

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

        // Append the user/processing messages NOW, before we await
        // ensureActiveChat. The chat ID is only needed for persistence;
        // the UI can render messages immediately. Otherwise the chat
        // looks blank for 200-800ms while createChat round-trips
        // Supabase, which feels broken.
        var pendingMsgIds: [(video: PendingVideo, msgId: UUID)] = []
        if hasVideos {
            for video in videos {
                var userMsg = ChatMessage(role: .user, content: vibe)
                userMsg.videoAttachment = VideoAttachment(localUrl: video.fileUrl ?? URL(fileURLWithPath: ""), fileName: video.fileName, thumbnail: video.thumbnail)
                messages.append(userMsg)
                conversationHistory.append(["role": "user", "content": vibe])

                var processingMsg = ChatMessage(role: .assistant, content: "", jobStatus: "processing", stepMessage: nil)
                processingMsg.stageTimeline = StageTimeline(mode: "full", startWith: "upload_local")
                processingMsg.originalVibe = vibe
                messages.append(processingMsg)
                pendingMsgIds.append((video, processingMsg.id))
            }
        }

        // Pin everything to the main actor explicitly. Swift 5 mode does
        // NOT auto-inherit @MainActor for `Task {}` and StageTimeline +
        // ChatMessage mutations are MainActor-isolated, so a non-isolated
        // task body would crash on first @MainActor call.
        Task { @MainActor in
            _ = await ensureActiveChat()
            persistMessages()

            if hasVideos {
                for (video, msgId) in pendingMsgIds {
                    Task { @MainActor in
                        // Helper: find the live index of the processing
                        // message by id. Returns nil if it's been removed
                        // (chat switch, delete, etc.) so we silently no-op
                        // instead of crashing on out-of-bounds.
                        func indexOfProcessingMsg() -> Int? {
                            messages.firstIndex(where: { $0.id == msgId })
                        }
                        do {
                            let sendStart = Date()
                            print("[send] waiting for proxy/source URL")
                            // Wait for the PROXY upload to finish, with a
                            // 60s deadline so the inner Task can't hang
                            // forever if the upload Task is stuck or
                            // suspended.
                            let waitDeadline = Date().addingTimeInterval(60)
                            while video.proxyUploadedUrl == nil && video.uploadedUrl == nil && !(video.uploadFailed) {
                                if Date() > waitDeadline {
                                    throw APIError.uploadFailed
                                }
                                try? await Task.sleep(nanoseconds: 100_000_000)
                            }
                            if video.uploadFailed {
                                throw APIError.uploadFailed
                            }

                            guard let sourceUrl = video.uploadedUrl else {
                                throw APIError.uploadFailed
                            }
                            let proxyUrl = video.proxyUploadedUrl
                            print(String(format: "[send] urls ready after %.2fs proxy=%@ source=%@",
                                Date().timeIntervalSince(sendStart),
                                proxyUrl == nil ? "nil" : "set",
                                "set"))

                            if let i = indexOfProcessingMsg() {
                                messages[i].stageTimeline?.receive(stepToken: "analyze")
                                if (messages[i].jobProgress ?? 0) < 40 {
                                    messages[i].jobProgress = 40
                                }
                            }
                            print("[send] calling createVideoJob")
                            let cvjStart = Date()
                            let jobId = try await APIService.shared.createVideoJob(
                                videoUrl: sourceUrl,
                                proxyVideoUrl: proxyUrl,
                                vibe: vibe
                            )
                            print(String(format: "[send] createVideoJob OK in %.2fs jobId=%@",
                                Date().timeIntervalSince(cvjStart), jobId))
                            if let i = indexOfProcessingMsg() {
                                messages[i].jobId = jobId
                                startSSE(jobId: jobId, messageIndex: i)
                                persistMessages()
                            }
                            // Stuck-detection: if SSE never fires the
                            // first stage event within 90s, the main
                            // worker isn't running (or its first event
                            // isn't reaching us). Surface a clear
                            // error in the UI so the user isn't staring
                            // at a frozen progress bar.
                            scheduleStuckDetector(messageId: msgId, jobId: jobId)
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

    // MARK: - Stuck detection
    //
    // Production safety net. After the job is dispatched, SSE should
    // start delivering stage events within seconds (analyze, transcribe,
    // etc.). If 90 seconds pass and the message is still on the
    // pre-pipeline `analyze` stage with no jobProgress beyond 40, the
    // main worker either crashed silently, never received the dispatch,
    // or its first event isn't reaching us. Surface a clear error in
    // the UI instead of leaving the user staring at a frozen bar.
    private func scheduleStuckDetector(messageId: UUID, jobId: String) {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(90))
            guard let i = messages.firstIndex(where: { $0.id == messageId }) else { return }
            // If the message is now completed / failed, the pipeline is
            // either done or already errored. Nothing to do.
            let status = messages[i].jobStatus ?? ""
            if status == "completed" || status == "complete" || status == "failed" || status == "error" {
                return
            }
            // If we got ANY progress past the static 40% "analyze" plant,
            // SSE is alive — keep waiting.
            if (messages[i].jobProgress ?? 0) > 41 {
                return
            }
            // Truly stuck. Reconcile against DB one more time in case
            // the job already completed and we just missed the events.
            await reconcileJobStatus(jobId: jobId)
            // After reconcile, if still stuck, mark failed with a clear
            // message the user can act on.
            guard let j = messages.firstIndex(where: { $0.id == messageId }) else { return }
            let postStatus = messages[j].jobStatus ?? ""
            if postStatus == "completed" || postStatus == "complete" || postStatus == "failed" || postStatus == "error" {
                return
            }
            if (messages[j].jobProgress ?? 0) <= 41 {
                print("[stuck] job \(jobId) showed no progress past 40% for 90s — marking failed")
                messages[j].jobStatus = "failed"
                messages[j].error = "The render didn't start. Try again, or check your connection."
                messages[j].stageTimeline?.finish()
                persistMessages()
            }
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
                // Server reports render progress 0-100. Upload takes 0-40 client-side
                // (with `upload_local` as the first stage in the timeline), so map
                // render into the 40-100 band. Bar never goes backwards: the SSE
                // mapping floor is exactly where upload's ceiling lands, so the
                // first server tick continues the bar instead of resetting it.
                let mapped = 40 + Int(Double(progress) * 0.6)
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
                if let hls = event.hlsManifestUrl, !hls.isEmpty {
                    messages[messageIndex].hlsManifestUrl = hls
                    print("[sse] hlsManifestUrl=\(hls)")
                }
                if let thumb = event.thumbnailUrl {
                    messages[messageIndex].thumbnailUrl = thumb
                    print("[sse] thumbnailUrl=\(thumb)")
                } else {
                    print("[sse] WARNING: completion event missing thumbnailUrl")
                }
                let videoUrl = event.videoUrl
                let hlsUrl = event.hlsManifestUrl
                let messageId = messages[messageIndex].id
                let isFinalEvent = event.final == true

                // Pre-warm AVPlayer items the moment the render lands.
                // The user typically taps the thumbnail within seconds —
                // by then the asset metadata is loaded and first-frame
                // paint is sub-100ms instead of the cold 300-800ms read.
                // HLS warming validates the manifest + caches the master
                // playlist; MP4 warming pulls the moov atom from CDN.
                if let hlsUrl, !hlsUrl.isEmpty {
                    PlayerAssetPrewarm.shared.warm(hlsUrl)
                }
                if let videoUrl, isStreamingReadyUrl(videoUrl) {
                    PlayerAssetPrewarm.shared.warm(videoUrl)
                }

                // CDN-backed URLs (CloudFront) flip to the playable state
                // IMMEDIATELY. The video streams smoothly from the edge,
                // so there's no reason to make the user wait for a full
                // download before showing the play button. This is the
                // production-grade flow that Loom / Runway / iMessage use.
                //
                // S3-origin URLs keep the cache-then-flip wait because raw
                // S3 throughput is too bursty for smooth AVPlayer streaming
                // — without a CDN, the player rebuffers constantly. The
                // download-first path was the original workaround.
                let streaming = videoUrl.map { isStreamingReadyUrl($0) } ?? false

                if streaming {
                    messages[messageIndex].jobStatus = "completed"
                    messages[messageIndex].content = "Your video is ready!"
                    messages[messageIndex].stageTimeline?.finish()
                    persistMessages()
                    if isFinalEvent {
                        client.disconnect()
                        sseClients.removeValue(forKey: jobId)
                    }
                    // Background prefetch so offline replay works after
                    // first watch — same as iMessage / WhatsApp's pattern.
                    if let videoUrl {
                        Task.detached(priority: .background) {
                            await VideoCache.shared.downloadIfNeeded(
                                jobId: jobId,
                                from: videoUrl,
                                priority: .prefetch
                            )
                        }
                    }
                } else {
                    messages[messageIndex].stepMessage = "Finalizing your video..."
                    persistMessages()

                    // Legacy cache-then-flip path. Used until CloudFront is
                    // configured. 30s cap before flipping anyway to avoid
                    // stranding the user on a stuck spinner.
                    Task { @MainActor in
                        if let videoUrl {
                            await withTaskGroup(of: Void.self) { group in
                                group.addTask {
                                    _ = await VideoCache.shared.downloadIfNeeded(
                                        jobId: jobId,
                                        from: videoUrl,
                                        priority: .userInitiated
                                    )
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
            }

            if event.status == "failed" || event.status == "error" {
                // Don't trust a single "failed" signal — it can come from
                // a transient DB read during a worker retry, an SSE poll
                // that raced a status flip, or the iOS app waking up to
                // a stale event from before the render actually succeeded.
                // Tear down the SSE client and reconcile against the
                // authoritative DB state. The reconcile path will mark
                // failed only if Supabase actually says so; if the row is
                // "completed" by the time we look, we recover with the
                // success state instead of stranding a successful render
                // on a "Connection lost" screen.
                let liveError = event.error
                client.disconnect()
                sseClients.removeValue(forKey: jobId)
                Task { @MainActor in
                    let liveJobId = jobId
                    await reconcileJobStatus(jobId: liveJobId)
                    if let i = messages.firstIndex(where: { $0.jobId == liveJobId }),
                       messages[i].jobStatus != "completed" && messages[i].jobStatus != "failed" {
                        // DB said still-processing or lookup failed — fall
                        // back to honoring the live failed event so we don't
                        // strand the user on an infinite spinner.
                        messages[i].jobStatus = "failed"
                        messages[i].error = liveError ?? "Something went wrong."
                        messages[i].stageTimeline?.finish()
                        persistMessages()
                    }
                }
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
            // SSE connection had a transport problem (backgrounded, network
            // blip, server restart, etc.) — that's NOT the same as "the
            // render failed." Don't mark the message as failed here.
            // Reconcile against the actual database state so we know
            // whether the job genuinely failed, completed (we just missed
            // the event), or is still running.
            //
            // Previous behavior: any SSE drop ≥ "Connection lost" marked
            // the message permanently failed even when the server-side
            // pipeline succeeded. Common case: user backgrounds the app
            // for a minute, render completes during suspension, app
            // foregrounds → SSE shows error → message stuck on failed.
            print("[sse] connection error: \(errorMsg) — reconciling against DB before declaring failure")
            sseClients.removeValue(forKey: jobId)
            Task { @MainActor in
                await reconcileJobStatus(jobId: jobId)
            }
        }

        client.connect()
    }

    /// Query the database for a job's authoritative status and update the
    /// local message accordingly. Used as the recovery path when SSE drops
    /// (transport error, app backgrounded long enough that the server
    /// finished without us listening, etc.) and on app foreground for any
    /// message still in `processing` state.
    private func reconcileJobStatus(jobId: String) async {
        guard let token = await AuthService.shared.getValidToken() else { return }

        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

        guard let url = URL(string: "\(supabaseUrl)/rest/v1/video_jobs?id=eq.\(jobId)&select=status,rendered_video_url,hls_manifest_url,thumbnail_url,error_message") else { return }

        var request = URLRequest(url: url)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        struct JobStatusRow: Codable {
            let status: String?
            let rendered_video_url: String?
            let hls_manifest_url: String?
            let thumbnail_url: String?
            let error_message: String?
        }

        do {
            let (data, _) = try await URLSession.shared.data(for: request)
            guard let row = (try? JSONDecoder().decode([JobStatusRow].self, from: data))?.first else { return }
            guard let idx = messages.firstIndex(where: { $0.jobId == jobId }) else { return }

            switch row.status {
            case "completed", "complete":
                messages[idx].jobStatus = "completed"
                messages[idx].content = "Your video is ready!"
                messages[idx].error = nil
                if let v = row.rendered_video_url { messages[idx].renderedVideoUrl = v }
                if let h = row.hls_manifest_url { messages[idx].hlsManifestUrl = h }
                if let t = row.thumbnail_url { messages[idx].thumbnailUrl = t }
                messages[idx].stageTimeline?.finish()
                print("[reconcile] \(jobId) → completed")
            case "failed":
                messages[idx].jobStatus = "failed"
                messages[idx].error = row.error_message ?? "Something went wrong."
                messages[idx].stageTimeline?.finish()
                print("[reconcile] \(jobId) → failed")
            default:
                // Still processing or unknown — don't touch the message.
                // SSE auto-reconnect will pick up live updates again.
                print("[reconcile] \(jobId) → still \(row.status ?? "?"), keeping in-progress state")
                return
            }
            persistMessages()
        } catch {
            // Reconcile itself failed — silent. Either SSE will reconnect
            // and resume normally, or the next foreground transition
            // gets another chance.
            print("[reconcile] \(jobId) lookup failed: \(error.localizedDescription) — leaving message untouched")
        }
    }

    /// Walk messages across the active chat and reconcile each one's
    /// status with the database. Default mode reconciles only in-flight
    /// jobs (processing/queued/no-status) — this is what foreground and
    /// the heartbeat use. Pass `includeFailed: true` to also re-check
    /// messages persisted as failed, used on chat load to heal "Connection
    /// lost"-style poison written by older buggy builds: if Supabase says
    /// the row is actually completed, we recover the success state.
    func reconcileInProgressJobs(includeFailed: Bool = false) async {
        let jobIds: [String] = messages.compactMap { msg in
            guard let jobId = msg.jobId else { return nil }
            let inFlight = msg.jobStatus == "processing" ||
                           msg.jobStatus == "queued" ||
                           msg.jobStatus == nil
            let recheckFailed = includeFailed && (msg.jobStatus == "failed" || msg.jobStatus == "error")
            return (inFlight || recheckFailed) ? jobId : nil
        }
        for jobId in jobIds {
            await reconcileJobStatus(jobId: jobId)
        }
    }
}

// MARK: - Pending Video Thumbnail (Claude-style: small square with subtle progress ring)

struct PendingVideoThumb: View {
    @ObservedObject var video: PendingVideo
    let onRemove: () -> Void

    /// Show the upload error indicator only when the upload Task threw
    /// AND the user hasn't dismissed the tile. We never show "uploading
    /// progress" — that state was making attachments feel stuck on slow
    /// networks (especially iCloud-only assets) when the file transfer
    /// is happening invisibly in the background. iMessage / WhatsApp /
    /// ChatGPT all just show the thumbnail cleanly while upload runs;
    /// the user can hit send any time and the message takes over showing
    /// progress in the chat from there.
    private var didFail: Bool { video.uploadFailed }

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
                    // No thumbnail yet — neutral surface, no spinner. The
                    // PHAsset thumbnail loads in milliseconds for cached
                    // tiles; the rare cases where it doesn't (iCloud-only
                    // with no cached thumb) just show the surface until
                    // it arrives. No "loading" spinner that the user
                    // would read as "stuck."
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color(.tertiarySystemBackground))
                        .frame(width: 56, height: 56)
                        .overlay {
                            Image(systemName: "video.fill")
                                .font(.system(size: 18, weight: .medium))
                                .foregroundColor(Color(.tertiaryLabel))
                        }
                }

                if didFail {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.red.opacity(0.18))
                        .frame(width: 56, height: 56)
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.red)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Attached video")
            .accessibilityValue(didFail ? "Upload failed" : "Ready")

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
