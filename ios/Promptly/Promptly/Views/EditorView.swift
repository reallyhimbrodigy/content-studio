import SwiftUI
import PhotosUI
import UIKit

struct EditorView: View {
    @State private var messages: [ChatMessage] = []
    @State private var inputText = ""
    @State private var showVideoPicker = false
    @State private var pendingVideos: [PendingVideo] = []
    @State private var isSending = false
    @State private var conversationHistory: [[String: String]] = []
    @State private var sseClients: [String: SSEClient] = [:]
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

                inputBar
            }
            .background(Color.black)
            .contentShape(Rectangle())
            .onTapGesture {
                isInputFocused = false
            }
            .navigationTitle("Edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .sheet(isPresented: $showVideoPicker) {
                NativeVideoPicker(maxSelection: 10) { videos in
                    handlePickedVideos(videos)
                }
                .ignoresSafeArea()
            }
        }
    }

    // MARK: - Empty State

    private var emptyState: some View {
        ScrollView {
            VStack(spacing: 20) {
                Spacer(minLength: 80)

                Image(systemName: "video.fill")
                    .font(.system(size: 40))
                    .foregroundColor(.white.opacity(0.12))
                    .frame(width: 88, height: 88)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 24))

                Text("Create your edit")
                    .font(.system(size: 28, weight: .bold))
                    .foregroundColor(.white)

                Text("Upload a video and describe\nthe vibe you want.")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.4))
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
        .background(Color.black)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button { showVideoPicker = true } label: {
                Image(systemName: "plus")
                    .font(.system(size: 22, weight: .light))
                    .foregroundColor(.white)
                    .frame(width: 44, height: 44)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(Circle())
            }
            .sensoryFeedback(.impact(weight: .light), trigger: showVideoPicker)

            TextField("Describe your edit...", text: $inputText, axis: .vertical)
                .focused($isInputFocused)
                .lineLimit(1...5)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Color(.tertiarySystemBackground))
                .cornerRadius(20)
                .foregroundColor(.white)
                .font(.system(size: 16))
                .tint(Color.white)
                .submitLabel(.send)
                .onSubmit { send() }

            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.black)
                    .frame(width: 44, height: 44)
                    .background(canSend ? Color.white : Color.white.opacity(0.15))
                    .clipShape(Circle())
            }
            .disabled(!canSend)
            .sensoryFeedback(.impact(weight: .medium), trigger: isSending)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.black)
    }

    private var canSend: Bool {
        (!inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingVideos.isEmpty) && !isSending
    }

    // MARK: - Video Selection (INSTANT — no copy, uses PHAsset directly)

    private func handlePickedVideos(_ videos: [PickedVideo]) {
        for video in videos {
            let pending = PendingVideo()
            pending.fileUrl = video.fileUrl
            pending.fileName = video.fileUrl.lastPathComponent
            pending.isLoading = false

            // Thumbnail instantly from direct file URL
            Task {
                let thumb = await ThumbnailGenerator.generate(from: video.fileUrl)
                await MainActor.run { pending.thumbnail = thumb }
            }

            withAnimation(.easeOut(duration: 0.15)) {
                pendingVideos.append(pending)
            }

            // Compress → upload pipeline (runs in background)
            Task {
                do {
                    // Step 1: Compress (hardware accelerated, ~2s)
                    let compressedUrl = try await VideoCompressor.compress(sourceUrl: video.fileUrl)
                    await MainActor.run { pending.fileUrl = compressedUrl }

                    // Step 2: Upload compressed file (much smaller = much faster)
                    let urlResponse = try await APIService.shared.getUploadUrl(fileName: pending.fileName)
                    if let uploadUrl = urlResponse.uploadUrl, let publicUrl = urlResponse.publicUrl {
                        try await APIService.shared.uploadFileToS3(url: uploadUrl, fileUrl: compressedUrl, mimeType: "video/mp4") { progress in
                            pending.uploadProgress = progress
                        }
                        await MainActor.run { pending.uploadedUrl = publicUrl }
                    }

                    // Clean up temp compressed file
                    try? FileManager.default.removeItem(at: compressedUrl)
                } catch {}
            }
        }
    }

    // MARK: - Send

    private func send() {
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasVideos = !pendingVideos.isEmpty
        guard !text.isEmpty || hasVideos else { return }

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

                    let processingMsg = ChatMessage(role: .assistant, content: "", jobStatus: "processing", stepMessage: "Getting started...")
                    messages.append(processingMsg)
                    let msgIndex = messages.count - 1

                    Task {
                        do {
                            var videoUrl = video.uploadedUrl

                            if videoUrl == nil, let fileUrl = video.fileUrl {
                                await MainActor.run { messages[msgIndex].stepMessage = "Preparing your video..." }

                                let compressedUrl = (try? await VideoCompressor.compress(sourceUrl: fileUrl)) ?? fileUrl

                                await MainActor.run { messages[msgIndex].stepMessage = "Uploading..." }
                                let urlResponse = try await APIService.shared.getUploadUrl(fileName: video.fileName)
                                if let uploadUrlStr = urlResponse.uploadUrl, let publicUrl = urlResponse.publicUrl {
                                    try await APIService.shared.uploadFileToS3(url: uploadUrlStr, fileUrl: compressedUrl, mimeType: "video/mp4") { progress in
                                        let pct = Int(progress * 30)
                                        messages[msgIndex].jobProgress = pct
                                    }
                                    videoUrl = publicUrl
                                }
                                if compressedUrl != fileUrl { try? FileManager.default.removeItem(at: compressedUrl) }
                            }

                            guard let finalUrl = videoUrl else { throw APIError.uploadFailed }
                            await MainActor.run {
                                messages[msgIndex].stepMessage = "Starting your edit..."
                                messages[msgIndex].jobProgress = 35
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
            if let progress = event.progress { messages[messageIndex].jobProgress = progress }
            if let msg = event.message { messages[messageIndex].stepMessage = msg }
            if let err = event.error { messages[messageIndex].error = err }

            if event.status == "completed" || event.status == "complete" {
                messages[messageIndex].jobStatus = "completed"
                messages[messageIndex].content = "Your video is ready!"
                if let url = event.videoUrl { messages[messageIndex].renderedVideoUrl = url }
                if let thumb = event.thumbnailUrl { messages[messageIndex].thumbnailUrl = thumb }
                if event.final == true { client.disconnect(); sseClients.removeValue(forKey: jobId) }
            }

            if event.status == "failed" || event.status == "error" {
                messages[messageIndex].jobStatus = "failed"
                messages[messageIndex].error = event.error ?? "Something went wrong."
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

// MARK: - Pending Video Thumbnail

struct PendingVideoThumb: View {
    @ObservedObject var video: PendingVideo
    let onRemove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            ZStack(alignment: .bottom) {
                if let thumb = video.thumbnail {
                    Image(uiImage: thumb)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 72, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                } else {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color(.tertiarySystemBackground))
                        .frame(width: 72, height: 96)
                        .overlay {
                            ProgressView()
                                .tint(.white.opacity(0.4))
                                .scaleEffect(0.8)
                        }
                }

                // Upload progress bar at bottom of thumbnail
                if video.uploadedUrl == nil && video.uploadProgress > 0 && video.uploadProgress < 1 {
                    GeometryReader { geo in
                        VStack {
                            Spacer()
                            RoundedRectangle(cornerRadius: 1)
                                .fill(Color.white)
                                .frame(width: geo.size.width * video.uploadProgress, height: 3)
                                .animation(.easeInOut(duration: 0.2), value: video.uploadProgress)
                        }
                    }
                    .frame(width: 72, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                }

            }

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.white, Color(.systemGray3))
                    .shadow(radius: 2)
            }
            .offset(x: 6, y: -6)
        }
    }
}
