import SwiftUI
import AVKit

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            if message.role == .user {
                Spacer(minLength: 48)
                userContent
            } else {
                assistantContent
                Spacer(minLength: 48)
            }
        }
    }

    // MARK: - User (right-aligned, subtle gray container)

    @ViewBuilder
    private var userContent: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if let attachment = message.videoAttachment, let thumb = attachment.thumbnail {
                Image(uiImage: thumb)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 172, height: 229)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }

            if !message.content.isEmpty {
                Text(message.content)
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color(.tertiarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
    }

    // MARK: - Assistant (flat, no bubble)

    @ViewBuilder
    private var assistantContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if message.isThinking {
                ThinkingDots()
            }

            if let status = message.jobStatus,
               !["completed", "complete", "failed", "error"].contains(status) {
                ProcessingIndicator(
                    stepMessage: message.stepMessage ?? "Getting started...",
                    progress: message.jobProgress ?? 0
                )
            }

            if !message.content.isEmpty {
                Text(message.content)
                    .font(.system(size: 16))
                    .foregroundColor(.white)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let videoUrlStr = message.renderedVideoUrl {
                CompletedVideoView(videoUrlStr: videoUrlStr, thumbnailUrlStr: message.thumbnailUrl)
            }

            if message.jobStatus == "failed" || message.jobStatus == "error" {
                Text(message.error ?? "Something went wrong.")
                    .font(.system(size: 14))
                    .foregroundColor(.red)
            }
        }
    }
}

// MARK: - Thinking Dots (minimal, inline — no bubble)

struct ThinkingDots: View {
    @State private var animating = false
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color(.secondaryLabel))
                    .frame(width: 7, height: 7)
                    .opacity(animating ? 1 : 0.3)
                    .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true).delay(Double(i) * 0.15), value: animating)
            }
        }
        .padding(.vertical, 4)
        .onAppear { animating = true }
    }
}

// MARK: - Processing Indicator (ChatGPT-style — inline, thin progress line)
// Displays a smoothed percent that creeps forward one-by-one toward the target,
// so the bar never bounces even if the server sends a lower value on its first event.

struct ProcessingIndicator: View {
    let stepMessage: String
    let progress: Int              // target value set by upload/SSE
    @State private var displayed: Int = 0
    @State private var ticker: Timer?
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Circle()
                    .fill(Color.white)
                    .frame(width: 6, height: 6)
                    .opacity(pulse ? 1 : 0.35)
                    .animation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true), value: pulse)

                Text(stepMessage)
                    .font(.system(size: 15))
                    .foregroundColor(.white)
                    .lineLimit(2)

                Spacer(minLength: 8)

                Text("\(max(displayed, 1))%")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.secondary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color(.separator).opacity(0.5))
                    Capsule()
                        .fill(Color.white)
                        .frame(width: max(6, geo.size.width * CGFloat(max(0.02, Double(displayed) / 100.0))))
                }
            }
            .frame(height: 3)
        }
        .frame(maxWidth: 320, alignment: .leading)
        .animation(.easeOut(duration: 0.18), value: displayed)
        .onAppear {
            pulse = true
            startTicker()
        }
        .onDisappear { stopTicker() }
    }

    private func startTicker() {
        stopTicker()
        ticker = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: true) { _ in
            let delta = progress - displayed
            guard delta > 0 else { return }
            // Creep one per tick normally; accelerate when far behind so we
            // catch up to a big jump (e.g. 0 → 35 after upload) in <1s.
            let step = max(1, delta / 5)
            displayed = min(progress, displayed + step)
        }
    }

    private func stopTicker() {
        ticker?.invalidate()
        ticker = nil
    }
}

// MARK: - Completed Video (iOS-native card — clean thumbnail, contextMenu for actions)

struct CompletedVideoView: View {
    let videoUrlStr: String
    let thumbnailUrlStr: String?
    @State private var showFullscreen = false

    var body: some View {
        Button {
            showFullscreen = true
        } label: {
            thumbnailContent
                .frame(maxWidth: 240)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                .overlay {
                    LinearGradient(
                        colors: [.black.opacity(0.0), .black.opacity(0.25)],
                        startPoint: .center, endPoint: .bottom
                    )
                    .allowsHitTesting(false)
                }
                .overlay {
                    ZStack {
                        Circle()
                            .fill(.ultraThinMaterial)
                            .frame(width: 62, height: 62)
                        Image(systemName: "play.fill")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundColor(.white)
                            .offset(x: 2)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .buttonStyle(.plain)
        .contextMenu {
            if let url = URL(string: videoUrlStr) {
                ShareLink(item: url) {
                    Label("Share", systemImage: "square.and.arrow.up")
                }
                Button {
                    UIApplication.shared.open(url)
                } label: {
                    Label("Open in Safari", systemImage: "safari")
                }
                Button {
                    UIPasteboard.general.string = videoUrlStr
                } label: {
                    Label("Copy Link", systemImage: "link")
                }
            }
        }
        .fullScreenCover(isPresented: $showFullscreen) {
            FullscreenVideoPlayer(urlStr: videoUrlStr)
        }
    }

    @ViewBuilder
    private var thumbnailContent: some View {
        if let thumbUrl = thumbnailUrlStr, let url = URL(string: thumbUrl) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().aspectRatio(contentMode: .fit)
                } else {
                    Color(.tertiarySystemBackground)
                        .aspectRatio(9/16, contentMode: .fit)
                }
            }
        } else {
            Color(.tertiarySystemBackground)
                .aspectRatio(9/16, contentMode: .fit)
        }
    }
}

// MARK: - Fullscreen Player (native AVPlayerViewController)

struct FullscreenVideoPlayer: View {
    let urlStr: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black.ignoresSafeArea()

            NativeVideoPlayer(urlStr: urlStr)
                .ignoresSafeArea()

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
            }
            .padding(.leading, 16)
            .padding(.top, 8)
        }
        .statusBarHidden(true)
    }
}

struct NativeVideoPlayer: UIViewControllerRepresentable {
    let urlStr: String

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        // Default category (.soloAmbient) mutes on silent switch and drops audio
        // during interruptions. .playback is the standard for video apps —
        // survives the ring switch and handles route changes cleanly.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)

        let vc = AVPlayerViewController()
        vc.showsPlaybackControls = true
        vc.allowsPictureInPicturePlayback = true
        vc.videoGravity = .resizeAspect
        vc.entersFullScreenWhenPlaybackBegins = false
        vc.view.backgroundColor = .black

        if let url = URL(string: urlStr) {
            let item = AVPlayerItem(url: url)
            // Keep a generous forward buffer so audio doesn't starve during streaming.
            item.preferredForwardBufferDuration = 10

            let player = AVPlayer(playerItem: item)
            player.automaticallyWaitsToMinimizeStalling = true
            player.actionAtItemEnd = .pause
            vc.player = player
            player.play()
        }
        return vc
    }

    func updateUIViewController(_ uiViewController: AVPlayerViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: AVPlayerViewController, coordinator: ()) {
        uiViewController.player?.pause()
        uiViewController.player = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
