import SwiftUI
import PhotosUI
import UIKit

struct EditorView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var chatStore = ChatStore.shared
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var showVideoPicker = false
    @State private var showVoiceInput = false
    @State private var pendingVideos: [PendingVideo] = []
    @State private var isSending = false
    @State private var conversationHistory: [[String: String]] = []
    @State private var sseClients: [String: SSEClient] = [:]
    @State private var reeditSession: ReeditSession?
    @State private var loadedChatId: String? = nil
    @State private var ghostIndex: Int = 0
    /// Tracks whether the scroll view is anchored at the bottom. When
    /// the user scrolls up past the last message's bottom edge, we
    /// surface a floating "↓ scroll to bottom" button — the standard
    /// iMessage / ChatGPT pattern.
    @State private var isAtBottom: Bool = true
    /// The currently-in-flight text-chat Task. Tapping Send while a
    /// response is still streaming cancels this task, lets the partial
    /// content stay in place, and starts a fresh conversation turn —
    /// same behavior as ChatGPT iOS.
    @State private var activeChatTask: Task<Void, Never>?
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
                NativeVideoPicker(maxSelection: pickerMaxSelection) { videos in
                    handlePickedVideos(videos)
                }
                .ignoresSafeArea()
            }
            .fullScreenCover(isPresented: $showVoiceInput) {
                VoiceInputSheet(isPresented: $showVoiceInput) { transcript in
                    // Append (not replace) so a user dictating a second
                    // chunk on top of an existing draft doesn't lose it.
                    let trimmedExisting = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
                    if trimmedExisting.isEmpty {
                        inputText = transcript
                    } else {
                        inputText = trimmedExisting + " " + transcript
                    }
                    isInputFocused = true
                }
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
                // Force any live SSE clients to reconnect immediately.
                // iOS suspended the app, killed the SSE socket, and the
                // SSEClient's exponential backoff was paused along with
                // the rest of the app — meaning on resume it'd sleep
                // anywhere from 2s up to 60s before reconnecting. The
                // progress bar would freeze the entire time even though
                // the render is still streaming server-side.
                sseClients.values.forEach { $0.forceReconnectIfNeeded() }
                // Spin up SSE for any in-flight message that doesn't
                // have a client yet (e.g. the chat was just restored
                // from disk and never had one, or a previous client
                // gave up after exhausting its retry budget).
                resumeSSEForInFlightMessages()
                Task { @MainActor in
                    // includeFailed: true heals messages that got
                    // marked failed locally (e.g. by an over-eager
                    // stuck detector or a transient SSE drop) but
                    // actually completed server-side.
                    await reconcileInProgressJobs(includeFailed: true)
                }
            }
            // Foreground heartbeat. SSE can silently die without iOS
            // suspending the app (carrier handoff, server restart, idle
            // timeout) — when that happens, neither scenePhase nor
            // SSE.onError fire, and the chat would sit on "processing"
            // until the user backgrounds and foregrounds. A 5s tick when
            // there's an in-flight render closes that gap fast; we drop
            // to 15s when nothing is processing so we're not hammering
            // Supabase. Includes failed messages too so they self-heal
            // when the worker eventually completes a render that was
            // prematurely marked failed.
            .task {
                while !Task.isCancelled {
                    let hasInFlight = messages.contains { m in
                        guard m.jobId != nil else { return false }
                        return m.jobStatus == "processing" ||
                               m.jobStatus == "queued" ||
                               m.jobStatus == nil
                    }
                    let interval: Duration = hasInFlight ? .seconds(5) : .seconds(15)
                    try? await Task.sleep(for: interval)
                    if Task.isCancelled { break }
                    await reconcileInProgressJobs(includeFailed: true)
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
            // Skip the onboarding welcome — it'd burn API tokens and
            // bias the model's tone if echoed back as prior context.
            if msg.isOnboarding { return nil }
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

        // Inject welcome on legacy empty chats too (chats created
        // before this feature existed). Single source of truth for
        // the message lives in injectWelcomeIfEmpty().
        injectWelcomeIfEmpty()

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

        // Re-attach SSE for any message that's still processing in storage.
        // Otherwise the user comes back to a "processing" bubble that's
        // frozen at restore-time progress until the next 5s heartbeat tick.
        // Reconnecting brings live token updates back immediately.
        resumeSSEForInFlightMessages()
    }

    /// Restart SSE clients for any restored message whose render is still
    /// in flight. Called from handleActiveChatChange after the messages
    /// array is populated; pairs with the reconcile path which catches
    /// already-completed renders we missed.
    private func resumeSSEForInFlightMessages() {
        for (idx, msg) in messages.enumerated() {
            guard let jobId = msg.jobId else { continue }
            // Already-final states have nothing to subscribe to.
            if msg.jobStatus == "completed" || msg.jobStatus == "failed"
                || msg.jobStatus == "needs_clarification" { continue }
            // Don't double-subscribe if we somehow still have a live client.
            if sseClients[jobId] != nil { continue }
            startSSE(jobId: jobId, messageIndex: idx)
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
        injectWelcomeIfEmpty()
        isInputFocused = true
    }

    /// Single point of truth for the onboarding welcome message. Called
    /// from both the chat-load path and the new-chat path so a user
    /// always sees Promptly's intro the moment a fresh chat surfaces.
    /// Idempotent: only injects when messages is genuinely empty.
    ///
    /// Reveals the text via `typewriteReveal` so it feels alive instead
    /// of slamming the full block in at once. Persist happens AFTER the
    /// reveal completes so the saved chat record stores the final text;
    /// otherwise a fast app-kill mid-reveal would persist a partial.
    private func injectWelcomeIfEmpty() {
        guard messages.isEmpty else { return }
        let fullText = "Hey 👋 I'm Promptly. Drop a clip and tell me the vibe — viral hype, sales pitch, storytime, whatever you're going for. I'll cut it, caption it, add B-roll, and have your edit back in a couple minutes. You can also just ask me anything about editing."
        var welcome = ChatMessage(role: .assistant, content: "")
        welcome.isOnboarding = true
        let welcomeId = welcome.id
        messages = [welcome]
        Task { @MainActor in
            await typewriteReveal(fullText, intoMessageId: welcomeId)
            persistMessages()
        }
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
                tapAddVideo()
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
                        MessageBubble(
                            message: message,
                            onRegenerate: regenerateClosure(for: message),
                            onEdit: editClosure(for: message)
                        )
                        .id(message.id)
                    }

                    // Bottom-of-list sentinel. Since LazyVStack only
                    // renders rows in the visible region, this view's
                    // onAppear/onDisappear is a reliable signal for
                    // "is the user looking at the very bottom of the
                    // chat?" without per-frame geometry math.
                    Color.clear
                        .frame(height: 1)
                        .id("chat-bottom-sentinel")
                        .onAppear {
                            withAnimation(.easeOut(duration: 0.18)) {
                                isAtBottom = true
                            }
                        }
                        .onDisappear {
                            withAnimation(.easeOut(duration: 0.18)) {
                                isAtBottom = false
                            }
                        }
                }
                .padding(16)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .overlay(alignment: .bottom) {
                // Scroll-to-bottom floating button — iMessage / ChatGPT
                // pattern. Only surfaces when the bottom sentinel is
                // off-screen (user scrolled up). Tap returns the view
                // to the latest message.
                if !isAtBottom {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.easeOut(duration: 0.25)) {
                            proxy.scrollTo("chat-bottom-sentinel", anchor: .bottom)
                        }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(.white)
                            .frame(width: 36, height: 36)
                            .background(.ultraThinMaterial, in: Circle())
                            .overlay(
                                Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5)
                            )
                            .shadow(color: .black.opacity(0.25), radius: 10, y: 4)
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 12)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .accessibilityLabel("Scroll to latest message")
                }
            }
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
                Button { tapAddVideo() } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundColor(.white)
                        .frame(width: 36, height: 36)
                        .accessibilityHidden(true)
                }
                .accessibilityLabel("Add video")
                .sensoryFeedback(.impact(weight: .light), trigger: showVideoPicker)
                // Mirror the mic/send button's leading-edge + bottom
                // insets (.trailing 5 + .bottom 5 below) so both sides of
                // the composer bracket the input field at the same offset.
                // Without this, the "+" was flush at the bottom-left while
                // the mic sat 5pt up + 5pt in, reading as "off center."
                .padding(.leading, 5)
                .padding(.bottom, 5)

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

                ZStack {
                    // Mic — surfaces when the input is empty and there's
                    // nothing pending. Tap opens the full-screen voice
                    // input sheet (SFSpeechRecognizer, native, on-device
                    // when supported). ChatGPT iOS parity.
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        showVoiceInput = true
                    } label: {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.black)
                            .frame(width: 30, height: 30)
                            .background(Color.white)
                            .clipShape(Circle())
                            .accessibilityHidden(true)
                    }
                    .opacity(canSend ? 0 : 1)
                    .scaleEffect(canSend ? 0.5 : 1)
                    .accessibilityLabel("Voice input")
                    .allowsHitTesting(!canSend)

                    // Send — surfaces the moment there's something to send.
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.black)
                            .frame(width: 30, height: 30)
                            .background(Color.white)
                            .clipShape(Circle())
                            .accessibilityHidden(true)
                    }
                    .opacity(canSend ? 1 : 0)
                    .scaleEffect(canSend ? 1 : 0.5)
                    .accessibilityLabel("Send")
                    .allowsHitTesting(canSend)
                    .sensoryFeedback(.impact(weight: .medium), trigger: isSending)
                }
                .animation(.spring(response: 0.28, dampingFraction: 0.7), value: canSend)
                .padding(.trailing, 5)
                .padding(.bottom, 5)
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
        // Empty input + no video = nothing to send.
        if inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && pendingVideos.isEmpty {
            return false
        }
        // Video sends still gate on isSending so we don't dispatch
        // duplicate render jobs mid-spawn. Pure text sends are always
        // allowed — sending a new message cancels the in-flight stream
        // (ChatGPT iOS pattern).
        if !pendingVideos.isEmpty {
            return !isSending
        }
        return true
    }

    // MARK: - Add-video tap gating
    //
    // Free users can have a max of ONE video in the composer's pending
    // tray at a time. Pro unlocks up to ten. The native picker enforces
    // the count for the SELECTION itself (via `pickerMaxSelection`), but
    // we ALSO need to gate the entry point — otherwise a free user who
    // already has 1 pending could tap + and the picker would open with
    // max=0, which renders awkwardly. Instead we pop the paywall when
    // they try to exceed their cap.

    private var maxPendingVideos: Int {
        SubscriptionService.shared.isPro ? 10 : 1
    }

    /// What the picker should allow on its next presentation. Accounts
    /// for videos already pending so a Pro user with 7 staged can still
    /// add 3 more, but a free user with 1 staged hits zero (and the +
    /// button should have popped the paywall before we got here).
    private var pickerMaxSelection: Int {
        max(0, maxPendingVideos - pendingVideos.count)
    }

    /// Routed from the + button (composer + empty-state). Pops the
    /// paywall when a free user already has their one pending slot
    /// filled; otherwise opens the picker.
    private func tapAddVideo() {
        if pendingVideos.count >= maxPendingVideos {
            if SubscriptionService.shared.isPro {
                // Pro user at the 10-video cap. No paywall to pop — they
                // already paid. Just give haptic feedback and a console
                // log. UI also disables visibly via the picker count.
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
                return
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            appState.paywallReason = .manual
            return
        }
        showVideoPicker = true
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

                        // Encode the Gemini proxy in parallel with the
                        // upcoming source upload. Proxy failure is NON-
                        // FATAL per the worker contract: if extraction
                        // throws we just leave proxyFile nil, skip the
                        // proxy upload, and dispatch the job without
                        // `proxy_video_url`. The worker falls back to
                        // its own 480p@10fps encode in that case —
                        // ~7-10s slower than the client path but the
                        // render still completes correctly.
                        //
                        // VideoProxyExtractor matches the worker's exact
                        // spec (H.264 480p height @ 10fps CFR, AAC mono
                        // 48kbps, MP4 faststart) so the worker accepts
                        // the upload and skips its on-server encode.
                        let proxyExtractStart = Date()
                        let proxyFile: URL?
                        do {
                            proxyFile = try await VideoProxyExtractor.extract(from: materializedSourceUrl)
                            print(String(format: "[perf] proxy-extract %.2fs", Date().timeIntervalSince(proxyExtractStart)))
                        } catch {
                            print("[perf] proxy-extract FAILED (non-fatal, worker will encode its own): \(error.localizedDescription)")
                            proxyFile = nil
                        }

                        // Parallel uploads. Proxy is best-effort (any
                        // failure leaves proxyUploadedUrl nil so the
                        // dispatcher omits proxy_video_url); source is
                        // load-bearing (failure must abort the whole
                        // task so the render doesn't 404 the worker).
                        let uploadStart = Date()
                        async let proxyUpload: Void = {
                            // Always flip proxyUploadFinished on exit (success
                            // OR failure OR skip) so the dispatcher can stop
                            // waiting. proxyUploadedUrl distinguishes which:
                            // set = success, nil = no proxy will be sent.
                            defer {
                                Task { @MainActor in pending.proxyUploadFinished = true }
                            }
                            guard let proxyFile else { return }
                            do {
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
                            } catch {
                                // Non-fatal — proxy upload failures fall
                                // back to worker's on-server encode.
                                try? FileManager.default.removeItem(at: proxyFile)
                                print("[perf] proxy upload FAILED (non-fatal): \(error.localizedDescription)")
                            }
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
                                // Bytes are in S3 now — release the job
                                // dispatcher. `uploadedUrl` was set early
                                // (line 985) for prewarm + UI, but the
                                // dispatcher gates on `sourceUploadCompleted`
                                // so a slow upload can't trigger a job that
                                // would 404 + time the worker out.
                                pending.sourceUploadCompleted = true
                            }
                            print("[perf] source upload complete (background)")
                        }()

                        // proxyUpload swallows its own errors so await
                        // is non-throwing here — only the source upload
                        // can fail the whole task.
                        _ = await proxyUpload
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
                            // For the .stream / single-PUT paths, control
                            // only reaches here after the upload has
                            // returned — so the bytes are confirmed in S3
                            // and the dispatcher can fire immediately.
                            pending.sourceUploadCompleted = true
                            // No proxy path on .stream / single-PUT —
                            // worker encodes its own. Flip the proxy-
                            // finished flag immediately so the dispatcher
                            // doesn't hang waiting for a proxy upload
                            // that's never going to come.
                            pending.proxyUploadFinished = true
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
        "Viral hype",
        "Sales pitch",
        "Storytime",
        "Tutorial style",
        "Make it educational",
        "Cinematic and moody",
        "Confessional vlog",
        "Documentary feel",
        "Comedy timing",
        "Motivational",
        "Make it good"
    ]

    // MARK: - Per-message context menu (Regenerate / Edit)
    //
    // Closures returned per-message gate WHICH affordances surface for
    // a given message kind. We don't want "Regenerate" showing up on
    // the welcome message, on in-flight thinking bubbles, or on video
    // render messages — none of those are meaningful to regenerate.
    // Same for Edit: only user TEXT messages, never the user video tile.

    private func regenerateClosure(for message: ChatMessage) -> (() -> Void)? {
        // Only on assistant text replies. Skip welcome, thinking, video.
        // Failed/empty messages STAY eligible — that's the retry path
        // for "Couldn't respond. Long-press to try again."
        guard message.role == .assistant,
              !message.isOnboarding,
              !message.isThinking,
              message.renderedVideoUrl == nil,
              message.jobStatus == nil else { return nil }
        let messageId = message.id
        return {
            Task { @MainActor in
                regenerate(messageId: messageId)
            }
        }
    }

    private func editClosure(for message: ChatMessage) -> (() -> Void)? {
        // Only on user TEXT messages (no video attachment).
        guard message.role == .user,
              message.videoAttachment == nil,
              !message.content.isEmpty else { return nil }
        let messageId = message.id
        return {
            Task { @MainActor in
                edit(messageId: messageId)
            }
        }
    }

    /// Regenerate the assistant message at `messageId`. Replaces its
    /// content with a fresh streaming response derived from the prior
    /// conversation (everything BEFORE this message). The user message
    /// that prompted this reply stays put; only the assistant's answer
    /// is re-rolled.
    private func regenerate(messageId: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == messageId }) else { return }
        guard idx > 0 else { return }
        // Find the user prompt that produced this assistant reply.
        var promptIdx = idx - 1
        while promptIdx >= 0 && messages[promptIdx].role != .user {
            promptIdx -= 1
        }
        guard promptIdx >= 0 else { return }
        let prompt = messages[promptIdx].content
        guard !prompt.isEmpty else { return }

        // Rebuild conversation context from messages strictly BEFORE
        // the prompt (so the prompt is the "current" turn). Skip
        // onboarding and empty messages.
        let context: [[String: String]] = messages[..<promptIdx].compactMap { m in
            if m.isOnboarding { return nil }
            guard !m.content.isEmpty else { return nil }
            if m.role == .user { return ["role": "user", "content": m.content] }
            if m.role == .assistant { return ["role": "assistant", "content": m.content] }
            return nil
        }

        // Cancel any in-flight chat task before re-rolling this slot.
        activeChatTask?.cancel()

        // Reset the assistant message to thinking state and re-stream.
        messages[idx].content = ""
        messages[idx].isThinking = true
        messages[idx].error = nil

        activeChatTask = Task { @MainActor in
            await streamReplyWithFallback(
                intoMessageId: messageId,
                prompt: prompt,
                context: context
            )
        }
    }

    /// Edit a previous user message: pull its content into the input
    /// bar, truncate everything from that message forward, and let the
    /// user resend. Same behavior as ChatGPT iOS — re-forks the
    /// conversation from that point.
    private func edit(messageId: UUID) {
        guard let idx = messages.firstIndex(where: { $0.id == messageId }) else { return }
        let original = messages[idx].content
        inputText = original
        // Truncate this message and everything after it. Cancel any
        // SSE streams attached to those messages along the way.
        for m in messages[idx...] {
            if let jobId = m.jobId {
                sseClients[jobId]?.disconnect()
                sseClients.removeValue(forKey: jobId)
            }
        }
        messages = Array(messages[..<idx])
        // Rebuild conversation history to match.
        conversationHistory = messages.compactMap { m in
            if m.isOnboarding { return nil }
            guard !m.content.isEmpty else { return nil }
            if m.role == .user { return ["role": "user", "content": m.content] }
            if m.role == .assistant { return ["role": "assistant", "content": m.content] }
            return nil
        }
        persistMessages()
        isInputFocused = true
    }

    /// Common streaming-into-an-existing-message helper used by
    /// regenerate. Mirrors the inline streaming logic in send() but
    /// reuses the existing message slot rather than appending.
    @MainActor
    /// The bulletproof chat reply path. Called by both the initial
    /// Send and the Regenerate context-menu action.
    ///
    /// Tier 1: Stream from `/api/chat/stream` (SSE). Token-by-token
    /// reveal. Natural ChatGPT-style typing animation, no UI tricks.
    ///
    /// Tier 2: If the stream throws OR completes with no tokens
    /// (Render's proxy buffering SSE despite our headers, transient
    /// 5xx, etc.), fall through to the one-shot `/api/chat` endpoint
    /// for the full response, then SIMULATE the typewriter effect on
    /// the client by progressively revealing the text. Users get the
    /// same visual outcome whether the streaming path works or not.
    ///
    /// Cancellation: the caller stores the surrounding Task on
    /// `activeChatTask`. Sending a new message cancels it, the
    /// `Task.isCancelled` checks here exit early, and whatever content
    /// was already revealed stays in place — same behavior as ChatGPT
    /// when you interrupt a streaming response.
    ///
    /// Persistence: `persistMessages()` only fires on a clean
    /// completion. Mid-cancellation persists are avoided so the chat
    /// store doesn't save half-streamed messages that look broken on
    /// reload.
    private func streamReplyWithFallback(
        intoMessageId messageId: UUID,
        prompt: String,
        context: [[String: String]]
    ) async {
        func idx() -> Int? { messages.firstIndex(where: { $0.id == messageId }) }

        // Buffered typewriter pattern. Streaming tokens land in
        // `buffer.text` as they arrive from Gemini — but the actual UI
        // reveal is paced by a parallel typewriter that advances at a
        // constant rate. Gemini's SSE chunks are wildly uneven (often
        // a whole sentence at a time, with multi-second pauses between
        // bursts), so writing tokens directly to the bubble felt chunky
        // and stop-and-go. The typewriter smooths that out: every chat
        // reply now reveals at a steady ChatGPT-style pace regardless
        // of upstream pacing. When tokens arrive faster than the
        // typewriter can reveal, the buffer absorbs the excess and the
        // typewriter catches up over the following ticks; when they
        // arrive slower, the typewriter just keeps pace with the stream.
        let buffer = StreamBuffer()

        let typewriter = Task { @MainActor in
            let chunkSize = 5
            let tickNanos: UInt64 = 22_000_000
            var sawFirstReveal = false
            var revealedCount = 0
            while !Task.isCancelled {
                let total = buffer.text.count
                if revealedCount < total {
                    revealedCount = min(revealedCount + chunkSize, total)
                    if let i = idx() {
                        let prefix = String(buffer.text.prefix(revealedCount))
                        if !sawFirstReveal {
                            sawFirstReveal = true
                            messages[i].isThinking = false
                            messages[i].error = nil
                        }
                        messages[i].content = prefix
                    }
                    try? await Task.sleep(nanoseconds: tickNanos)
                } else if buffer.done {
                    return
                } else {
                    // Waiting for more tokens — small sleep so we don't
                    // tight-loop on the MainActor.
                    try? await Task.sleep(nanoseconds: tickNanos)
                }
            }
        }

        // ── Tier 1: streaming ─────────────────────────────────────────
        var hitPaywall = false
        var paywallReason: PaywallReason?
        let stream = APIService.shared.chatStream(message: prompt, history: context)
        do {
            for try await token in stream {
                if Task.isCancelled { typewriter.cancel(); return }
                buffer.text += token
            }
        } catch let APIError.paymentRequired(_, limit, _) {
            // Server hit the daily chat cap. No point falling back to the
            // one-shot endpoint — it'd just 402 again. Skip tier 2 and
            // route directly to the paywall.
            let lim = limit ?? 50
            paywallReason = .dailyChats(used: lim, limit: lim)
            hitPaywall = true
        } catch {
            print("[chat] stream failed: \(error.localizedDescription) — falling back")
        }

        if Task.isCancelled { typewriter.cancel(); return }

        // ── Tier 2: one-shot fallback ──────────────────────────────────
        // Stream silently buffered or threw — try the non-streaming
        // endpoint and dump the whole reply into the buffer. The
        // typewriter takes care of revealing it smoothly.
        if buffer.text.isEmpty && !hitPaywall {
            do {
                let reply = try await APIService.shared.chat(message: prompt, history: context)
                if Task.isCancelled { typewriter.cancel(); return }
                buffer.text = reply
            } catch let APIError.paymentRequired(_, limit, _) {
                // Daily AI chat cap. Pop the paywall sheet and remove the
                // empty assistant bubble — the user didn't really get a
                // reply, no point persisting one.
                let lim = limit ?? 50
                paywallReason = .dailyChats(used: lim, limit: lim)
                hitPaywall = true
            } catch {
                print("[chat] one-shot fallback failed: \(error.localizedDescription)")
            }
        }

        // Signal the typewriter that no more tokens are coming. It will
        // finish revealing whatever's left in the buffer, then exit.
        buffer.done = true
        await typewriter.value

        if Task.isCancelled { return }

        // ── Finalize ──────────────────────────────────────────────────
        if hitPaywall {
            if let reason = paywallReason {
                appState.paywallReason = reason
            }
            await UsageService.shared.refresh()
            if let i = idx() {
                messages.remove(at: i)
                persistMessages()
            }
            return
        }
        if let i = idx() {
            messages[i].isThinking = false
            if buffer.text.isEmpty {
                // Both tiers failed. Surface a clean error state via the
                // typewriter too, so even the failure mode feels alive
                // instead of slamming in an error string.
                messages[i].error = "chat_failed"
                await typewriteReveal("Couldn't respond. Long-press to try again.", intoMessageId: messageId)
            } else {
                messages[i].content = buffer.text
                messages[i].error = nil
                conversationHistory.append(["role": "assistant", "content": buffer.text])
            }
            persistMessages()
        }
    }

    /// Reference-type box for the streaming buffer + done signal so the
    /// streaming loop and the typewriter task can both see each other's
    /// mutations. Both run on the MainActor so access is naturally
    /// serialized; no locking required.
    @MainActor
    private final class StreamBuffer {
        var text: String = ""
        var done: Bool = false
    }

    /// Progressively reveal `text` into the assistant message at
    /// `messageId`, character-chunk by character-chunk. Used when the
    /// streaming path silently buffers and we have to fall back to
    /// the one-shot endpoint — the user still sees the typewriter
    /// effect even though all the tokens already arrived. Cancellable
    /// via `Task.isCancelled` so a new send halts the reveal cleanly.
    private func typewriteReveal(_ text: String, intoMessageId messageId: UUID) async {
        func idx() -> Int? { messages.firstIndex(where: { $0.id == messageId }) }
        guard !text.isEmpty else { return }

        // ~5 chars per 22ms tick = ~227 chars/sec. Tuned to match the
        // perceived speed of native Gemini streaming when it does work.
        let chunkSize = 5
        let tickNanos: UInt64 = 22_000_000

        var pos = text.startIndex
        while pos < text.endIndex {
            if Task.isCancelled { return }
            let next = text.index(pos, offsetBy: chunkSize, limitedBy: text.endIndex) ?? text.endIndex
            pos = next
            if let i = idx() {
                if messages[i].isThinking { messages[i].isThinking = false }
                messages[i].content = String(text[..<pos])
                messages[i].error = nil
            }
            try? await Task.sleep(nanoseconds: tickNanos)
        }
    }

    // MARK: - Input field clear
    //
    // TextField(axis: .vertical) holds its text in an internal
    // UITextView. When the field is focused and we reset the binding
    // in the same render tick as the send, SwiftUI sometimes diffs
    // away the empty-string write and the typed text stays visible.
    // Workaround: clear immediately for the canSend animation, then
    // re-clear on the next runloop tick to win the focus/binding race.
    private func clearInputField() {
        inputText = ""
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 16_000_000) // ~1 frame
            if !inputText.isEmpty { inputText = "" }
        }
    }

    // MARK: - Text-only chat send
    //
    // Bypasses the heavy video-flow Task chain entirely. Synchronously
    // appends user+thinking bubbles, snapshots history, spawns a
    // cancellable Task that runs streamReplyWithFallback. No isSending
    // gate — the user can fire another message immediately and the
    // previous in-flight task gets cancelled.
    private func sendTextChatMessage(_ text: String) {
        // Cancel any in-flight chat task. Its partial content stays
        // visible (intentional — same as ChatGPT iOS interruption).
        activeChatTask?.cancel()

        clearInputField()

        // User bubble appears IMMEDIATELY. Was the build-139 bug —
        // user message wasn't being appended at all in text-only.
        let userMsg = ChatMessage(role: .user, content: text)
        messages.append(userMsg)
        conversationHistory.append(["role": "user", "content": text])

        let thinkingMsg = ChatMessage(role: .assistant, content: "", isThinking: true)
        messages.append(thinkingMsg)
        let msgId = thinkingMsg.id

        // History snapshot must EXCLUDE the message we just appended
        // — that's the CURRENT turn, sent as `message` separately.
        let historySnapshot = Array(conversationHistory.dropLast().suffix(20))

        activeChatTask = Task { @MainActor in
            _ = await ensureActiveChat()
            persistMessages()
            await streamReplyWithFallback(
                intoMessageId: msgId,
                prompt: text,
                context: historySnapshot
            )
        }
    }

    // MARK: - Send

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasVideos = !pendingVideos.isEmpty
        let reeditActive = reeditSession != nil
        guard !text.isEmpty || hasVideos else { return }

        // ── Text-only chat fast path ──────────────────────────────────
        // No video, no re-edit session — route to the lightweight
        // text path that doesn't lock isSending or wait on chat
        // creation. User can send another message immediately.
        if !hasVideos && !reeditActive {
            sendTextChatMessage(text)
            return
        }

        // Nudge: a video with no vibe is unrenderable — without a
        // creative direction the worker has nothing to optimize for.
        // Instead of silently substituting a generic prompt and burning
        // a render slot, ask the user for a vibe (and surface the
        // chip suggestions). Re-edit is exempt — it operates on the
        // existing edit recipe so empty text means "no further change."
        if hasVideos && text.isEmpty && !reeditActive {
            let nudgeText = "Tell me the vibe you want and I'll edit it. Try one of the suggestions below — or describe it in your own words."
            let nudge = ChatMessage(role: .assistant, content: "")
            let nudgeId = nudge.id
            messages.append(nudge)
            isInputFocused = true
            Task { @MainActor in
                await typewriteReveal(nudgeText, intoMessageId: nudgeId)
            }
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
            clearInputField()
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
                } catch let APIError.paymentRequired(kind, limit, _) {
                    // Re-edit is a Pro-only endpoint, but a free user could
                    // slip through if the client gate was bypassed (or if
                    // entitlement state was stale at tap time). Remove the
                    // stub processing+user bubbles and present the paywall.
                    if let i = idx() {
                        messages.remove(at: i)  // assistant processing
                    }
                    if !messages.isEmpty, messages.last?.role == .user {
                        messages.removeLast()  // user "change request" stub
                    }
                    persistMessages()
                    if kind == "reedit" {
                        appState.paywallReason = .reedit
                    } else {
                        let lim = limit ?? 3
                        appState.paywallReason = .dailyRenders(used: lim, limit: lim)
                    }
                    await UsageService.shared.refresh()
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

        clearInputField()
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

            // hasVideos is guaranteed true here: the text-only fast path
            // returned at the top of send(), and the re-edit branch
            // returned in its own block. So the inner Task chain below
            // is only ever reached on the video flow.
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
                            //
                            // Wait specifically for `sourceUploadCompleted`
                            // — bytes confirmed in S3. The previous version
                            // dispatched as soon as `uploadedUrl` was set,
                            // but that field is published EARLY (the moment
                            // we know the eventual URL, before the PUT
                            // finishes) so the prewarm + UI can react. The
                            // worker only polls for the file for 180s, so
                            // dispatching before the bytes land caused the
                            // worker to 404 + give up on slow cellular
                            // uploads. Production failure: 26s clip,
                            // worker polled for 183s, never saw the file,
                            // returned "Source video did not arrive on S3."
                            //
                            // Deadline raised from 60s → 240s. A large clip
                            // on slow cellular legitimately takes 90-180s
                            // to upload; the old 60s cap was racing real
                            // uploads on bad networks.
                            let waitDeadline = Date().addingTimeInterval(240)
                            // Dispatch waits for BOTH the source upload AND
                            // the proxy upload Task to reach a terminal
                            // state. Source success is load-bearing (the
                            // render needs the bytes in S3). Proxy "finish"
                            // can be either success or known-failure — in
                            // the failure case proxyUploadedUrl stays nil
                            // and we just omit proxy_video_url from the
                            // render dispatch (worker falls back to its
                            // on-server encode). The spec is explicit:
                            // never pass a proxy URL pointing at bytes
                            // that aren't in S3 yet, or the worker wastes
                            // 30s of polling before falling back.
                            while !(video.uploadFailed) &&
                                  !(video.sourceUploadCompleted && video.proxyUploadFinished) {
                                if Date() > waitDeadline {
                                    throw APIError.uploadFailed
                                }
                                // Mirror real upload progress (0…1) into the
                                // message progress bar so it fills smoothly
                                // during the upload (0→38) rather than sitting
                                // at 0 the whole time and then jumping to 40
                                // the instant dispatch fires. Once dispatch
                                // fires it nudges to 40, then SSE drives 40→100.
                                if let i = indexOfProcessingMsg() {
                                    let mapped = Int(video.uploadProgress * 38)
                                    if mapped > (messages[i].jobProgress ?? 0) {
                                        messages[i].jobProgress = mapped
                                    }
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
                        } catch let APIError.paymentRequired(kind, limit, _) {
                            // Server says they're over the daily render cap
                            // (or hit the re-edit Pro gate). Remove the
                            // stub processing bubble — they didn't actually
                            // dispatch a job — and present the paywall.
                            if let i = indexOfProcessingMsg() {
                                messages.remove(at: i)
                                persistMessages()
                            }
                            if kind == "reedit" {
                                appState.paywallReason = .reedit
                            } else {
                                let lim = limit ?? 3
                                appState.paywallReason = .dailyRenders(used: lim, limit: lim)
                            }
                            await UsageService.shared.refresh()
                        } catch {
                            if let i = indexOfProcessingMsg() {
                                messages[i].jobStatus = "failed"
                                messages[i].error = error.localizedDescription
                                persistMessages()
                            }
                        }
                    }
                }
            }
            isSending = false
        }
    }

    // MARK: - Stuck detection
    //
    // Periodic reconcile against the DB at 90s + 180s after dispatch.
    // Does NOT mark the message as failed — that was the build 134 bug:
    // a normal render takes 90-180s, and when SSE drops because the
    // user closed the app, the stuck detector would fire mid-render
    // and falsely mark "didn't start" even though the worker was
    // happily processing. The actual completion would then arrive via
    // push but the chat was already stuck on a fake failure that the
    // foreground reconcile (filtered to processing-only) wouldn't heal.
    //
    // New behavior: only ASK the DB what the current state is. If DB
    // says completed/failed, update accordingly. If DB still says
    // processing, do nothing — the periodic heartbeat + foreground
    // reconcile will catch the actual completion.
    private func scheduleStuckDetector(messageId: UUID, jobId: String) {
        Task { @MainActor in
            for delaySec in [90, 180] {
                try? await Task.sleep(for: .seconds(delaySec))
                guard let i = messages.firstIndex(where: { $0.id == messageId }) else { return }
                let status = messages[i].jobStatus ?? ""
                if status == "completed" || status == "complete" || status == "failed" || status == "error" {
                    return
                }
                // No progress past the static 40% "analyze" plant?
                // Re-check the DB — but never mark failed locally.
                // Either the worker IS still processing (push fires
                // later) or it actually errored (reconcile will see
                // "failed" in DB and update).
                if (messages[i].jobProgress ?? 0) <= 41 {
                    await reconcileJobStatus(jobId: jobId)
                }
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
        guard let token = await AuthService.shared.getValidToken() else {
            print("[reconcile] \(jobId) skipped — no valid token")
            return
        }

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
            let (data, response) = try await URLSession.shared.data(for: request)
            if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
                // Auth blip or RLS denial — log it so we can see in console
                // why a stuck render isn't reconciling. The next heartbeat
                // tick retries with a freshly-validated token.
                let body = String(data: data, encoding: .utf8) ?? ""
                print("[reconcile] \(jobId) HTTP \(http.statusCode) — \(body.prefix(200))")
                return
            }
            guard let row = (try? JSONDecoder().decode([JobStatusRow].self, from: data))?.first else {
                print("[reconcile] \(jobId) decode failed or empty row")
                return
            }
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
