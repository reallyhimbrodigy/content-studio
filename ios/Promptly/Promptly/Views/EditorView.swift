import SwiftUI
import PhotosUI
import UIKit

struct EditorView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject private var chatStore = ChatStore.shared
    // Observed so the model picker can reconcile its selection the moment
    // entitlement changes (effectiveIsPro = subscription.isPro || usage.isPro).
    @ObservedObject private var subscriptionService = SubscriptionService.shared
    @ObservedObject private var usageService = UsageService.shared
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var showVideoPicker = false
    /// Pre-permission explainer for push notifications, shown once on the first
    /// upload (see handlePickedVideos) — never cold at app open.
    @State private var showPushExplainer = false
    @State private var showVoiceInput = false
    @State private var pendingVideos: [PendingVideo] = []
    @State private var isSending = false
    @State private var conversationHistory: [[String: String]] = []
    @State private var sseClients: [String: SSEClient] = [:]
    @State private var reeditSession: ReeditSession?
    /// Ask-back ids the user has already answered this session — so a stale
    /// in-flight poll (captured before the answer) can't re-park the same ask.
    @State private var answeredAskIds: Set<String> = []
    @State private var loadedChatId: String? = nil
    // ghostIndex removed — the rotating ghost-text suggestion was
    // replaced in build 172 with always-visible vibe chips above the
    // input (ChatGPT-style). Users couldn't discover the swipe-right-
    // to-accept gesture the rotation depended on; the chips are tap
    // targets so the affordance is obvious.
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

    /// Layer 1 (TalkingHeadPrecheck) rejection state. When a picked
    /// video fails the on-device face-detection precheck we stash
    /// the continuation here and surface a SwiftUI alert; the user's
    /// "Try Anyway" / "Choose Another" tap resumes the picker flow
    /// with the right boolean.
    @State private var rejectedVideoCallback: ((Bool) -> Void)? = nil
    @State private var showPrecheckRejection: Bool = false

    /// Layer 2 (backend /validate) rejection state. Backend's
    /// user_message gets surfaced verbatim — it's authoritative on
    /// why the clip was rejected and the spec wants the wording
    /// passed through. Single "Choose Another" button (no Try Anyway
    /// here — Layer 2 is the backend's final call).
    @State private var showLayer2Rejection: Bool = false
    @State private var layer2RejectionMessage: String = ""
    // §4 cached sample-clip demo: non-nil presents the before→after reveal.
    @State private var demoReveal: DemoRevealData?

    /// Set when the backend rejects a render with requires_vibe_change=
    /// true. Holds the failed message's id so send() knows to route
    /// to retryFailedRender (with the user's NEW input text as the
    /// vibe) instead of treating Send as a fresh chat or render. A
    /// pill above the composer tells the user "Editing vibe for your
    /// previous video — tap to cancel" so the routing is never
    /// invisible. Cleared on successful re-dispatch, on user tap-to-
    /// cancel, or if the user closes the chat.
    @State private var pendingVibeEditMessageId: UUID? = nil

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
                    // Usage meter (freemium, staged for 1.3.1): renders left today
                    // + reset countdown, escalating to "Get more usage" at the cap.
                    // Hides itself for Pro. Sits directly above the composer bubble
                    // and inherits the shared gradient below.
                    UsageMeterStrip { appState.presentPaywall(.manual) }
                    inputBar
                }
                // Same solid black as the content + nav — no fade scrim (it read
                // as a band above the composer on-device).
                .background(Color.black)
            }
            // Custom SwiftUI top bar (build 216) — the pill lives HERE, not the
            // NavigationStack toolbar, whose UIKit host froze two animation
            // drivers and mangled the logo across builds 214 & 215. The system
            // toolbar bought nothing once the title was gone. Plain HStack on the
            // unified black: hamburger · pill · new-chat.
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) { customTopBar }
            .sheet(isPresented: $showVideoPicker) {
                NativeVideoPicker(maxSelection: pickerMaxSelection) { videos in
                    handlePickedVideos(videos)
                }
                .ignoresSafeArea()
            }
            // Layer 1 (TalkingHeadPrecheck) rejection alert. Surfaced
            // when the on-device Vision precheck doesn't find a face
            // in enough sampled frames; lets the user pick a different
            // clip without paying the upload + render cost.
            .alert("Try a different video", isPresented: $showPrecheckRejection) {
                Button("Choose Another", role: .cancel) {
                    rejectedVideoCallback?(false)
                    rejectedVideoCallback = nil
                }
                Button("Try Anyway") {
                    rejectedVideoCallback?(true)
                    rejectedVideoCallback = nil
                }
            } message: {
                Text("Promptly works best with videos of someone talking on camera. Pick another clip?")
            }
            // Layer 2 (backend /validate) rejection alert. Backend's
            // user_message is authoritative — surfaced verbatim.
            // Single "Choose Another" button: the backend already
            // ran a higher-confidence check on the actual sample, so
            // there's no "Try Anyway" escape hatch here.
            .alert("Try a different video", isPresented: $showLayer2Rejection) {
                Button("Choose Another", role: .cancel) {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    showVideoPicker = true
                }
            } message: {
                Text(layer2RejectionMessage)
            }
            // Push opt-in — a PRE-PERMISSION explainer shown once on the first
            // upload (never cold at app open). "Notify me" is the ONLY path to the
            // iOS system dialog; "Not now" leaves the system one-shot intact. This
            // recovers the completions currently lost to never-granted permission.
            // Extracted into a ViewModifier so its closures type-check in isolation
            // (the body's modifier chain is already at the compiler's complexity limit).
            .modifier(PushExplainerAlert(isPresented: $showPushExplainer))
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
            .fullScreenCover(item: $demoReveal) { data in
                SampleDemoReveal(
                    rawUrl: data.raw,
                    editedUrl: data.edited,
                    onUpload: { demoReveal = nil; tapAddVideo() },
                    onClose: { demoReveal = nil }
                )
            }
            .onAppear {
                // Downgrade safety: if entitlement lapsed while a premium
                // model was selected, fall back to Flare so nobody is
                // stranded on an inaccessible model. No-op for everyone else.
                ModelService.shared.reconcile(isPro: SubscriptionService.shared.effectiveIsPro)
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
            // Downgrade safety, live: if entitlement lapses while the editor is
            // on screen, fall back to Flare immediately so the pill never
            // advertises a model the user can no longer use. (The render path
            // is already safe — premiumPipelineFlag reads effectiveIsPro live
            // at send time.)
            .onChange(of: subscriptionService.effectiveIsPro) { _, isPro in
                ModelService.shared.reconcile(isPro: isPro)
            }
            // Ghost-text rotation task removed in build 172 — replaced
            // with always-visible vibe chips above the input. No more
            // animation timer needed; the chips are static affordances.
            .onChange(of: appState.pendingReedit) { _, newSession in
                if let s = newSession {
                    reeditSession = s
                    appState.pendingReedit = nil
                    isInputFocused = true
                }
            }
            // Post-auth landing (build 217): landOnChat() bumps this token on
            // every sign-in, so the composer is ALWAYS focused after auth (a
            // short delay lets the sheet dismissals settle before the keyboard
            // rises).
            .onChange(of: appState.composerFocusToken) { _, _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
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
                // Immediate poll on launch/appear so a relaunch resumes the
                // bar at TRUE progress (or jumps straight to a video that
                // finished while the app was closed) without waiting for the
                // first heartbeat tick.
                await reconcileInProgressJobs(includeFailed: true)
                while !Task.isCancelled {
                    let hasInFlight = messages.contains { m in
                        guard m.jobId != nil else { return false }
                        return m.jobStatus == "processing" ||
                               m.jobStatus == "queued" ||
                               m.jobStatus == "needs_input" ||   // parked on a question — keep polling
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
        // Clear any in-flight vibe-edit routing — the failed-message
        // id we were holding belonged to the OLD chat. Sending in
        // the new chat should behave normally, not try to retry a
        // render that isn't visible here.
        pendingVibeEditMessageId = nil

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
            startSSE(jobId: jobId, messageId: msg.id)
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
        // Onboarding → picker BRIDGE: seed the composer with the style the user
        // chose in the intent question, so they land ON A VIBE, not a blank
        // field. Consumed once (cleared) so it never re-applies to a later empty
        // chat. This is what makes Q2's preselect actually reach the render.
        if inputText.isEmpty, let vibe = OnboardingState.shared.preselectedVibe, !vibe.isEmpty {
            inputText = vibe
            OnboardingState.shared.preselectedVibe = nil
        }
        let fullText = "Hey, I'm Promptly. Drop a clip and tell me the vibe — viral hype, sales pitch, storytime, whatever you're going for. I'll cut it, caption it, add B-roll, and have your edit back in a couple minutes. You can also just ask me anything about editing."
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
    /// (no decorative tinted background), a single concise subtitle, and a
    /// borderless prominent button — upload-first, no brand-name title (the
    /// nav title already carries it). Avoids the "AI startup hero" feel — no
    /// accent-color circles, no marketing copy, no white capsule. Native feel.
    private var emptyState: some View {
        // §4: on first run, lead with the sample-clip demo when the server has one
        // hosted — a felt success on a real clip before the user risks their own
        // footage. Otherwise (demo off, or a return visit to an empty chat) fall
        // back to the upload-first hero. Both live in FirstRunHero so the shipped
        // surface and the review screenshots are one source of truth.
        FirstRunHero(
            mode: usageService.sampleDemoAvailable ? .demo : .uploadOnly,
            onWatchDemo: {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                startSampleDemo()
            },
            onUpload: {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                tapAddVideo()
            }
        )
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
                            onEdit: editClosure(for: message),
                            onRetry: retryClosure(for: message),
                            onMakeAnother: { tapAddVideo() },
                            onCancel: cancelClosure(for: message),
                            onAskResolved: askResolvedClosure(for: message)
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
                // Vibe entry = send intent: focusing the composer with a clip pending
                // means a render is imminent. Re-fire the GPU warmup here (the earliest
                // reliable signal) so the container is hot by dispatch — the cold-start
                // race the backend traced. Idempotent; a second fire lands at send().
                if focused, !pendingVideos.isEmpty {
                    fireRenderWarmup()
                }
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

            // Vibe-edit pill. Visible only when the backend told us
            // to change the vibe and we're holding cached S3 URLs for
            // the previous source — Send routes to a re-dispatch with
            // the user's new wording, no upload. Tapping the X clears
            // the routing back to a normal Send.
            vibeEditPill

            // ChatGPT-style vibe-suggestion chips. Always visible when
            // the input is empty + we're not in a re-edit session, so
            // the affordance reads as an obvious tap target instead of
            // the previous hidden swipe-right gesture. Horizontally
            // scrollable since 3 chips don't fit on smaller iPhones.
            // Hides cleanly the moment the user starts typing.
            vibeChipRow

            HStack(alignment: .bottom, spacing: 0) {
                Button { tapAddVideo() } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(.white)
                        // 30×30 frame to MATCH the mic/send button on the
                        // right. Previously 36×36 with the same 5pt bottom
                        // padding — that put the "+" optical center 3pt
                        // ABOVE the mic/send center because the frames
                        // were different heights. Matching sizes makes
                        // both buttons sit at exactly the same y-position
                        // in the composer, which is what "centered" reads
                        // as to the eye.
                        .frame(width: 30, height: 30)
                        .accessibilityHidden(true)
                }
                .accessibilityLabel("Add video")
                .sensoryFeedback(.impact(weight: .light), trigger: showVideoPicker)
                .padding(.leading, 5)
                .padding(.bottom, 5)

                ZStack(alignment: .leading) {
                    // Static placeholder. The rotating ghost-text was
                    // removed in build 172 — the visible chip row above
                    // now carries the "here are some vibes" message.
                    if inputText.isEmpty && reeditSession == nil {
                        Text("Tell me the vibe…")
                            .font(.system(.body, design: .default).weight(.regular))
                            .tracking(0.3)
                            .foregroundColor(Color.white.opacity(0.35))
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
            // §7 (looks-like-a-product): the Flare/Lumen model picker was removed from
            // the composer — users never pick a model. The render tier now follows
            // their PLAN silently (Pro → premium pipeline, free → standard); see
            // ModelService.premiumPipelineFlag. Bottom padding folds into the input row.
            .padding(.bottom, 6)
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
        // Animate the chip row's appearance/disappearance as the user
        // starts/stops typing. easeInOut is enough — the chips already
        // do a fade + slide via their .transition.
        .animation(.easeInOut(duration: 0.22), value: inputText.isEmpty)
    }

    /// Featured vibes shown as ChatGPT-style tappable chips above the
    /// input. Three options instead of twelve: forces a clear, scannable
    /// affordance and keeps the chip row from sprawling. Each chip is
    /// short enough to read at a glance, distinct enough in feel to
    /// guide users toward different render styles.
    private static let featuredVibes: [String] = [
        "Viral engaging video",
        "Professional corporate style",
        "Fast paced punchy"
    ]

    /// Re-edit suggestion chips. Shown above the composer when a
    /// re-edit session is active and the input is empty. Each chip
    /// maps to a pattern the worker's plan-diff classifier reliably
    /// handles — split across the four ranges:
    ///   - Directional reshape ("Pace the middle faster", "Make the
    ///     captions punchier") → classifier upgrades to
    ///     guided_redraft, the new mode that keeps your prior plan
    ///     as soft default while reshaping the targeted region.
    ///   - Surgical ("Remove the second cutaway") → tweak mode,
    ///     touches only the named element.
    ///   - Add ("Add a zoom on the payoff") → tweak mode, single op.
    ///   - Total recast ("Redo it completely different") →
    ///     reinterpret mode.
    /// Picked for breadth: a user opening re-edit with no idea what
    /// to ask gets one example from each category.
    private static let reeditSuggestions: [String] = [
        "Pace the middle faster",
        "Make the captions punchier",
        "Add a zoom on the payoff",
        "Remove the second cutaway"
    ]

    /// Horizontally-scrollable chip row that surfaces the featured
    /// vibes above the composer. Tap a chip to insert its text into
    /// Pill that surfaces above the composer when the user is mid-
    /// vibe-edit. Tells them their next Send will re-render the
    /// previously-uploaded source video with the new wording. Single
    /// X button cancels the routing — Send then falls back to the
    /// normal text/render flow.
    @ViewBuilder
    private var vibeEditPill: some View {
        if pendingVibeEditMessageId != nil {
            HStack(spacing: 8) {
                Image(systemName: "wand.and.sparkles")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(.white.opacity(0.75))
                Text("Editing vibe for your previous video")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.white.opacity(0.88))
                    .lineLimit(1)
                Spacer(minLength: 6)
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    pendingVibeEditMessageId = nil
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundColor(.white.opacity(0.75))
                        .frame(width: 18, height: 18)
                        .background(
                            Circle().fill(Color.white.opacity(0.10))
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Cancel vibe edit")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                Capsule().fill(Color.white.opacity(0.08))
            )
            .overlay(
                Capsule().stroke(Color.white.opacity(0.16), lineWidth: 0.5)
            )
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .padding(.bottom, 4)
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    /// the input and focus the field — same as if the user typed it.
    /// Hides the moment the input has any text, so the chips never
    /// fight with what the user is composing.
    @ViewBuilder
    private var vibeChipRow: some View {
        // Two surfaces share the same chip row UI:
        //   - First-render: featured vibe chips ("Viral engaging…").
        //   - Re-edit: change-request suggestions matched to the
        //     worker's plan-diff classifier ("Pace the middle faster"…).
        // Picked via the same `inputText.isEmpty` gate so the chips
        // never fight with what the user is typing.
        let suggestions: [String]? = {
            guard inputText.isEmpty else { return nil }
            return reeditSession != nil ? Self.reeditSuggestions : Self.featuredVibes
        }()
        if let suggestions {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    // §5 reduce-steps: once a clip is picked with no vibe typed, the
                    // FIRST chip is a one-tap default — pick → tap → dispatch, zero
                    // composing (the right floor for a first render). Styled as a
                    // primary (filled) chip so it reads as "go", not "suggestion".
                    // The other chips still fill the composer as editable suggestions.
                    if !pendingVideos.isEmpty && reeditSession == nil {
                        Button {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            inputText = "Clean and engaging edit"
                            send()
                        } label: {
                            HStack(spacing: 6) {
                                Text("Clean & engaging")
                                    .font(.system(size: 13, weight: .semibold))
                                Image(systemName: "arrow.up.circle.fill")
                                    .font(.system(size: 13, weight: .semibold))
                            }
                            .foregroundColor(.black)
                            .padding(.horizontal, 13)
                            .padding(.vertical, 7)
                            .background(Capsule().fill(Color.white))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Edit now with a clean, engaging default")
                    }
                    ForEach(suggestions, id: \.self) { vibe in
                        Button {
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                            inputText = vibe
                            isInputFocused = true
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "sparkles")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundColor(Color.white.opacity(0.55))
                                Text(vibe)
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundColor(Color.white.opacity(0.88))
                                    .lineLimit(1)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 7)
                            .background(
                                Capsule()
                                    .fill(Color.white.opacity(0.06))
                            )
                            .overlay(
                                Capsule()
                                    .stroke(Color.white.opacity(0.14), lineWidth: 0.5)
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Use vibe: \(vibe)")
                    }
                }
                .padding(.horizontal, 10)
            }
            .padding(.top, 10)
            .padding(.bottom, 4)
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    // MARK: - Luxurious backdrop
    //
    // ONE SOLID BLACK (build 215): the nav bar, the content, and the composer
    // all share this exact background. The previous white-tint-at-top + vignette
    // gradient (and the composer's own fade scrim) read as visible two-tone
    // bands on-device, so they're gone — a single uniform black, no seams.
    private var luxuryBackdrop: some View {
        Color.black.ignoresSafeArea()
    }

    // MARK: - Custom top bar (build 216)
    //
    // Replaces the NavigationStack toolbar (which froze the pill's animation and
    // mangled its logo across two builds). A plain SwiftUI HStack on the unified
    // black: hamburger left, the animated UpgradePill beside it, new-chat right.
    // Attached via .safeAreaInset(.top); the nav bar is hidden. Buttons carry a
    // 40×40 tap target so nothing here is hard to hit.
    private var customTopBar: some View {
        HStack(spacing: 10) {
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
                    .foregroundColor(.white)
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Show chats")

            if !subscriptionService.effectiveIsPro {
                UpgradePill { appState.presentPaywall(.manual) }
            }

            Spacer(minLength: 8)

            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                Self.dismissKeyboard()
                Task { await startNewChat() }
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(width: 40, height: 40)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New chat")
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity)
        .background(Color.black)
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
        // Use effectiveIsPro so server-comped users (SQL-promoted, future
        // RevenueCat-out-of-sync paths) get the 10-cap immediately
        // without needing RevenueCat's client cache to catch up.
        SubscriptionService.shared.effectiveIsPro ? 10 : 1
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
            if SubscriptionService.shared.effectiveIsPro {
                // Pro user at the 10-video cap. No paywall to pop — they
                // already paid. Just give haptic feedback and a console
                // log. UI also disables visibly via the picker count.
                UINotificationFeedbackGenerator().notificationOccurred(.warning)
                return
            }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            // Free tier = 1 upload at a time; this is the second-upload cap
            // (presentPaywall(.manual) doesn't self-classify, so fire it here).
            Analytics.track("free_limit_hit", props: ["limit": "second_upload"])
            appState.presentPaywall(.manual)
            return
        }
        showVideoPicker = true
    }

    // MARK: - Video Selection (INSTANT — no copy, uses PHAsset directly)

    private func handlePickedVideos(_ videos: [PickedVideo]) {
        Task { @MainActor in
            for video in videos {
                // DURATION GATE — enforced at PICK TIME on PHAsset.duration, which
                // is metadata (no download), so it covers iCloud-only clips too and
                // fires the instant they tap, before any upload. PHPickerViewController
                // has no duration filter (it can't grey clips out), so this
                // select-then-explain is the achievable equivalent of "not selectable."
                // These are the ONLY hard duration rejections — under the 2.0s floor
                // can't yield a watchable edit; over the ceiling can't render. Same
                // wording/behaviour at both ends.
                let seconds = video.duration
                if seconds > 0 && seconds < Double(TalkingHeadPrecheck.minDurationSec) {
                    Analytics.track("too_short_rejected", props: ["stage": "picker", "seconds": (seconds * 10).rounded() / 10])
                    layer2RejectionMessage = "This clip is only \(String(format: "%.1f", seconds))s — too short to edit. Pick one at least \(TalkingHeadPrecheck.minDurationSec) seconds long."
                    showLayer2Rejection = true
                    continue
                }
                if seconds > Double(TalkingHeadPrecheck.maxDurationSec) {
                    let mm = Int(seconds) / 60, ss = Int(seconds) % 60
                    Analytics.track("too_long_rejected", props: ["stage": "picker", "seconds": (seconds * 10).rounded() / 10])
                    layer2RejectionMessage = "This clip is \(String(format: "%d:%02d", mm, ss)) — longer than \(TalkingHeadPrecheck.maxDurationSec / 60) minutes. Trim it to a shorter highlight and upload again."
                    showLayer2Rejection = true
                    continue
                }

                // LAYER 1 — on-device Vision precheck. <1s for local files, skipped
                // for iCloud-only (Layer 2 handles those). Advisory in 223: logs the
                // verdict, never blocks.
                if let localUrl = await PHAssetResolver.localFileURLIfAvailable(asset: video.asset) {
                    // Audio-only preflight now (duration is gated above, for all clips).
                    switch await TalkingHeadPrecheck.preflight(videoURL: localUrl) {
                    case .noAudio:
                        // 223 ZERO-REJECT: no-audio is a WORKER ROUTE now (music /
                        // no-speech), not a rejection. Log the verdict, don't block —
                        // dispatch and let the worker route it. blocked:false marks
                        // the non-blocking emit vs the 222 hard block.
                        Analytics.track("no_audio_rejected", props: ["stage": "precheck", "blocked": false])
                        // fall through — no alert, no skip
                    case .ok:
                        break
                    }

                    // 223 ZERO-REJECT: the on-device Vision face check is ADVISORY
                    // ONLY — still run it for telemetry, but never block. It rejected
                    // valid talking-head clips whose rotation is metadata (221
                    // VideoPicker passthrough), disagreeing with server truth; gating
                    // dispatch on it cost real renders. Emit proceeded:true /
                    // blocked:false so 223 non-blocking emits are distinguishable from
                    // the 222 blocking ones. No "Try Anyway" alert, no skip.
                    let faceCheck = await TalkingHeadPrecheck.quickCheck(videoURL: localUrl)
                    if !faceCheck.pass {
                        // Log the MEASURED values, not just the verdict — a precheck
                        // reject uploads nothing, so this event is the only way to
                        // ever verify the 0.30 bar: face_ratio ≈ 0 = genuinely
                        // faceless; clustering 0.15–0.29 = the bar itself is
                        // rejecting; any_face_ratio ≫ face_ratio = the 10%-width size
                        // floor is the cause (real face, too small in a wide shot).
                        Analytics.track("not_talking_head_rejected", props: [
                            "stage": "precheck", "proceeded": true, "blocked": false,
                            "face_ratio": (faceCheck.faceRatio * 100).rounded() / 100,
                            "any_face_ratio": (faceCheck.anyFaceRatio * 100).rounded() / 100,
                            "max_face_width": (faceCheck.maxFaceWidth * 100).rounded() / 100,
                            "samples": faceCheck.samples,
                        ])
                    }
                }

                addPendingVideoAndStartUpload(video)
            }

            // (Notifications are offered AFTER the first successful DISPATCH, not
            // here at upload — see the .success case in the dispatch handler. The
            // render is actually running then, so "we'll tell you the second it's
            // ready" is maximally concrete and never fires on a clip that fails to
            // dispatch.)
        }
    }

    /// Suspend the picker flow until the user resolves the rejection
    /// alert. Returns true if they tap "Try Anyway", false if they pick
    /// "Choose Another" (or dismiss). The alert state lives in
    /// @State on the View; this bridges it to async/await.
    private func askToProceedAfterPrecheck() async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            rejectedVideoCallback = { proceed in cont.resume(returning: proceed) }
            showPrecheckRejection = true
        }
    }

    /// Layer 2 — extract a 5s sample, upload it to S3 under the
    /// validation-samples/ prefix, POST to the Modal /validate endpoint.
    /// If the backend says the clip isn't a talking head, surface its
    /// user_message in an alert and throw a sentinel so the caller can
    /// bail out cleanly (without marking the tile as a failed upload).
    /// Other failures (network blips, Modal cold-start timeout, etc) are
    /// thrown as their underlying error and treated as non-fatal upstream.
    private func runLayer2Validate(pending: PendingVideo, materializedSourceUrl: URL) async throws {
        guard let userId = AuthService.shared.currentUser?.id else { return }
        let t0 = Date()

        let sampleFile = try await ValidationSampleExtractor.extract(from: materializedSourceUrl)
        defer { try? FileManager.default.removeItem(at: sampleFile) }

        let sampleKey = "validation-samples/\(userId)/\(UUID().uuidString).mp4"
        let sampleResp = try await APIService.shared.getUploadUrl(fileName: sampleKey)
        guard let samplePutUrl = sampleResp.uploadUrl,
              let samplePubUrl = sampleResp.publicUrl else {
            throw APIError.uploadFailed
        }
        try await APIService.shared.uploadFileToS3Foreground(
            url: samplePutUrl,
            fileUrl: sampleFile,
            mimeType: "video/mp4",
            onProgress: nil
        )

        let validation = try await APIService.shared.validateVideo(sampleS3Url: samplePubUrl)
        let elapsed = Date().timeIntervalSince(t0)
        print(String(format: "[layer2] validate verdict=%@ in %.2fs (faceRatio=%.2f reason=%@)",
                     validation.isTalkingHead ? "PASS" : "REJECT",
                     elapsed,
                     validation.faceRatio ?? -1,
                     validation.reason ?? "n/a"))

        if !validation.isTalkingHead {
            // 223 ZERO-REJECT: server sample-validate is ADVISORY ONLY — log the
            // verdict, never block. Modal's cv2 face detector rejects metadata-
            // rotated talking-head clips (221 VideoPicker passthrough), so gating
            // dispatch here rejected valid renders. Dispatch anyway and let the
            // worker route; blocked:false marks the non-blocking emit. No alert,
            // no sentinel throw — fall through so the upload proceeds.
            Analytics.track("not_talking_head_rejected", props: ["stage": "validate", "blocked": false])
        }
    }

    /// Classify an upload-path error into a coarse mechanism for the
    /// `upload_failed` instrument (build 222). Separates user-network causes
    /// (timeout / connection lost / offline / host unreachable) from our-side
    /// ones (a bare uploadFailed, a job-create failure). Iterate the taxonomy in
    /// 223 once two weeks of real mechanism×territory×bytes data exist.
    private static func uploadFailureMechanism(_ error: Error) -> String {
        if let urlErr = error as? URLError {
            switch urlErr.code {
            case .timedOut: return "timeout"
            case .networkConnectionLost: return "network_lost"
            case .notConnectedToInternet: return "offline"
            case .cancelled: return "cancelled"
            case .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed: return "host_unreachable"
            default: return "url_error_\(urlErr.code.rawValue)"
            }
        }
        if let apiErr = error as? APIError {
            if case .uploadFailed = apiErr { return "upload_failed" }
            if case .jobCreationFailed = apiErr { return "job_create_failed" }
            return "api_error"
        }
        return "unknown"
    }

    /// Build 222: offer the notification soft-prompt AFTER the user's first
    /// completed video (value proven), not at dispatch. Self-gated to once via
    /// `shouldOfferSoftPrompt`, so it's safe to call from every completion sink.
    /// Re-timing lifts the ask out of the "before they've seen it work" window
    /// (the old dispatch-time ask saw ~44% decline before any value was shown).
    private func maybeOfferSoftPromptOnCompletion() {
        if PushService.shared.shouldOfferSoftPrompt {
            showPushExplainer = true
        }
    }

    /// Original per-video upload-pipeline starter, factored out of
    /// handlePickedVideos so the precheck can gate it without
    /// duplicating logic.
    private func addPendingVideoAndStartUpload(_ video: PickedVideo) {
        // ACTIVATION-funnel: an upload begins (after any talking-head precheck).
        Analytics.track("upload_started")
        // Warm the GPU render container the instant an upload begins — the
        // earliest possible point — so its ~15-30s cold start (heavy import +
        // CUDA init) overlaps the entire upload + preprocessing and the render
        // starts hot instead of stalling on container boot. Fire-and-forget:
        // detached, never awaited, all errors swallowed inside the call, so it
        // can't block or fail the upload. Idempotent — firing once per picked
        // clip just keeps the container warm. (GPU-side counterpart to the
        // prewarm call fired later once the S3 URL is known.)
        Task.detached(priority: .utility) {
            await APIService.shared.warmupRenderContainer()
        }

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
                let uploadStartedAt = Date() // hoisted so the failure catch can measure elapsed
                do {
                    let t0 = Date()

                    // Step 0: Pick the fastest resolution strategy. Local-
                    // only videos upload straight from the Photos file URL;
                    // iCloud-only videos stream download→upload in parallel
                    // so the two transfers overlap instead of serialising.
                    let resolveStart = Date()
                    let strategy = await PHAssetResolver.resolveStrategy(asset: video.asset)
                    print(String(format: "[perf] strategy-probe %.2fs", Date().timeIntervalSince(resolveStart)))

                    // Instrumentation (224): stamp source duration now; source
                    // type is set per-branch below (local vs icloud). Carried on
                    // the job so the iCloud reliability fix is measurable and
                    // wait-time can be separated from clip length.
                    pending.sourceDuration = video.duration

                    var publicUrl: String?

                    // Fire prewarm the moment we know the eventual S3 URL.
                    // That's before the upload bytes have landed — Modal's
                    // prewarm handler polls for the object to appear and
                    // kicks off source download + Deepgram the instant it
                    // does, shaving most of the post-send latency.
                    let firePrewarmOnce = PrewarmOnce()

                    switch strategy {
                    case .local(let sourceUrl):
                        pending.sourceType = "local"
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
                            // App-owned durable storage (NOT temp) so the source
                            // survives an app-kill mid-upload and the background /
                            // cross-launch retry always has bytes to send. Cleaned
                            // on upload-confirm below + a launch-time orphan sweep.
                            let tmp = UploadStorage.newFile()
                            try FileManager.default.copyItem(at: sourceUrl, to: tmp)
                            materializedSourceUrl = tmp
                            print("[perf] compress skipped (copy-only)")
                        } else {
                            materializedSourceUrl = try await VideoCompressor.compress(sourceUrl: sourceUrl)
                            print("[perf] compressed → tmp")
                        }
                        await MainActor.run { pending.fileUrl = materializedSourceUrl }

                        // LAYER 2 — backend /validate round-trip on a 5s
                        // sample. Catches incompatible clips the Layer 1
                        // on-device Vision precheck didn't flag (iCloud
                        // sources especially, since Layer 1 is skipped
                        // for those). Adds ~4-9s of latency but the
                        // alternative is uploading 30-100MB + waiting
                        // 30-60s into the render before discovering the
                        // clip can't be edited. Non-fatal on its own
                        // errors (network blip, Modal cold-start, etc) —
                        // we'd rather upload a borderline clip than
                        // block on a flaky validation service.
                        do {
                            try await runLayer2Validate(
                                pending: pending,
                                materializedSourceUrl: materializedSourceUrl
                            )
                        } catch is Layer2RejectionSentinel {
                            // User-facing rejection alert was shown
                            // already; bail out cleanly without
                            // marking uploadFailed (we want the tile
                            // to come off, not show an error state).
                            await MainActor.run {
                                withAnimation(.easeOut(duration: 0.18)) {
                                    pendingVideos.removeAll { $0.id == pending.id }
                                }
                            }
                            return
                        } catch {
                            print("[layer2] non-fatal error (continuing): \(error.localizedDescription)")
                        }

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
                        // iCLOUD RELIABILITY FIX (224): the old path STREAMED the
                        // iCloud asset straight to S3 on the FOREGROUND session,
                        // which dies when the app is backgrounded mid-transfer —
                        // the proven UPLOAD_NEVER_STARTED cause for slow iCloud
                        // clips. Now: download the asset to a DURABLE local file,
                        // then hand it to the SAME background uploader the .local
                        // path uses (survives suspension + app-kill). The stream
                        // speedup is traded for actually landing the bytes.
                        pending.sourceType = "icloud"
                        print(String(format: "[perf] path=stream→durable fileSize=%.1fMB", Double(fileSize) / 1_048_576.0))
                        let uploadStart = Date()
                        // 1. iCloud → durable app-owned file (download is the
                        //    first ~half of perceived progress).
                        let durableSource = UploadStorage.newFile()
                        try await PHAssetResourceIO.write(resource: resource, to: durableSource) { p in
                            Task { @MainActor in pending.uploadProgress = p * 0.5 }
                        }
                        // 2. Presign + prewarm, then BACKGROUND-upload the file.
                        let streamResp = try await APIService.shared.getUploadUrl(fileName: pending.fileName)
                        guard let streamPutUrl = streamResp.uploadUrl,
                              let streamPub = streamResp.publicUrl else {
                            try? FileManager.default.removeItem(at: durableSource)
                            throw APIError.uploadFailed
                        }
                        firePrewarmOnce.fire(streamPub)
                        await MainActor.run { pending.uploadedUrl = streamPub }
                        try await APIService.shared.uploadFileToS3(
                            url: streamPutUrl,
                            fileUrl: durableSource,
                            mimeType: "video/mp4",
                            messageId: pending.id.uuidString,
                            chatId: chatStore.activeChatId,
                            publicUrl: streamPub
                        ) { p in
                            Task { @MainActor in pending.uploadProgress = 0.5 + p * 0.5 }
                        }
                        try? FileManager.default.removeItem(at: durableSource)
                        await MainActor.run { pending.sourceUploadCompleted = true }
                        publicUrl = streamPub
                        print(String(format: "[perf] stream→durable+bg done %.2fs", Date().timeIntervalSince(uploadStart)))

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
                        // ACTIVATION-funnel: source bytes confirmed in S3.
                        Analytics.track("upload_completed")
                    }

                    print(String(format: "[perf] TOTAL tap-to-uploaded %.2fs", Date().timeIntervalSince(t0)))
                } catch let APIError.paymentRequired(kind, limit, _) {
                    // Account-GLOBAL concurrency cap hit at the upload door — a
                    // free user started a 2nd video (e.g. in a new chat) while one
                    // is already in flight. Remove the pending tile and present the
                    // upgrade paywall — never a silent upload failure or bare error.
                    print("[upload] payment required (kind=\(kind)) — presenting upgrade paywall")
                    await MainActor.run {
                        pendingVideos.removeAll { $0 === pending }
                        if kind.hasPrefix("concurrency") {
                            appState.presentPaywall(.concurrency)
                        } else {
                            let lim = limit ?? 1
                            appState.presentPaywall(.dailyRenders(used: lim, limit: lim))
                        }
                    }
                    await UsageService.shared.refresh()
                } catch {
                    print("[perf] upload task failed: \(error.localizedDescription)")
                    // INSTRUMENT (build 222): the client was previously SILENT on
                    // upload failure — the entire failure surface was invisible, so
                    // the our-fault-vs-user-network split was unanswerable. Emit
                    // upload_failed with the mechanism + context (pct/elapsed/error),
                    // BEFORE the reset below zeroes uploadProgress. Durable (retried)
                    // because the failure itself is usually a weak-network condition,
                    // which is exactly when a fire-and-forget event would be lost.
                    // territory rides the envelope automatically.
                    let pctAtFailure = await MainActor.run { pending.uploadProgress }
                    Analytics.track("upload_failed", props: [
                        "mechanism": Self.uploadFailureMechanism(error),
                        "pct_complete": pctAtFailure,
                        "elapsed_ms": Int(Date().timeIntervalSince(uploadStartedAt) * 1000),
                        "error_desc": String(error.localizedDescription.prefix(120)),
                    ], durable: true)
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
        // Leftover close brace from the removed `for video in videos { }`
        // loop was deleted here when handlePickedVideos was refactored
        // into a precheck-aware outer + per-video pipeline inner.
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

    // Old vibeSuggestions 12-item array removed in build 172 — the
    // ghost-text rotation + swipe-right that consumed it was replaced
    // with the visible vibeChipRow above the input. Featured vibes
    // now live next to that view (see `featuredVibes` static).

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

    /// Build the Retry handler for a failed render message. Returns nil
    /// unless the message is in the failed state AND backend marked it
    /// retryable AND we have the cached S3 URLs to re-dispatch with.
    /// On tap: flip the bubble back to "processing", clear the error,
    /// and call createVideoJob with the cached values — no upload, no
    /// re-typing. New job_id replaces the old one on the same message.
    /// Phase D ask-back: after the user answers/skips (the ask card already
    /// posted to the re-edit rail), optimistically flip this bubble back to
    /// processing and clear the ask so the bar resumes immediately — then poll
    /// to confirm the resumed job (or catch a self-completed one).
    private func askResolvedClosure(for message: ChatMessage) -> (() -> Void)? {
        guard message.jobStatus == "needs_input", message.jobId != nil else { return nil }
        let messageId = message.id
        let askId = message.ask?.askId
        return {
            guard let i = messages.firstIndex(where: { $0.id == messageId }) else { return }
            // Remember this ask as answered so a stale poll can't re-park it.
            if let askId { answeredAskIds.insert(askId) }
            // Don't clobber a video the poll may have already revealed while the
            // user was answering (self-complete-on-timeout race) — only flip a
            // still-parked bubble.
            guard messages[i].jobStatus == "needs_input" else { return }
            messages[i].jobStatus = "processing"
            messages[i].ask = nil
            messages[i].stepMessage = "Resuming your edit…"
            persistMessages()
            Task { @MainActor in await reconcileInProgressJobs(includeFailed: true) }
        }
    }

    private func retryClosure(for message: ChatMessage) -> (() -> Void)? {
        guard message.role == .assistant,
              message.jobStatus == "failed" || message.jobStatus == "error",
              message.isRetryable,
              let cachedSourceUrl = message.cachedSourceUrl,
              let cachedVibe = message.cachedVibe else { return nil }
        let messageId = message.id
        let cachedProxyUrl = message.cachedProxyUrl
        return {
            Task { @MainActor in
                retryFailedRender(
                    messageId: messageId,
                    sourceUrl: cachedSourceUrl,
                    proxyUrl: cachedProxyUrl,
                    vibe: cachedVibe
                )
            }
        }
    }

    /// Provides the cancel action for a processing render bubble. Non-nil only
    /// while the job is still in flight (queued/processing) and has a stage
    /// timeline — the FINER "before the recipe" gate lives in the view
    /// (`timeline.isCancellable`), which shows/hides the button as stages fire.
    /// Maps any caught error to a SHORT, user-safe message for the chat bubble.
    /// Raw technical errors (ReferenceErrors, "X is not defined", DB/stack noise)
    /// must NEVER surface — they collapse to a generic line and get logged. Only
    /// server-curated copy (structured failures, paywall, validation) passes
    /// through, since the backend wrote those for users.
    private func friendlyError(_ error: Error) -> String {
        switch error {
        case APIError.structuredFailure(_, let m, _, _, _): return m
        case APIError.validationRejected(let m, _, _): return m
        case APIError.paymentRequired(_, _, let m): return m
        case APIError.notAuthenticated: return "Please sign in to continue."
        case is URLError: return "Connection problem — check your network and try again."
        default:
            print("[error] suppressed technical error from UI: \(error)")
            return "Something went wrong on our end. Please try again."
        }
    }

    /// Last line of defense for a raw error string arriving over SSE. The backend
    /// should already send friendly copy; anything that reads like engineering
    /// output (a code, JSON, "is not defined", a stack, an over-long blob) is
    /// swapped for a generic line so a user never sees internals.
    private func friendlySSEError(_ raw: String?) -> String {
        let generic = "Something went wrong on our end. Please try again."
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return generic }
        let looksTechnical =
            s.contains("is not defined") || s.contains("undefined") ||
            s.localizedCaseInsensitiveContains("error:") || s.contains("{") || s.hasPrefix("[") ||
            s.count > 160 ||
            s.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) != nil   // snake_case code
        if looksTechnical {
            print("[error] suppressed technical SSE error: \(s)")
            return generic
        }
        return s
    }

    private func cancelClosure(for message: ChatMessage) -> (() -> Void)? {
        guard message.role == .assistant,
              let jobId = message.jobId,
              let status = message.jobStatus,
              status == "processing" || status == "queued",
              // Review fix: jobId now exists DURING upload, before any server
              // row. Cancelling then is a 404 no-op that leaves the dispatch
              // running (user "cancelled" but still gets charged). The button
              // only appears once the row is known to exist server-side —
              // same timing the user saw before the idempotency change.
              message.serverRowExists,
              message.stageTimeline != nil else { return nil }
        let messageId = message.id
        return {
            Task { @MainActor in
                cancelRender(messageId: messageId, jobId: jobId)
            }
        }
    }

    /// Cancel an in-progress render before the edit recipe. Optimistic + best-
    /// effort: tear down the SSE, remove the processing bubble, and persist right
    /// away so the UI responds instantly; then tell the server to cancel + refund
    /// the daily slot (the worker polls /api/render-cancelled and aborts before
    /// the GPU render) and refresh usage so the freed slot shows immediately.
    @MainActor
    private func cancelRender(messageId: UUID, jobId: String) {
        sseClients[jobId]?.disconnect()
        sseClients.removeValue(forKey: jobId)
        withAnimation(.easeOut(duration: 0.2)) {
            messages.removeAll { $0.id == messageId }
        }
        persistMessages()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        Task {
            try? await APIService.shared.cancelRender(jobId: jobId)
            await UsageService.shared.refresh()
        }
        print("[cancel] user cancelled render job=\(jobId)")
    }

    /// Re-dispatch a previously-failed render with the cached S3 URLs
    /// + vibe. Skips upload entirely — the source and proxy are still
    /// in the bucket from the original attempt. Resets the bubble to
    /// the processing state and starts a fresh SSE stream against the
    /// new jobId. Failures here re-route through the same structured-
    /// error path as the original dispatch, so a retry that also fails
    /// just leaves the user back on a retryable failed state.
    private func retryFailedRender(
        messageId: UUID,
        sourceUrl: String,
        proxyUrl: String?,
        vibe: String
    ) {
        guard let idx = messages.firstIndex(where: { $0.id == messageId }) else { return }

        // Reset the bubble's failure state in-place. Keeping the same
        // ChatMessage.id (and stableness of LazyVStack identity) means
        // SwiftUI animates the transition cleanly instead of replacing
        // the whole bubble.
        withAnimation(.easeOut(duration: 0.2)) {
            messages[idx].jobStatus = "processing"
            messages[idx].error = nil
            messages[idx].jobProgress = 40
            messages[idx].stepMessage = "Re-sending your edit..."
            // Re-arm the stage timeline so the progress UI shows again
            // (was hidden under the error rendering).
            if messages[idx].stageTimeline == nil {
                messages[idx].stageTimeline = StageTimeline(mode: "full", startWith: "analyze")
            }
        }
        persistMessages()

        Task { @MainActor in
            do {
                let jobId = try await APIService.shared.createVideoJob(
                    videoUrl: sourceUrl,
                    proxyVideoUrl: proxyUrl,
                    vibe: vibe,
                    premiumPipeline: ModelService.shared.premiumPipelineFlag(
                        isPro: SubscriptionService.shared.effectiveIsPro)
                )
                guard let i = messages.firstIndex(where: { $0.id == messageId }) else { return }
                messages[i].jobId = jobId
                startSSE(jobId: jobId, messageId: messageId)
                scheduleStuckDetector(messageId: messageId, jobId: jobId)
                persistMessages()
                print("[retry] re-dispatched job=\(jobId)")
            } catch let APIError.structuredFailure(_, userMessage, retryable, _, _) {
                // Re-failure — same cached values stay attached so the
                // user can keep tapping Retry. retryable from the new
                // response wins (backend might've flipped it off if
                // the error is now permanent).
                guard let i = messages.firstIndex(where: { $0.id == messageId }) else { return }
                messages[i].jobStatus = "failed"
                messages[i].error = userMessage
                messages[i].isRetryable = retryable
                persistMessages()
            } catch let APIError.paymentRequired(_, _, _) {
                appState.presentPaywall(.manual)
            } catch APIError.wallRequired {
                appState.presentWall()
            } catch {
                guard let i = messages.firstIndex(where: { $0.id == messageId }) else { return }
                messages[i].jobStatus = "failed"
                messages[i].error = friendlyError(error)
                persistMessages()
            }
        }
    }

    /// §4 sample-clip demo. Dispatches a pre-hosted clip through the REAL render
    /// pipeline with NO upload (the source already lives in S3, so this is the
    /// retry fast path: straight to createVideoJob), so a first-run user watches a
    /// finished Promptly edit before risking their own footage. Sends `demo: true`
    /// so the server exempts it from the daily free-render quota — the demo must
    /// never cost the user their one render. Gated behind `usageService
    /// .sampleDemoAvailable`, which is only true once the server hosts a clip AND
    /// honors the exemption; until then the hero never offers this.
    @MainActor
    private func startSampleDemo() {
        guard usageService.sampleDemoAvailable else { return }

        // CACHED (default): present the honest before→after reveal — a pre-rendered
        // edit, no dispatch, no fabricated progress. The "before" (raw source) is
        // optional; when absent the reveal is After-only.
        if usageService.sampleDemoMode == "cached",
           let edited = usageService.sampleDemoResultUrl.flatMap({ URL(string: $0) }) {
            demoReveal = DemoRevealData(
                raw: usageService.sampleDemoSourceUrl.flatMap({ URL(string: $0) }),
                edited: edited)
            return
        }

        // LIVE: dispatch the source through the real pipeline (quota-exempt).
        guard let sourceUrl = usageService.sampleDemoSourceUrl else { return }
        // Idempotency: never run two demos at once. If a demo bubble is already
        // in flight, a second tap is a no-op.
        if messages.contains(where: { $0.isSampleDemo && ($0.jobStatus == "processing" || $0.jobStatus == "queued") }) { return }

        let proxyUrl = usageService.sampleDemoProxyUrl
        let vibe = usageService.sampleDemoVibe

        // A natural user turn ("edit this sample") + the processing bubble, so the
        // demo reads exactly like a real render the user asked for.
        let userMsg = ChatMessage(role: .user, content: "Edit this sample clip")
        messages.append(userMsg)

        var processingMsg = ChatMessage(role: .assistant, content: "", jobStatus: "processing", stepMessage: "Preparing your footage…")
        // No upload stage — the clip is already hosted, so the timeline starts at
        // analyze (mirrors retryFailedRender / re-edit, which also skip upload).
        processingMsg.stageTimeline = StageTimeline(mode: "full", startWith: "analyze")
        processingMsg.originalVibe = vibe
        processingMsg.isSampleDemo = true
        processingMsg.jobProgress = 40
        let msgId = processingMsg.id
        let mintedJobId = UUID().uuidString.lowercased()
        processingMsg.jobId = mintedJobId
        messages.append(processingMsg)

        Task { @MainActor in
            _ = await ensureActiveChat()
            persistMessages()
            do {
                let jobId = try await APIService.shared.createVideoJob(
                    videoUrl: sourceUrl,
                    proxyVideoUrl: proxyUrl,
                    vibe: vibe,
                    premiumPipeline: false,   // demo always runs the free fast path
                    clientJobId: mintedJobId,
                    demo: true                // server exempts from the daily quota
                )
                guard let i = messages.firstIndex(where: { $0.id == msgId }) else { return }
                messages[i].jobId = jobId
                messages[i].serverRowExists = true
                startSSE(jobId: jobId, messageId: msgId)
                scheduleStuckDetector(messageId: msgId, jobId: jobId)
                persistMessages()
                print("[demo] dispatched sample render job=\(jobId)")
            } catch {
                // A failed demo never blocks the user — show a soft line; their own
                // upload is the real path. (No Retry wiring: the demo is a nicety.)
                guard let i = messages.firstIndex(where: { $0.id == msgId }) else { return }
                messages[i].jobStatus = "failed"
                messages[i].error = "Couldn't load the sample just now — upload your own clip to see Promptly work."
                messages[i].isRetryable = false
                persistMessages()
                print("[demo] sample dispatch failed: \(error)")
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
                appState.presentPaywall(reason)
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
        // PREEMPTIVE PAYWALL — same pattern as the render gate. If the
        // server's last /api/usage snapshot says this free user is at
        // their daily chat cap, present the paywall before kicking off
        // the Gemini round trip. Server still authoritatively gates with
        // 402 (handled in streamReplyWithFallback) — this is UX defense
        // so the user doesn't watch a thinking indicator spin only to
        // get bounced.
        if UsageService.shared.atChatLimit {
            let lim = UsageService.shared.chatLimit ?? 5
            appState.presentPaywall(.dailyChats(used: lim, limit: lim))
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            return
        }

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

    /// Re-fire the GPU render-container warmup on SEND INTENT. Backend root-caused
    /// dispatch stalls to a cold-start race: the pick-time / editor-open warmup
    /// (~15-30s cold start) expires before a real user finishes entering a vibe and
    /// hits send, so the container is cold again at dispatch and the render stalls on
    /// boot. Re-firing at vibe entry and again just before dispatch keeps it hot.
    /// Fire-and-forget, detached, idempotent — Modal dedupes container warmup, and all
    /// errors are swallowed inside the call, so it can never block or fail a send.
    private func fireRenderWarmup() {
        Task.detached(priority: .utility) {
            await APIService.shared.warmupRenderContainer()
        }
    }

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasVideos = !pendingVideos.isEmpty
        let reeditActive = reeditSession != nil
        guard !text.isEmpty || hasVideos else { return }

        // Send intent → re-fire the GPU warmup for any path that hits the render
        // container (a fresh video send, a re-edit, or a vibe-change re-dispatch),
        // closing the cold-start race the backend traced.
        if hasVideos || reeditActive || pendingVibeEditMessageId != nil {
            fireRenderWarmup()
        }

        // ── requires_vibe_change re-dispatch path ─────────────────────
        // Backend told us the source was fine but the vibe was the
        // problem. The composer's been showing a "Editing vibe for
        // your previous video" pill since the failure landed; tapping
        // Send here re-runs the SAME source/proxy in S3 with the new
        // vibe text. No upload, no re-typing — exact spec match.
        if let editId = pendingVibeEditMessageId,
           !text.isEmpty,
           let failed = messages.first(where: { $0.id == editId }),
           let sourceUrl = failed.cachedSourceUrl {
            let proxyUrl = failed.cachedProxyUrl
            let newVibe = text
            clearInputField()
            pendingVibeEditMessageId = nil
            retryFailedRender(
                messageId: editId,
                sourceUrl: sourceUrl,
                proxyUrl: proxyUrl,
                vibe: newVibe
            )
            return
        }

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

        // (Push permission is now offered earlier, at the FIRST UPLOAD, behind a
        // pre-permission explainer — see handlePickedVideos. We no longer ask a
        // cold system dialog here at send.)

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
                        startSSE(jobId: newJobId, messageId: msgId)
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
                        appState.presentPaywall(.reedit)
                    } else {
                        let lim = limit ?? 3
                        appState.presentPaywall(.dailyRenders(used: lim, limit: lim))
                    }
                    await UsageService.shared.refresh()
                } catch {
                    if let i = idx() {
                        messages[i].jobStatus = "failed"
                        messages[i].error = friendlyError(error)
                        persistMessages()
                    }
                }
                isSending = false
            }
            return
        }

        // PREEMPTIVE PAYWALL (fast path) — uses the cached /api/usage
        // snapshot for an INSTANT paywall when the user is already
        // known to be at the cap (e.g. just opened the app with 3/3
        // renders from earlier today). Catches the obvious case with
        // zero latency.
        if hasVideos && UsageService.shared.atRenderLimit {
            let lim = UsageService.shared.renderLimit ?? 1
            appState.presentPaywall(.dailyRenders(used: lim, limit: lim))
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            return
        }

        // PREEMPTIVE PAYWALL (refresh path) — for everything else, we
        // re-fetch /api/usage BEFORE setting isSending=true / appending
        // any stub bubbles. Adds ~100-200ms but guarantees the freshest
        // possible count, so the user never sees an upload start only
        // to be 402'd by the server after the bytes already landed.
        //
        // The fast path above + this refresh path together mean the
        // cached snapshot ONLY decides "no paywall, proceed instantly"
        // — anything stale that needed a paywall is caught here. The
        // dispatch + processing-bubble setup happens INSIDE the refresh
        // Task so there's nothing to roll back if the refresh says
        // "actually you're at limit."
        let textSnapshot = text
        Task { @MainActor in
            if hasVideos {
                await UsageService.shared.refresh()
                if UsageService.shared.atRenderLimit {
                    let lim = UsageService.shared.renderLimit ?? 1
                    appState.presentPaywall(.dailyRenders(used: lim, limit: lim))
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    return
                }
            }

            isSending = true
            let videos = pendingVideos
            let vibe = textSnapshot.isEmpty ? "Create a clean, engaging edit" : textSnapshot
            // Which pipeline this render runs — captured at send time from the
            // selected model + current entitlement. The ONLY client path that
            // can set premium true, and only for (Pro AND Lumen); a free client
            // always sends false. The server re-derives this authoritatively.
            let premiumPipeline = ModelService.shared.premiumPipelineFlag(
                isPro: SubscriptionService.shared.effectiveIsPro)

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
                    // ONE IDENTITY (stuck-jobs directive): mint the job UUID
                    // now, BEFORE upload starts. It is (a) the idempotency key
                    // on POST /api/video-jobs, (b) persisted on this message,
                    // (c) the reconciliation handle after any relaunch. A
                    // restored in-flight bubble that cannot resolve is no
                    // longer representable.
                    processingMsg.jobId = UUID().uuidString.lowercased()
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
            // The chat these renders belong to. Captured so a dispatch that
            // completes AFTER the user switched chats can still route its
            // jobId/result onto the right (now off-screen) bubble's stored copy.
            let dispatchChatId = chatStore.activeChatId

            // hasVideos is guaranteed true here: the text-only fast path
            // returned at the top of send(), and the re-edit branch
            // returned in its own block. So the inner Task chain below
            // is only ever reached on the video flow.
            if hasVideos {
                for (clipIndex, (video, msgId)) in pendingMsgIds.enumerated() {
                    // Capture the minted UUID NOW (review fix): looking it up
                    // from `messages` at dispatch time silently returns nil
                    // after a chat switch, disabling idempotency exactly when
                    // it matters most.
                    let mintedJobId = messages.first(where: { $0.id == msgId })?.jobId
                    Task { @MainActor in
                        // Stagger fan-out: clip 0 dispatches immediately,
                        // clip 1 at +200ms, clip 2 at +400ms, etc. The
                        // Modal worker warms instantly but our own
                        // /api/upload-url and /api/video-jobs endpoints
                        // have a 10-jobs-per-15-minutes rate limit per
                        // user — without staggering, a 4-video upload
                        // can flood those caps in a single burst. 200ms
                        // keeps total fan-out latency under 2s for the
                        // 10-clip Pro cap while smoothing the rate.
                        if clipIndex > 0 {
                            try? await Task.sleep(for: .milliseconds(200 * clipIndex))
                        }
                        // Keep the upload→createVideoJob→startSSE handshake
                        // alive if the user backgrounds the app right after
                        // sending. The upload itself runs on a background
                        // URLSession (fine), but the main-actor upload-wait
                        // poll loop suspends on background — without this
                        // assertion the job is never CREATED until the user
                        // returns ("stuck on upload forever"). iOS grants
                        // ~30s, enough to finish a quick upload + create the
                        // job so the render proceeds server-side regardless.
                        var bgTaskId: UIBackgroundTaskIdentifier = .invalid
                        bgTaskId = UIApplication.shared.beginBackgroundTask(withName: "render-dispatch") {
                            if bgTaskId != .invalid {
                                UIApplication.shared.endBackgroundTask(bgTaskId)
                                bgTaskId = .invalid
                            }
                        }
                        defer {
                            if bgTaskId != .invalid {
                                UIApplication.shared.endBackgroundTask(bgTaskId)
                                bgTaskId = .invalid
                            }
                        }
                        // Helper: find the live index of the processing
                        // message by id. Returns nil if it's been removed
                        // (chat switch, delete, etc.) so we silently no-op
                        // instead of crashing on out-of-bounds.
                        func indexOfProcessingMsg() -> Int? {
                            messages.firstIndex(where: { $0.id == msgId })
                        }
                        // Hand off to the dispatch coordinator. It owns
                        // the upload-wait + createVideoJob loop and
                        // retries every soft failure (network blip,
                        // worker hiccup, S3 stall, rate limit, etc.)
                        // silently with exponential backoff. The only
                        // outcomes that escape to the UI are:
                        //   - success → start SSE + stuck detector
                        //   - hardFailure → user must act (paywall, bad
                        //     video, vibe rewrite)
                        //   - cancelled → user explicitly cancelled
                        let outcome = await JobDispatchCoordinator.shared.dispatch(
                            pendingVideo: video,
                            vibe: vibe,
                            premiumPipeline: premiumPipeline,
                            clientJobId: mintedJobId
                        ) { phase in
                            // Phase callback drives the bar's Phase 1
                            // (iOS → S3 upload) portion. Per the new
                            // contract: real upload progress 0…1 → bar
                            // 0–30%. NO fake timer, NO plant-to-40 jump
                            // on dispatch. The bar continues smoothly
                            // from wherever upload left it (e.g. 12) and
                            // the first /api/modal-progress event
                            // (download=5 → bar=33.5) drives the
                            // transition into Phase 2 without any visible
                            // discontinuity.
                            guard let i = indexOfProcessingMsg() else { return }
                            switch phase {
                            case .waitingForUpload(let progress):
                                let mapped = Int(progress * 30)
                                if mapped > (messages[i].jobProgress ?? 0) {
                                    messages[i].jobProgress = mapped
                                }
                            case .dispatching:
                                // STATUS FIDELITY: do NOT light "analyze"
                                // ("Preparing your footage") here — the job
                                // isn't on the server yet, and firing a RENDER
                                // stage during dispatch is the "frozen at
                                // Preparing your footage" lie. Keep the headline
                                // on "Uploading your video" and say honestly what
                                // we're doing in the subtitle. Only a real server
                                // SSE/reconcile `analyze` token advances the stage
                                // to "Preparing your footage".
                                messages[i].stepMessage = "Sending to the editor…"
                            case .waitingForNetwork:
                                messages[i].stepMessage = "Waiting for a connection…"
                            case .retrying:
                                messages[i].stepMessage = "Reconnecting…"
                            }
                        }

                        switch outcome {
                        case .success(let jobId):
                            if let i = indexOfProcessingMsg() {
                                messages[i].jobId = jobId
                                messages[i].serverRowExists = true
                                // §6 retry-gap fix: stash the retry cache on SUCCESS
                                // too. Previously only the dispatch-FAILURE path cached
                                // source+proxy+vibe, so a render that dispatched fine but
                                // then failed mid-way via SSE had no cache → one-tap
                                // Try Again stayed hidden. Caching here closes that gap.
                                messages[i].cachedSourceUrl = video.uploadedUrl
                                messages[i].cachedProxyUrl = video.proxyUploadedUrl
                                messages[i].cachedVibe = vibe
                                startSSE(jobId: jobId, messageId: msgId)
                                persistMessages()
                                // (Build 222: the notification soft-prompt moved from
                                // HERE — dispatch — to first COMPLETION, so we only ask
                                // once the user has SEEN the payoff. The old timing asked
                                // before the value was proven; ~44% declined. See
                                // maybeOfferSoftPromptOnCompletion() at the completion sinks.)
                            } else if let cid = dispatchChatId {
                                // User switched chats while this was uploading.
                                // Land the jobId on the off-screen bubble's
                                // persisted copy so resumeSSE + reconcile
                                // re-link it the moment they return — instead
                                // of the bubble being orphaned with no jobId.
                                chatStore.updateStoredMessage(chatId: cid, messageId: msgId.uuidString) { m in
                                    m.jobId = jobId
                                    if m.jobStatus == nil { m.jobStatus = "processing" }
                                }
                            }
                            scheduleStuckDetector(messageId: msgId, jobId: jobId)
                            // Async-refresh the usage snapshot so the
                            // NEXT send already sees the bumped count
                            // without needing to wait for the synchronous
                            // refresh at the top of send(). Belt-and-
                            // suspenders: even if the refresh-then-check
                            // at send() entry fails for some reason, the
                            // fast-path check sees the right number.
                            Task { @MainActor in
                                await UsageService.shared.refresh()
                            }

                        case .hardFailure(let hf):
                            if hf.isPaymentRequired {
                                // Same flow as the old APIError.paymentRequired
                                // branch: pull the stub processing bubble
                                // and pop the paywall — but only when the
                                // bubble is on screen. If the user switched
                                // away, popping a paywall on an unrelated chat
                                // is jarring; instead persist the limit message
                                // onto the off-screen bubble so they see why on
                                // return.
                                if let i = indexOfProcessingMsg() {
                                    messages.remove(at: i)
                                    persistMessages()
                                    if hf.paymentKind == "reedit" {
                                        appState.presentPaywall(.reedit)
                                    } else {
                                        let lim = hf.paymentLimit ?? 3
                                        appState.presentPaywall(.dailyRenders(used: lim, limit: lim))
                                    }
                                } else if let cid = dispatchChatId {
                                    chatStore.updateStoredMessage(chatId: cid, messageId: msgId.uuidString) { m in
                                        m.jobStatus = "failed"
                                        m.error = hf.userMessage
                                        m.isRetryable = false
                                    }
                                }
                                await UsageService.shared.refresh()
                            } else {
                                var failedMessageId: UUID? = nil
                                if let i = indexOfProcessingMsg() {
                                    messages[i].jobStatus = "failed"
                                    messages[i].error = hf.userMessage
                                    failedMessageId = messages[i].id
                                    // Always cache URLs so the Try Again
                                    // button (and vibe-edit retry path) work
                                    // without re-uploading. requiresNewVideo
                                    // hides the Try Again button via the
                                    // !requiresNewVideo gate on isRetryable.
                                    messages[i].isRetryable = !hf.requiresNewVideo
                                    messages[i].cachedSourceUrl = video.uploadedUrl
                                    messages[i].cachedProxyUrl = video.proxyUploadedUrl
                                    messages[i].cachedVibe = vibe
                                    persistMessages()
                                } else if let cid = dispatchChatId {
                                    // Off-screen failure — persist it so the
                                    // error (and Try Again) is waiting on return
                                    // instead of a forever-spinning bubble.
                                    chatStore.updateStoredMessage(chatId: cid, messageId: msgId.uuidString) { m in
                                        m.jobStatus = "failed"
                                        m.error = hf.userMessage
                                        m.isRetryable = !hf.requiresNewVideo
                                        m.cachedSourceUrl = video.uploadedUrl
                                        m.cachedProxyUrl = video.proxyUploadedUrl
                                        m.cachedVibe = vibe
                                    }
                                }
                                // UI redirects (picker / vibe focus) only when
                                // the failing bubble is on screen — firing them
                                // while the user is in another chat is jarring.
                                if hf.requiresNewVideo, failedMessageId != nil {
                                    await MainActor.run {
                                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                        showVideoPicker = true
                                    }
                                }
                                if hf.requiresVibeChange, let mid = failedMessageId {
                                    await MainActor.run {
                                        pendingVibeEditMessageId = mid
                                        inputText = vibe
                                        isInputFocused = true
                                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                                    }
                                }
                            }

                        case .cancelled:
                            if let i = indexOfProcessingMsg() {
                                messages.remove(at: i)
                                persistMessages()
                            }
                        }
                    }
                }
            }
            isSending = false
            }
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

    // Takes the message's UUID rather than its current array index. Why:
    // capturing `Int messageIndex` here used to look up `messages[idx]`
    // forever after — but any later insertion or deletion (a new send
    // while this render is still going, a paywall path removing the stub
    // processing bubble, a chat restoration) shifts indices. The
    // captured index then writes SSE updates into the WRONG message
    // bubble — exactly the bug from the screenshot, where the new
    // "Your video is ready!" message rendered correctly but the OLD
    // processing bubble was left frozen at 57% because its SSE writes
    // were being absorbed by a different message. Resolving by id each
    // event is O(messages) but the array is tiny and SSE is sparse.
    private func startSSE(jobId: String, messageId: UUID) {
        // Idempotent: tear down any existing client for this job before replacing
        // it. Overwriting the dict entry without disconnecting orphaned the old
        // SSEClient — it stayed connected + reconnecting, untracked, and multiple
        // of them per job compounded into the /stream 429-storm.
        sseClients[jobId]?.disconnect()
        let client = SSEClient(jobId: jobId)
        sseClients[jobId] = client

        client.onEvent = { event in
            guard let messageIndex = messages.firstIndex(where: { $0.id == messageId }) else { return }
            // Pass through every status EXCEPT "completed". The completed
            // flip is gated on the local video cache being warm — see the
            // dedicated branch below — so the play UI never appears until
            // the file is on disk and tapping is guaranteed instant.
            if let status = event.status, status != "completed", status != "complete",
               status != "needs_input" {
                // needs_input is owned by the poll (reconcileJobStatus), which sets
                // `ask` + jobStatus atomically. SSE carries no ask payload, so
                // applying needs_input here would show a held bar with no card
                // until the next poll — let the poll transition it instead.
                messages[messageIndex].jobStatus = status
            }
            if let progress = event.progress {
                // Phase 2 mapping per the backend contract:
                //   bar = 30 + (server_pct / 100) × 70
                // Maps the worker's canonical pct values to a single
                // continuous 30-100 band:
                //   download   pct=5   → bar 33.5  (33)
                //   transcribe pct=10  → bar 37
                //   plan       pct=38  → bar 56.6  (56) (heartbeats to 50→65)
                //   broll      pct=52  → bar 66.4  (66)
                //   render     pct=65  → bar 75.5  (75) (heartbeats to 90→93)
                //   thumbnail  pct=92  → bar 94.4  (94)
                //   upload     pct=96  → bar 97.2  (97) (heartbeats to 99→99.3)
                //   complete   pct=100 → bar 100
                // Monotonic — never reduces the bar. Out-of-order
                // heartbeats can land with a lower pct than what we've
                // already shown; we just ignore the pct and let the
                // message field (handled below) update visibly.
                let mapped = 30 + Int(Double(progress) * 0.7)
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
            if let err = event.error { messages[messageIndex].error = friendlySSEError(err) }

            // Structured-error forward-compat. If the worker ever
            // sends structured failure fields via SSE (currently it
            // only does this on the render-dispatch endpoint), surface
            // them the same way: user_message wins for display,
            // retryable wires the Try Again button, requires_vibe_change
            // pre-fills the input for an in-place vibe edit, and
            // requires_new_video re-opens the picker. iOS forward-
            // compat — zero-day pickup the moment the worker upgrades.
            if let userMessage = event.userMessage, !userMessage.isEmpty {
                messages[messageIndex].error = userMessage
            }
            if event.retryable == true {
                messages[messageIndex].isRetryable = true
                // We don't have the cached source URL in this SSE
                // handler scope (the original upload Task that knew
                // it is gone by this point). The Retry button checks
                // for cachedSourceUrl != nil, so it stays hidden for
                // SSE-delivered retryables until we can plumb a way
                // to find the source URL again (via the chat store
                // or the video_jobs DB row).
            }
            if event.requiresVibeChange == true {
                let msgId = messages[messageIndex].id
                Task { @MainActor in
                    pendingVibeEditMessageId = msgId
                    if let cached = messages.first(where: { $0.id == msgId })?.cachedVibe {
                        inputText = cached
                    } else if let original = messages.first(where: { $0.id == msgId })?.originalVibe {
                        inputText = original
                    }
                    isInputFocused = true
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
            }
            if event.requiresNewVideo == true {
                Task { @MainActor in
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    showVideoPicker = true
                }
            }

            // Defense-in-depth concurrency paywall. Backend's
            // /api/video-jobs concurrency gate normally catches this
            // synchronously (1 free / 10 Pro pending), but if a job
            // slips past (race condition, alternate client) the Modal
            // worker rejects with error_code="tier_concurrency_limit".
            // The SSE error event carries the worker's user_message;
            // we surface the paywall the same way the synchronous 402
            // path does so the user sees a consistent upgrade prompt.
            if let code = event.errorCode,
               code == "tier_concurrency_limit" {
                Task { @MainActor in
                    let lim = UsageService.shared.renderLimit ?? 1
                    appState.presentPaywall(.dailyRenders(used: lim, limit: lim))
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
            }

            // Feed the authoritative step token into the stage timeline. Unknown
            // or missing tokens are silently ignored — the timeline stays on the
            // previous stage and the old dumb ProcessingIndicator fallback kicks
            // in only when no timeline exists at all.
            if let step = event.step, !step.isEmpty {
                messages[messageIndex].stageTimeline?.receive(stepToken: step)
            }

            // §5 progressive playback: capture the HLS manifest the MOMENT the backend
            // emits it (mid-render, on ANY event) — not only at completion — so the
            // inline preview can start on the first segments and later swap to the
            // final MP4. Gated by the server flag (both halves flip on the same word);
            // inert until then. Prewarm validates the master playlist. Only sets it
            // once and only before completion (the completed branch below still owns
            // the terminal capture).
            if UsageService.shared.progressivePlaybackEnabled,
               !isCompletedEvent,
               messages[messageIndex].hlsManifestUrl == nil,
               let hls = event.hlsManifestUrl, !hls.isEmpty {
                messages[messageIndex].hlsManifestUrl = hls
                PlayerAssetPrewarm.shared.warm(hls)
                print("[sse] progressive manifest ready mid-render: \(hls)")
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
                // §6: SSE doesn't carry the post package — fetch it once now that
                // the render landed (idempotent; no-op if we already have it).
                if let jid = messages[messageIndex].jobId {
                    Task { await hydratePostPackage(jobId: jid) }
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
                    // Finish beat: let the progress bar visibly sweep to 100
                    // before swapping in the video, instead of vanishing
                    // mid-fill. The asset is already pre-warmed above, so the
                    // ~0.7s hold costs nothing perceptible and reads as "done!".
                    messages[messageIndex].jobProgress = 100
                    messages[messageIndex].isFinishing = true
                    persistMessages()
                    // Background prefetch so offline replay works after
                    // first watch — same as iMessage / WhatsApp's pattern.
                    // Kick it off now (not after the hold) so bytes land ASAP.
                    if let videoUrl {
                        Task.detached(priority: .background) {
                            await VideoCache.shared.downloadIfNeeded(
                                jobId: jobId,
                                from: videoUrl,
                                priority: .prefetch
                            )
                        }
                    }
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(0.7))
                        guard let idx = messages.firstIndex(where: { $0.id == messageId }) else { return }
                        // Never finalize a videoless "ready". If somehow no URL
                        // landed, stay in-flight so reconcile/SSE fills it in.
                        guard messages[idx].renderedVideoUrl != nil || messages[idx].hlsManifestUrl != nil else { return }
                        messages[idx].jobStatus = "completed"
                        messages[idx].content = "Your video is ready!"
                        messages[idx].stageTimeline?.finish()
                        persistMessages()
                        maybeOfferSoftPromptOnCompletion() // build 222: ask AFTER the payoff
                        if isFinalEvent {
                            client.disconnect()
                            sseClients.removeValue(forKey: jobId)
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
                        // Finish beat: sweep the bar to 100, hold ~0.7s, then
                        // reveal — same polished completion as the streaming path.
                        messages[idx].jobProgress = 100
                        messages[idx].isFinishing = true
                        persistMessages()
                        try? await Task.sleep(for: .seconds(0.7))
                        guard let revealIdx = messages.firstIndex(where: { $0.id == messageId }) else { return }
                        // Never finalize a videoless "ready". If the completion
                        // event carried no playable URL, stay in-flight so the
                        // reconciler fills it in rather than stranding the user
                        // on "Your video is ready!" with nothing to play.
                        guard messages[revealIdx].renderedVideoUrl != nil || messages[revealIdx].hlsManifestUrl != nil else { return }
                        messages[revealIdx].jobStatus = "completed"
                        messages[revealIdx].content = "Your video is ready!"
                        messages[revealIdx].stageTimeline?.finish()
                        persistMessages()
                        maybeOfferSoftPromptOnCompletion() // build 222: ask AFTER the payoff
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
    /// §6 one-shot fetch of the post package for a completed job. SSE doesn't
    /// carry it, and a completed message is never re-reconciled, so we fetch it
    /// once on completion from whichever path got there first (`result.post_package`
    /// preferred, flat `post_package` column as fallback). Idempotent +
    /// best-effort: any failure just leaves the description block hidden.
    private func hydratePostPackage(jobId: String) async {
        guard let idx0 = messages.firstIndex(where: { $0.jobId == jobId }),
              messages[idx0].postPackage == nil else { return }
        guard let token = await AuthService.shared.getValidToken() else { return }
        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"
        guard let url = URL(string: "\(supabaseUrl)/rest/v1/video_jobs?id=eq.\(jobId)&select=result,post_package") else { return }
        var request = URLRequest(url: url)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10
        struct PkgResult: Codable { let post_package: PostPackage? }
        struct Row: Codable { let result: PkgResult?; let post_package: PostPackage? }
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode),
              let row = (try? JSONDecoder().decode([Row].self, from: data))?.first else { return }
        // Read order per the contract: result.post_package (durable/authoritative)
        // then the flat video_jobs.post_package column.
        guard let pkg = row.result?.post_package ?? row.post_package, pkg.hasContent else { return }
        guard let idx = messages.firstIndex(where: { $0.jobId == jobId }) else { return }
        messages[idx].postPackage = pkg
        persistMessages()
    }

    private func reconcileJobStatus(jobId: String) async {
        guard let token = await AuthService.shared.getValidToken() else {
            print("[reconcile] \(jobId) skipped — no valid token")
            return
        }

        let supabaseUrl = "https://ejxkzsfruykvgeouymfy.supabase.co"
        let anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVqeGt6c2ZydXlrdmdlb3V5bWZ5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjMzMjE5ODgsImV4cCI6MjA3ODg5Nzk4OH0.KSH6xO3bPv9aK36zGZKCtnNCa1z7xI_H-VKx5ZRaTOE"

        guard let url = URL(string: "\(supabaseUrl)/rest/v1/video_jobs?id=eq.\(jobId)&select=status,progress,current_step,step_message,ask,rendered_video_url,hls_manifest_url,thumbnail_url,error_message,result") else { return }

        var request = URLRequest(url: url)
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 10

        struct JobResult: Codable {
            let error_code: String?
            let post_package: PostPackage?   // §6 post package (result.post_package) — tolerant decode
        }
        struct JobStatusRow: Codable {
            let status: String?
            let progress: Double?       // durable 0–100; the authoritative bar position
            let current_step: String?   // phase token → StageTimeline
            let step_message: String?   // fine-grained human label
            let ask: AskPayload?        // Phase D: the parked question (status=needs_input)
            let rendered_video_url: String?
            let hls_manifest_url: String?
            let thumbnail_url: String?
            let error_message: String?
            let result: JobResult?      // carries error_code (e.g. UPLOAD_STALLED)
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
                // EMPTY ROW = the job doesn't exist server-side. Two cases
                // (stuck-jobs directive — never a silent return):
                //   - a LIVE dispatch this session: the row simply isn't
                //     created yet (upload still running). The coordinator owns
                //     it and its 20-min deadline bounds it — leave it alone.
                //   - anything else (restored bubble, pruned/deleted row):
                //     nothing can ever resolve it — terminalize into the
                //     failure card NOW instead of spinning forever.
                guard let idx = messages.firstIndex(where: { $0.jobId == jobId }) else { return }
                // Already terminal (failed/completed/canceled): nothing to
                // heal — NEVER rewrite persisted failure copy (review fix:
                // includeFailed reconciles re-check failed messages, and this
                // branch was clobbering their real error copy on every load).
                if let st = messages[idx].jobStatus, JobLifecycle.isTerminal(st) { return }
                // A dispatch alive in THIS process owns the row-less window
                // (upload still running; its 20-min deadline bounds it). The
                // registry survives chat switches — a message-transient flag
                // does not (review critical: reload reset it and this branch
                // killed LIVE uploads with "you weren't charged" while the
                // coordinator went on to charge).
                if JobDispatchCoordinator.shared.isDispatchActive(jobId) { return }
                let wasProcessing = messages[idx].jobStatus == "processing" || messages[idx].jobStatus == "queued"
                print("[reconcile] \(jobId) row missing — terminalizing (wasProcessing=\(wasProcessing))")
                messages[idx].jobStatus = "failed"
                messages[idx].stageTimeline = nil
                messages[idx].stepMessage = nil
                messages[idx].error = wasProcessing
                    ? "This render expired on our side — you weren't charged. Please try again."
                    : "This upload didn't finish — your video is safe on your device. Please send it again."
                persistMessages()
                return
            }
            guard let idx = messages.firstIndex(where: { $0.jobId == jobId }) else { return }
            messages[idx].serverRowExists = true  // a row decoded — cancel is meaningful now

            // Poll is authoritative for the bar. Rehydrate progress + phase
            // from the durable row on EVERY tick (foreground, heartbeat,
            // relaunch) — monotonic, so it can never move the bar backward.
            // This runs before the terminal switch so an in-flight render's
            // bar tracks reality even when SSE missed events.
            // Map the raw worker pct onto the SAME 30–100 display band the SSE
            // handler uses (30 + pct*0.7), so the durable poll lands on ONE
            // scale with SSE. Without this the poll's raw value (e.g. render
            // pct 65) sits below the SSE-mapped value (75) and loses the
            // monotonic max() — i.e. the poll wouldn't actually win. Skip
            // pct==0 (queued / worker-not-started) so we don't jump the bar to
            // 30 during the client-side upload band.
            if let p = row.progress, p > 0 {
                let mapped = 30 + Int(p * 0.7)
                let clamped = max(0, min(100, mapped))
                if clamped > (messages[idx].jobProgress ?? 0) {
                    messages[idx].jobProgress = clamped
                }
            }
            if let step = row.current_step, !step.isEmpty {
                messages[idx].stageTimeline?.receive(stepToken: step)
            }
            // Mirror the SSE handler's suppression: don't overwrite the locally
            // owned "Finalizing your video..." copy during the finish hold.
            if let sm = row.step_message, !sm.isEmpty,
               messages[idx].stepMessage != "Finalizing your video..." {
                messages[idx].stepMessage = sm
            }

            switch row.status {
            case "completed", "complete":
                if let v = row.rendered_video_url { messages[idx].renderedVideoUrl = v }
                if let h = row.hls_manifest_url { messages[idx].hlsManifestUrl = h }
                if let t = row.thumbnail_url { messages[idx].thumbnailUrl = t }
                // §6: the reconcile already fetched `result` — take the post
                // package straight from it (no extra request on this path).
                if let pkg = row.result?.post_package, pkg.hasContent {
                    messages[idx].postPackage = pkg
                }
                // Don't finalize a videoless "ready": if the DB says completed
                // but no playable URL is populated yet, stay in-flight so the
                // next reconcile/SSE tick fills it in. A completed message is
                // never re-reconciled, so finalizing without a URL would
                // permanently show "Your video is ready!" with no video.
                guard messages[idx].renderedVideoUrl != nil || messages[idx].hlsManifestUrl != nil else {
                    persistMessages()
                    print("[reconcile] \(jobId) completed but no video URL yet — staying in-flight")
                    return
                }
                // Finish beat (parity with the SSE completion path): sweep the
                // bar to 100 before revealing the video instead of popping it
                // away at a partial value. isFinishing keeps the progress view
                // mounted (MessageBubble's guard) so trickle.complete() can
                // ease to 100 during the 0.7s hold, then we flip to completed.
                if messages[idx].isFinishing {
                    // A prior tick already started the finish beat; let it run.
                    persistMessages()
                    return
                }
                messages[idx].jobProgress = 100
                messages[idx].isFinishing = true
                persistMessages()
                let finishId = messages[idx].id
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(0.7))
                    guard let fi = messages.firstIndex(where: { $0.id == finishId }) else { return }
                    guard messages[fi].renderedVideoUrl != nil || messages[fi].hlsManifestUrl != nil else { return }
                    messages[fi].jobStatus = "completed"
                    messages[fi].content = "Your video is ready!"
                    messages[fi].error = nil
                    messages[fi].stageTimeline?.finish()
                    persistMessages()
                }
                print("[reconcile] \(jobId) → finishing → completed")
                return
            case "failed":
                // UPLOAD_STALLED auto-recovery: the worker couldn't fetch the
                // source in time (a stalled PUT) and coded it retryable. Silently
                // re-run the render ONCE — a slow-but-alive upload has usually
                // finished landing in S3 by the time this lands — BEFORE showing
                // anything. A SECOND UPLOAD_STALLED (flag set) falls through to the
                // honest error card, whose "Upload a new video" button (onMakeAnother)
                // is the one-tap recovery.
                if row.result?.error_code == "UPLOAD_STALLED",
                   !messages[idx].didAutoRetryUploadStall,
                   let src = messages[idx].cachedSourceUrl,
                   let vibe = messages[idx].cachedVibe {
                    messages[idx].didAutoRetryUploadStall = true
                    let mid = messages[idx].id
                    let proxy = messages[idx].cachedProxyUrl
                    persistMessages()
                    print("[reconcile] \(jobId) → UPLOAD_STALLED — silent auto-retry (once)")
                    Task { @MainActor in
                        retryFailedRender(messageId: mid, sourceUrl: src, proxyUrl: proxy, vibe: vibe)
                    }
                    return
                }
                messages[idx].jobStatus = "failed"
                messages[idx].error = row.error_message ?? "Something went wrong."
                messages[idx].stageTimeline?.finish()
                print("[reconcile] \(jobId) → failed")
            case "needs_input":
                // Phase D ask-back: the worker parked on a question. Surface it —
                // the bubble renders the ask card and holds the bar ("Lumen has a
                // question"). Keeps getting polled (needs_input is in the in-flight
                // filter) so a resume / self-complete-on-timeout is caught.
                if let ask = row.ask, ask.isRenderable {
                    // A stale poll (captured before the user answered) must not
                    // re-park an ask the user already resolved.
                    if answeredAskIds.contains(ask.askId) {
                        print("[reconcile] \(jobId) needs_input ask=\(ask.askId) already answered — ignoring stale poll")
                        return
                    }
                    messages[idx].ask = ask
                    messages[idx].jobStatus = "needs_input"
                    messages[idx].stepMessage = "Lumen has a question"
                    print("[reconcile] \(jobId) → needs_input (ask=\(ask.askId))")
                } else {
                    // No renderable ask (legacy re-edit needs_clarification) —
                    // leave to the SSE clarification path; don't finalize here.
                    print("[reconcile] \(jobId) → needs_input, no renderable ask — leaving in-flight")
                    return
                }
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
                           msg.jobStatus == "needs_input" ||   // parked on a question — keep polling
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


/// Marker thrown by runLayer2Validate when the backend /validate
/// endpoint rejects the clip. The caller already showed the user-
/// facing alert; throwing this is just the signal to bail out of
/// the upload Task cleanly without flagging an upload error.
private struct Layer2RejectionSentinel: Error {}


// MARK: - Push pre-permission explainer

/// The soft ask shown once on the first upload, BEFORE the iOS system dialog.
/// Extracted into a ViewModifier so its two-button + message closures type-check
/// on their own instead of inside EditorView.body's already-maximal modifier chain.
private struct PushExplainerAlert: ViewModifier {
    @Binding var isPresented: Bool
    func body(content: Content) -> some View {
        content.alert("Get notified when it's ready?", isPresented: $isPresented) {
            Button("Notify me") {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                PushService.shared.markSoftPromptOffered()
                Analytics.track("push_softprompt", props: ["choice": "accept"])
                Task { await PushService.shared.requestPermissionIfNeeded() }
            }
            Button("Not now", role: .cancel) {
                PushService.shared.markSoftPromptOffered()
                Analytics.track("push_softprompt", props: ["choice": "decline"])
            }
        } message: {
            Text("Renders take a few minutes — want us to tell you the second yours is ready?")
        }
    }
}


// MARK: - Freemium usage meter + upgrade pill (staged for 1.3.1)

/// Thin usage strip that sits directly above the composer. Free users only —
/// it removes itself for Pro (unlimited) and before the first snapshot loads.
/// With quota it's a quiet "N free videos left today"; at the cap it escalates
/// to a reset countdown + a gold "Get more usage" link into the paywall. This
/// is DISPLAY ONLY — the server is the real gate (see UsageService).
private struct UsageMeterStrip: View {
    var onUpgrade: () -> Void
    @ObservedObject private var usage = UsageService.shared
    @ObservedObject private var subscription = SubscriptionService.shared

    /// The daily reset shown as a LOCAL wall-clock time (e.g. "5:00 PM") — the user's
    /// timezone + locale, so it reads as a real clock time, not a rolling duration.
    private static let resetTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.timeStyle = .short
        f.dateStyle = .none
        return f
    }()

    var body: some View {
        // `rendersLeft` is non-nil ONLY once the server snapshot has loaded, so
        // this both hides the strip for Pro and shows nothing until we have a
        // real server number — never a guessed limit.
        if !subscription.effectiveIsPro, let left = usage.rendersLeft {
            HStack(spacing: 7) {
                Image(systemName: left > 0 ? "bolt.fill" : "bolt.slash.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(left > 0 ? PromptlyGold.solid : Color.white.opacity(0.45))

                Group {
                    if left > 0 {
                        // Automatic grammar agreement pluralizes "video" off the count.
                        Text("^[\(left) free video](inflect: true) left today")
                    } else if let reset = usage.resetsAt, reset > Date() {
                        // (c) Show the reset as a LOCAL wall-clock TIME, not a bare
                        // duration. The quota resets at a fixed instant (UTC midnight),
                        // so "resets in 2h 25m" reads as an arbitrary rolling timer —
                        // the honest, calm form is the actual local time it comes back
                        // ("resets at 5:00 PM"), with a "tomorrow" hint when that lands
                        // on the next local day. (Rolling 24h-from-use is the queued
                        // follow-up — see the quota note.)
                        let cal = Calendar.current
                        let dayHint = cal.isDateInToday(reset) ? ""
                            : (cal.isDateInTomorrow(reset) ? " tomorrow" : "")
                        Text("No free videos left · resets at \(Self.resetTimeFormatter.string(from: reset))\(dayHint)")
                    } else {
                        Text("No free videos left today")
                    }
                }
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.white.opacity(0.6))
                .lineLimit(1)
                .minimumScaleFactor(0.85)

                Spacer(minLength: 8)

                if left <= 0 {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onUpgrade()
                    } label: {
                        Text("Get more usage")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(PromptlyGold.solid)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, Theme.Space.sm)
            .padding(.top, 2)
            .padding(.bottom, 6)
            .transition(.opacity)
            .animation(.easeInOut(duration: 0.2), value: left)
        }
    }
}

// MARK: - UpgradePill (build 216)
//
// Rebuilt after builds 214 & 215 both failed on-device: the NavigationStack
// toolbar's UIKit host froze TWO SwiftUI animation drivers (a TimelineView
// subtree was dropped; a hueRotation was frozen) and mangled the logo into an
// opaque rectangle. Two changes fix it for good:
//   1. The pill now lives in a CUSTOM SwiftUI top bar (EditorView.customTopBar),
//      not the toolbar — see that view. Nothing here is UIKit-hosted.
//   2. The rotating border is driven by CORE ANIMATION (CAGradientLayer +
//      CABasicAnimation, via RotatingConicBorder). CA runs on the render server,
//      outside SwiftUI's transaction/display-link, so NO parent hosting can
//      freeze it — belt-and-suspenders against a repeat.
// The transparent Promptly mark (Assets.xcassets/PromptlyLogo.imageset/
// promptly-logo.png, hasAlpha) renders with .original — its transparency intact
// on black, no plate, no box. Reduce Motion → a static (non-rotating) border.
struct UpgradePill: View {
    var action: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    // Promptly's own RGB spectrum, anchored by the brand gold. First == last so
    // the conic sweep loops seamlessly with no seam at the wrap.
    private static let uiSpectrum: [UIColor] = [
        UIColor(Color(hex: "F4E4BC")), // cream-gold (brand anchor)
        UIColor(Color(hex: "FF7A5C")), // coral
        UIColor(Color(hex: "C86DD7")), // magenta
        UIColor(Color(hex: "7A5CFF")), // violet
        UIColor(Color(hex: "5B8CFF")), // azure
        UIColor(Color(hex: "36D6C3")), // teal
        UIColor(Color(hex: "F4E4BC")), // back to gold — seamless
    ]

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            HStack(spacing: 6) {
                Image("PromptlyLogo")
                    .renderingMode(.original)   // keep the mark's transparency + white
                    .resizable()
                    .aspectRatio(contentMode: .fit)
                    .frame(width: 14, height: 14)
                Text("Upgrade")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white)
            }
            .fixedSize()
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                // Subtle top-lit dark capsule — depth, not a flat chip.
                Capsule().fill(
                    LinearGradient(colors: [Color(hex: "20202A"), Color(hex: "0E0E12")],
                                   startPoint: .top, endPoint: .bottom)
                )
            )
            .overlay(
                // CA-driven rotating conic border — cannot be frozen by hosting.
                // ~8s / revolution: slow, subtle, luxurious.
                RotatingConicBorder(colors: Self.uiSpectrum,
                                    lineWidth: 1.5,
                                    period: 8,
                                    animated: !reduceMotion)
                    .clipShape(Capsule())
                    .allowsHitTesting(false)
            )
            // Soft matching glow.
            .shadow(color: Color(hex: "C86DD7").opacity(reduceMotion ? 0.30 : 0.45), radius: 6)
            .shadow(color: Color(hex: "5B8CFF").opacity(reduceMotion ? 0.18 : 0.30), radius: 10)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Upgrade to Promptly Pro")
    }
}

// MARK: - RotatingConicBorder (Core Animation)
//
// A capsule-shaped stroke filled with a conic RGB gradient that rotates forever
// via CABasicAnimation. CA animations run on the render server, independent of
// SwiftUI's transaction/display-link — a UIKit-hosted parent (toolbar, sheet,
// anything) CANNOT freeze it. This is the animation path builds 214 & 215 needed.
struct RotatingConicBorder: UIViewRepresentable {
    var colors: [UIColor]
    var lineWidth: CGFloat = 1.5
    var period: Double = 8
    var animated: Bool = true

    func makeUIView(context: Context) -> ConicBorderView {
        let v = ConicBorderView()
        v.apply(colors: colors, lineWidth: lineWidth, period: period, animated: animated)
        return v
    }
    func updateUIView(_ v: ConicBorderView, context: Context) {
        v.apply(colors: colors, lineWidth: lineWidth, period: period, animated: animated)
    }
}

final class ConicBorderView: UIView {
    private let gradient = CAGradientLayer()
    private let ringMask = CAShapeLayer()
    private var lineWidth: CGFloat = 1.5
    private var period: Double = 8
    private var animated = true

    override init(frame: CGRect) {
        super.init(frame: frame)
        isUserInteractionEnabled = false
        backgroundColor = .clear
        gradient.type = .conic
        gradient.startPoint = CGPoint(x: 0.5, y: 0.5)   // center
        gradient.endPoint = CGPoint(x: 1.0, y: 0.5)     // 0° reference for the sweep
        layer.addSublayer(gradient)
        // Stationary capsule-STROKE mask: only the ring shows the gradient. The
        // ring stays put while the gradient spins underneath it.
        ringMask.fillColor = UIColor.clear.cgColor
        ringMask.strokeColor = UIColor.white.cgColor
        ringMask.lineWidth = lineWidth
        layer.mask = ringMask
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

    func apply(colors: [UIColor], lineWidth: CGFloat, period: Double, animated: Bool) {
        gradient.colors = colors.map { $0.cgColor }
        self.lineWidth = lineWidth
        self.period = period
        self.animated = animated
        ringMask.lineWidth = lineWidth
        setNeedsLayout()
        restartAnimation()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // Oversize the gradient so rotation never reveals empty corners.
        let diag = hypot(bounds.width, bounds.height) * 1.4
        gradient.bounds = CGRect(x: 0, y: 0, width: diag, height: diag)
        gradient.position = CGPoint(x: bounds.midX, y: bounds.midY)
        let inset = lineWidth / 2
        let radius = max(0, (bounds.height - lineWidth) / 2)
        ringMask.frame = bounds
        ringMask.path = UIBezierPath(roundedRect: bounds.insetBy(dx: inset, dy: inset),
                                     cornerRadius: radius).cgPath
        CATransaction.commit()
    }

    private func restartAnimation() {
        gradient.removeAnimation(forKey: "spin")
        guard animated else { return }
        let spin = CABasicAnimation(keyPath: "transform.rotation.z")
        spin.fromValue = 0.0
        spin.toValue = 2.0 * Double.pi
        spin.duration = period
        spin.repeatCount = .infinity
        spin.isRemovedOnCompletion = false
        gradient.add(spin, forKey: "spin")
    }

    // CA strips animations when a layer leaves the render tree; re-arm on return.
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil, animated { restartAnimation() }
    }
}
