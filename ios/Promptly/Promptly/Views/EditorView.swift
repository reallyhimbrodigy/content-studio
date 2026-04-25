import SwiftUI
import PhotosUI
import UIKit

struct EditorView: View {
    @EnvironmentObject private var appState: AppState
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var showVideoPicker = false
    @State private var pendingVideos: [PendingVideo] = []
    @State private var isSending = false
    @State private var conversationHistory: [[String: String]] = []
    @State private var sseClients: [String: SSEClient] = [:]
    @State private var reeditSession: ReeditSession?
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

                inputBar
            }
            .background(Color(.systemBackground))
            .contentShape(Rectangle())
            .onTapGesture {
                isInputFocused = false
            }
            .navigationTitle("Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color(.systemBackground), for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
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
            .onChange(of: appState.pendingReedit) { _, newSession in
                if let s = newSession {
                    reeditSession = s
                    appState.pendingReedit = nil
                    isInputFocused = true
                }
            }
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

    private var emptyState: some View {
        ScrollView {
            VStack(spacing: 20) {
                Spacer(minLength: 80)

                Image(systemName: "video.fill")
                    .font(.system(size: 40))
                    .foregroundColor(Color(.tertiaryLabel))
                    .frame(width: 88, height: 88)
                    .background(Color(.separator))
                    .clipShape(RoundedRectangle(cornerRadius: 24))

                Text("Create your edit")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(.white)

                Text("Upload a video and describe\nthe vibe you want.")
                    .font(.system(size: 15))
                    .foregroundColor(.secondary)
                    .multilineTextAlignment(.center)

                Button {
                    showVideoPicker = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                        Text("Upload Video")
                            .font(.system(size: 17, weight: .semibold))
                    }
                    .frame(height: 52)
                    .frame(maxWidth: 240)
                    .background(Color.white)
                    .foregroundColor(.black)
                    .cornerRadius(14)
                }
                .sensoryFeedback(.impact(weight: .light), trigger: showVideoPicker)

                Spacer(minLength: 80)
            }
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
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
            }
            .sensoryFeedback(.impact(weight: .light), trigger: showVideoPicker)

            TextField("Describe your edit...", text: $inputText, axis: .vertical)
                .focused($isInputFocused)
                .lineLimit(1...6)
                .foregroundColor(.white)
                .font(.system(size: 16))
                .tint(.white)
                .submitLabel(.send)
                .onSubmit { send() }
                .padding(.vertical, 9)
                .padding(.trailing, 4)

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(.black)
                    .frame(width: 30, height: 30)
                    .background(Color.white)
                    .clipShape(Circle())
            }
            .padding(.trailing, 5)
            .padding(.bottom, 5)
            .opacity(canSend ? 1 : 0)
            .scaleEffect(canSend ? 1 : 0.5)
            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: canSend)
            .disabled(!canSend)
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

                        let uploadStart = Date()
                        if APIService.shouldUseMultipart(fileUrl: uploadSourceUrl) {
                            do {
                                publicUrl = try await APIService.shared.uploadFileToS3Multipart(
                                    fileName: pending.fileName,
                                    fileUrl: uploadSourceUrl,
                                    onPublicUrlKnown: { url in firePrewarmOnce.fire(url) }
                                ) { progress in
                                    pending.uploadProgress = progress
                                }
                            } catch {
                                print("[perf] multipart failed (\(error.localizedDescription)) — falling back to single PUT")
                            }
                        }
                        if publicUrl == nil {
                            let urlResponse = try await APIService.shared.getUploadUrl(fileName: pending.fileName)
                            if let uploadUrl = urlResponse.uploadUrl, let pub = urlResponse.publicUrl {
                                firePrewarmOnce.fire(pub)
                                try await APIService.shared.uploadFileToS3(url: uploadUrl, fileUrl: uploadSourceUrl, mimeType: "video/mp4") { progress in
                                    pending.uploadProgress = progress
                                }
                                publicUrl = pub
                            }
                        }
                        print(String(format: "[perf] upload-step %.2fs", Date().timeIntervalSince(uploadStart)))

                        if uploadSourceUrl != sourceUrl {
                            try? FileManager.default.removeItem(at: uploadSourceUrl)
                        }

                    case .stream(let resource, let fileSize):
                        // iCloud-only. Skip the "download fully then
                        // upload" serial flow — stream the bytes straight
                        // through. Total time drops to roughly max(dl, ul)
                        // instead of dl + ul.
                        print(String(format: "[perf] path=stream fileSize=%.1fMB", Double(fileSize) / 1_048_576.0))
                        let uploadStart = Date()
                        do {
                            publicUrl = try await APIService.shared.streamUploadFromICloud(
                                resource: resource,
                                fileSize: fileSize,
                                fileName: pending.fileName,
                                onPublicUrlKnown: { url in firePrewarmOnce.fire(url) }
                            ) { progress in
                                pending.uploadProgress = progress
                            }
                        } catch {
                            print("[perf] stream failed (\(error.localizedDescription)) — falling back to download-then-upload")
                            // Last-resort fallback: drain iCloud to a local
                            // file and use the normal path.
                            let sourceUrl = try await PHAssetResolver.resolveFileUrl(asset: video.asset)
                            await MainActor.run { pending.fileUrl = sourceUrl }
                            let urlResponse = try await APIService.shared.getUploadUrl(fileName: pending.fileName)
                            if let uploadUrl = urlResponse.uploadUrl, let pub = urlResponse.publicUrl {
                                try await APIService.shared.uploadFileToS3(url: uploadUrl, fileUrl: sourceUrl, mimeType: "video/mp4") { progress in
                                    pending.uploadProgress = progress
                                }
                                publicUrl = pub
                            }
                        }
                        print(String(format: "[perf] stream-step %.2fs", Date().timeIntervalSince(uploadStart)))

                    case .none:
                        print("[perf] strategy unresolved — falling back to download path")
                        let sourceUrl = try await PHAssetResolver.resolveFileUrl(asset: video.asset)
                        await MainActor.run { pending.fileUrl = sourceUrl }
                        let urlResponse = try await APIService.shared.getUploadUrl(fileName: pending.fileName)
                        if let uploadUrl = urlResponse.uploadUrl, let pub = urlResponse.publicUrl {
                            try await APIService.shared.uploadFileToS3(url: uploadUrl, fileUrl: sourceUrl, mimeType: "video/mp4") { progress in
                                pending.uploadProgress = progress
                            }
                            publicUrl = pub
                        }
                    }

                    if let publicUrl = publicUrl {
                        await MainActor.run {
                            pending.uploadProgress = 1.0
                            pending.uploadedUrl = publicUrl
                        }
                        // Prewarm was fired the moment the URL was known
                        // (onPublicUrlKnown). If for some reason that
                        // didn't fire (legacy fallback path), still fire
                        // here as a safety net.
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

    // MARK: - Send

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasVideos = !pendingVideos.isEmpty
        let reeditActive = reeditSession != nil
        guard !text.isEmpty || hasVideos else { return }

        // ── Re-edit path — no upload; server loads source from DB
        if reeditActive, let session = reeditSession {
            let changeRequest = text.isEmpty ? "Apply the requested changes." : text
            inputText = ""
            let activeSession = session
            reeditSession = nil
            isSending = true

            var userMsg = ChatMessage(role: .user, content: changeRequest)
            // Show the prior rendered thumbnail as an attachment on the user's
            // side of the re-edit message so the chat clearly reflects that a
            // video is being modified (not a hallucinated edit on nothing).
            userMsg.videoAttachment = VideoAttachment(
                localUrl: URL(fileURLWithPath: ""),
                fileName: "",
                thumbnail: nil,
                remoteThumbnailUrl: activeSession.thumbnailUrl
            )
            messages.append(userMsg)

            // Re-edit defaults to tweak mode catalog; if the server downgrades to
            // reinterpret mid-pipeline, incoming tokens outside the tweak filter
            // are gracefully ignored by StageTimeline (forward-compat).
            var processingMsg = ChatMessage(role: .assistant, content: "", jobStatus: "processing", stepMessage: "Figuring out exactly what to change...")
            processingMsg.stageTimeline = StageTimeline(mode: "tweak")
            // Keep the original vibe around so the completed-video ActionRow's
            // Re-edit button can populate the chip context.
            processingMsg.originalVibe = activeSession.oldVibe.isEmpty ? changeRequest : activeSession.oldVibe
            messages.append(processingMsg)
            let msgIndex = messages.count - 1

            Task {
                do {
                    let newJobId = try await APIService.shared.reeditFromJob(
                        originalJobId: activeSession.originalJobId,
                        changeRequest: changeRequest
                    )
                    await MainActor.run {
                        messages[msgIndex].jobId = newJobId
                        startSSE(jobId: newJobId, messageIndex: msgIndex)
                    }
                } catch {
                    await MainActor.run {
                        messages[msgIndex].jobStatus = "failed"
                        messages[msgIndex].error = error.localizedDescription
                    }
                }
                await MainActor.run { isSending = false }
            }
            return
        }

        isSending = true
        let videos = pendingVideos
        let vibe = text.isEmpty ? "Create a clean, engaging edit" : text

        inputText = ""
        withAnimation { pendingVideos = [] }

        Task {
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
                    let msgIndex = messages.count - 1

                    Task {
                        do {
                            var videoUrl = video.uploadedUrl

                            // Wait for the background upload (started when user attached the video)
                            // instead of starting a new one. Mirror its progress into the message.
                            if videoUrl == nil, let task = video.uploadTask {
                                await MainActor.run { messages[msgIndex].stepMessage = "Uploading..." }

                                let mirror = Task { @MainActor in
                                    while !Task.isCancelled {
                                        let pct = max(1, Int(video.uploadProgress * 30))
                                        if pct > (messages[msgIndex].jobProgress ?? 0) {
                                            messages[msgIndex].jobProgress = pct
                                        }
                                        try? await Task.sleep(nanoseconds: 100_000_000)
                                    }
                                }

                                await task.value
                                mirror.cancel()
                                videoUrl = video.uploadedUrl
                            }

                            // Fallback: no background task or it failed — do a fresh upload.
                            if videoUrl == nil, let fileUrl = video.fileUrl {
                                await MainActor.run { messages[msgIndex].stepMessage = "Uploading..." }
                                let compressedUrl = (try? await VideoCompressor.compress(sourceUrl: fileUrl)) ?? fileUrl
                                let urlResponse = try await APIService.shared.getUploadUrl(fileName: video.fileName)
                                if let uploadUrlStr = urlResponse.uploadUrl, let publicUrl = urlResponse.publicUrl {
                                    try await APIService.shared.uploadFileToS3(url: uploadUrlStr, fileUrl: compressedUrl, mimeType: "video/mp4") { progress in
                                        let pct = max(1, Int(progress * 30))
                                        Task { @MainActor in
                                            if pct > (messages[msgIndex].jobProgress ?? 0) {
                                                messages[msgIndex].jobProgress = pct
                                            }
                                        }
                                    }
                                    videoUrl = publicUrl
                                }
                                if compressedUrl != fileUrl { try? FileManager.default.removeItem(at: compressedUrl) }
                            }

                            guard let finalUrl = videoUrl else { throw APIError.uploadFailed }
                            await MainActor.run {
                                messages[msgIndex].stepMessage = "Starting your edit..."
                                if (messages[msgIndex].jobProgress ?? 0) < 35 {
                                    messages[msgIndex].jobProgress = 35
                                }
                            }
                            let jobId = try await APIService.shared.createVideoJob(videoUrl: finalUrl, vibe: vibe)
                            await MainActor.run {
                                messages[msgIndex].jobId = jobId
                                startSSE(jobId: jobId, messageIndex: msgIndex)
                            }
                        } catch {
                            await MainActor.run {
                                messages[msgIndex].jobStatus = "failed"
                                messages[msgIndex].error = error.localizedDescription
                            }
                        }
                    }
                }
            } else {
                let thinkingMsg = ChatMessage(role: .assistant, content: "", isThinking: true)
                messages.append(thinkingMsg)
                let msgIndex = messages.count - 1

                do {
                    let reply = try await APIService.shared.chat(message: text, history: Array(conversationHistory.suffix(20)))
                    messages[msgIndex] = ChatMessage(role: .assistant, content: reply)
                    conversationHistory.append(["role": "assistant", "content": reply])
                } catch {
                    messages[msgIndex] = ChatMessage(role: .assistant, content: "Sorry, I couldn't respond right now.")
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
            if let status = event.status { messages[messageIndex].jobStatus = status }
            if let progress = event.progress {
                // Server reports render progress 0-100. Upload takes 0-35 client-side,
                // so map render into the 35-100 band and never go backwards.
                let mapped = 35 + Int(Double(progress) * 0.65)
                if mapped > (messages[messageIndex].jobProgress ?? 0) {
                    messages[messageIndex].jobProgress = mapped
                }
            }
            if let msg = event.message { messages[messageIndex].stepMessage = msg }
            if let err = event.error { messages[messageIndex].error = err }

            // Feed the authoritative step token into the stage timeline. Unknown
            // or missing tokens are silently ignored — the timeline stays on the
            // previous stage and the old dumb ProcessingIndicator fallback kicks
            // in only when no timeline exists at all.
            if let step = event.step, !step.isEmpty {
                messages[messageIndex].stageTimeline?.receive(stepToken: step)
            }

            if event.status == "completed" || event.status == "complete" {
                messages[messageIndex].jobStatus = "completed"
                messages[messageIndex].content = "Your video is ready!"
                if let url = event.videoUrl { messages[messageIndex].renderedVideoUrl = url }
                if let thumb = event.thumbnailUrl { messages[messageIndex].thumbnailUrl = thumb }
                messages[messageIndex].stageTimeline?.finish()
                if event.final == true { client.disconnect(); sseClients.removeValue(forKey: jobId) }
            }

            if event.status == "failed" || event.status == "error" {
                messages[messageIndex].jobStatus = "failed"
                messages[messageIndex].error = event.error ?? "Something went wrong."
                messages[messageIndex].stageTimeline?.finish()
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
                client.disconnect(); sseClients.removeValue(forKey: jobId)
            }
        }
        client.onError = { errorMsg in
            guard messageIndex < messages.count else { return }
            messages[messageIndex].jobStatus = "failed"
            messages[messageIndex].error = errorMsg
            messages[messageIndex].content = ""
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

            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 18, height: 18)
                    .background(Color.black.opacity(0.7))
                    .clipShape(Circle())
            }
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
