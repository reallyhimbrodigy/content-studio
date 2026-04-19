import SwiftUI
import AVKit

struct MessageBubble: View {
    let message: ChatMessage

    var body: some View {
        HStack {
            if message.role == .user { Spacer(minLength: 60) }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 6) {
                // Video attachment thumbnail
                if let attachment = message.videoAttachment, let thumb = attachment.thumbnail {
                    Image(uiImage: thumb)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 180, height: 240)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }

                // Text bubble
                if !message.content.isEmpty {
                    Text(message.content)
                        .font(.system(size: 16))
                        .foregroundColor(message.role == .user ? .white : Color(hex: "E0E0E0"))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(bubbleColor)
                        .clipShape(BubbleShape(isUser: message.role == .user))
                }

                // Thinking dots
                if message.isThinking { ThinkingDots() }

                // Processing state
                if let status = message.jobStatus,
                   !["completed", "complete", "failed", "error"].contains(status) {
                    ProcessingBubble(
                        stepMessage: message.stepMessage ?? "Getting started...",
                        progress: message.jobProgress ?? 0
                    )
                }

                // Completed video
                if let videoUrlStr = message.renderedVideoUrl {
                    CompletedVideoView(videoUrlStr: videoUrlStr, thumbnailUrlStr: message.thumbnailUrl)
                }

                // Error
                if message.jobStatus == "failed" || message.jobStatus == "error" {
                    Text(message.error ?? "Something went wrong.")
                        .font(.system(size: 13))
                        .foregroundColor(Color(hex: "FF453A"))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Color(hex: "2C2C2E"))
                        .clipShape(BubbleShape(isUser: false))
                }
            }
            .frame(maxWidth: UIScreen.main.bounds.width * 0.82, alignment: message.role == .user ? .trailing : .leading)

            if message.role == .assistant { Spacer(minLength: 60) }
        }
    }

    private var bubbleColor: Color {
        switch message.role {
        case .user: return Color(hex: "3B82F6")
        case .assistant: return Color(hex: "2C2C2E")
        case .system: return Color.white.opacity(0.04)
        }
    }
}

// MARK: - Bubble Shape

struct BubbleShape: Shape {
    let isUser: Bool
    func path(in rect: CGRect) -> Path {
        var path = Path()
        if isUser {
            path.addRoundedRect(in: rect, cornerRadii: .init(topLeading: 18, bottomLeading: 18, bottomTrailing: 4, topTrailing: 18))
        } else {
            path.addRoundedRect(in: rect, cornerRadii: .init(topLeading: 18, bottomLeading: 4, bottomTrailing: 18, topTrailing: 18))
        }
        return path
    }
}

// MARK: - Thinking Dots

struct ThinkingDots: View {
    @State private var animating = false
    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Color.white.opacity(0.35))
                    .frame(width: 8, height: 8)
                    .offset(y: animating ? -8 : 0)
                    .animation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true).delay(Double(i) * 0.15), value: animating)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .background(Color(hex: "2C2C2E"))
        .clipShape(BubbleShape(isUser: false))
        .onAppear { animating = true }
    }
}

// MARK: - Processing Bubble (native iOS style)

struct ProcessingBubble: View {
    let stepMessage: String
    let progress: Int
    @State private var dotPulsing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Circle()
                    .fill(Color(hex: "3B82F6"))
                    .frame(width: 10, height: 10)
                    .shadow(color: Color(hex: "3B82F6").opacity(0.5), radius: dotPulsing ? 8 : 3)
                    .scaleEffect(dotPulsing ? 1.15 : 0.85)
                    .animation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: dotPulsing)

                Text(stepMessage)
                    .font(.system(size: 15))
                    .foregroundColor(Color(hex: "E0E0E0"))
                    .lineLimit(2)
            }

            ProgressView(value: max(0.02, Double(progress) / 100.0))
                .tint(Color(hex: "3B82F6"))
                .animation(.easeInOut(duration: 0.5), value: progress)
        }
        .padding(16)
        .frame(maxWidth: 280, alignment: .leading)
        .background(Color(hex: "2C2C2E"))
        .clipShape(BubbleShape(isUser: false))
        .onAppear { dotPulsing = true }
    }
}

// MARK: - Completed Video

struct CompletedVideoView: View {
    let videoUrlStr: String
    let thumbnailUrlStr: String?
    @State private var player: AVPlayer?
    @State private var isPlaying = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack {
                if let player = player {
                    VideoPlayer(player: player)
                        .frame(height: 340)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                } else {
                    // Thumbnail or placeholder
                    ZStack {
                        if let thumbUrl = thumbnailUrlStr, let url = URL(string: thumbUrl) {
                            AsyncImage(url: url) { phase in
                                if let image = phase.image {
                                    image.resizable().aspectRatio(contentMode: .fill)
                                } else {
                                    Color(hex: "1C1C1E")
                                }
                            }
                        } else {
                            Color(hex: "1C1C1E")
                        }

                        // Play button overlay
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 48))
                            .foregroundColor(.white.opacity(0.9))
                            .shadow(color: .black.opacity(0.3), radius: 8)
                    }
                    .frame(height: 340)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
                    .onTapGesture {
                        guard let url = URL(string: videoUrlStr) else { return }
                        let p = AVPlayer(url: url)
                        player = p
                        p.play()
                        isPlaying = true
                    }
                }
            }

            // Share button
            if let url = URL(string: videoUrlStr) {
                ShareLink(item: url) {
                    HStack(spacing: 6) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.system(size: 14, weight: .semibold))
                        Text("Share")
                            .font(.system(size: 14, weight: .semibold))
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .background(Color(hex: "3B82F6"))
                    .foregroundColor(.white)
                    .cornerRadius(12)
                }
            }
        }
    }
}
