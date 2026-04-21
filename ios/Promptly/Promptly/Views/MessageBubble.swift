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
            if let attachment = message.videoAttachment {
                if let thumb = attachment.thumbnail {
                    Image(uiImage: thumb)
                        .resizable()
                        .aspectRatio(contentMode: .fill)
                        .frame(width: 172, height: 229)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                } else if let thumbUrlStr = attachment.remoteThumbnailUrl, let thumbUrl = URL(string: thumbUrlStr) {
                    AsyncImage(url: thumbUrl) { phase in
                        if let image = phase.image {
                            image.resizable().aspectRatio(contentMode: .fill)
                        } else {
                            Color(.tertiarySystemBackground)
                        }
                    }
                    .frame(width: 172, height: 229)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
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
                if let timeline = message.stageTimeline {
                    PipelineProgressView(timeline: timeline, progress: message.jobProgress ?? 0)
                } else {
                    ProcessingIndicator(
                        stepMessage: message.stepMessage ?? "Getting started...",
                        progress: message.jobProgress ?? 0
                    )
                }
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
//
// Smoothly creeps displayed toward the target each tick. Past bug: we used
// Timer.scheduledTimer whose closure captured `progress` from a value-type
// View struct, freezing the target at whatever it was at ticker creation
// time (usually 0). Result: bar stuck at 1% forever on re-edit because there
// was no pre-SSE upload phase to update it. Fix: mirror `progress` into a
// @State var via .onChange(initial: true); .task reads the @State through
// the property wrapper so it always sees the live value.

struct ProcessingIndicator: View {
    let stepMessage: String
    let progress: Int              // target from upload/SSE
    @State private var displayed: Int = 0
    @State private var target: Int = 0
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
        .onAppear { pulse = true }
        .onChange(of: progress, initial: true) { _, new in
            if new > target { target = new }
        }
        .task {
            // One task per view identity. Reads @State `target` + `displayed`
            // through the property wrapper so it always sees the latest values
            // even though the enclosing struct is value-typed.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 120_000_000)
                if Task.isCancelled { break }
                let delta = target - displayed
                if delta > 0 {
                    let step = max(1, delta / 5)
                    displayed = min(target, displayed + step)
                }
            }
        }
    }
}

// MARK: - Pipeline Progress (stage-aware, skip-tolerant, expandable)
//
// Replaces ProcessingIndicator for jobs that have a StageTimeline. Shows:
//   - Active stage row: SF Symbol (pulsing) + stage title + smoothed percent
//   - Progress bar (same ticker smoothing as before, drives the numeric %)
//   - Completed trail: last two finished stages as a compact subtitle
//   - Expandable "View all steps" disclosure: per-stage status glyphs
//     (completed / in-progress / upcoming / skipped) with the skipped ones
//     struck-through + captioned "not needed"
//
// The display is driven by the observable StageTimeline on the message. All
// skip inference happens inside the timeline; this view is purely
// presentational.

struct PipelineProgressView: View {
    @ObservedObject var timeline: StageTimeline
    let progress: Int
    @State private var displayed: Int = 0
    @State private var target: Int = 0
    @State private var expanded: Bool = false

    private var activeStage: PipelineStage? {
        if let did = timeline.currentDerivedId, let s = timeline.stages.first(where: { $0.id == did }) {
            return s
        }
        if let cid = timeline.currentStageId, let s = timeline.stages.first(where: { $0.id == cid }) {
            return s
        }
        return timeline.stages.first
    }

    /// Last two completed stages, in order of completion.
    private var completedTrail: [PipelineStage] {
        let completedIds = Set(timeline.states.filter { $0.value == .completed }.map { $0.key })
        let completed = timeline.stages.filter { completedIds.contains($0.id) }
        return Array(completed.suffix(2))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Active stage header
            HStack(alignment: .center, spacing: 10) {
                stageIcon
                Text(activeStage?.title ?? "Getting started")
                    .font(.system(size: 15))
                    .foregroundColor(.white)
                    .lineLimit(2)
                    .transition(.opacity)
                Spacer(minLength: 8)
                Text("\(max(displayed, 1))%")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.secondary)
                    .monospacedDigit()
                    .contentTransition(.numericText())
            }
            .animation(.easeInOut(duration: 0.25), value: activeStage?.id)

            // Progress bar
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

            // Completed trail — last two finished stages, compact
            if !completedTrail.isEmpty {
                HStack(spacing: 10) {
                    ForEach(completedTrail) { stage in
                        HStack(spacing: 4) {
                            Image(systemName: "checkmark")
                                .font(.system(size: 9, weight: .semibold))
                            Text(stage.title)
                                .font(.system(size: 11))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                        .foregroundColor(Color(.secondaryLabel))
                    }
                    Spacer(minLength: 0)
                }
                .transition(.opacity)
            }

            // Expandable steps list
            Button {
                withAnimation(.easeInOut(duration: 0.22)) { expanded.toggle() }
            } label: {
                HStack(spacing: 4) {
                    Text(expanded ? "Hide steps" : "View all steps")
                        .font(.system(size: 12, weight: .medium))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .foregroundColor(Color(.secondaryLabel))
            }
            .buttonStyle(.plain)

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(timeline.stages) { stage in
                        stageRow(stage)
                    }
                }
                .padding(.top, 2)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: 340, alignment: .leading)
        .animation(.easeOut(duration: 0.18), value: displayed)
        .onChange(of: progress, initial: true) { _, new in
            if new > target { target = new }
        }
        .task {
            // Smoothed creep toward target — same pattern as ProcessingIndicator.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 120_000_000)
                if Task.isCancelled { break }
                let delta = target - displayed
                if delta > 0 {
                    let step = max(1, delta / 5)
                    displayed = min(target, displayed + step)
                }
            }
        }
    }

    @ViewBuilder
    private var stageIcon: some View {
        if let stage = activeStage {
            Image(systemName: stage.icon)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.white)
                .symbolEffect(.pulse.byLayer, options: .repeating)
                .frame(width: 20, height: 20)
                .transition(.scale.combined(with: .opacity))
        } else {
            Circle()
                .fill(Color.white.opacity(0.5))
                .frame(width: 8, height: 8)
                .frame(width: 20, height: 20)
        }
    }

    @ViewBuilder
    private func stageRow(_ stage: PipelineStage) -> some View {
        let state = timeline.states[stage.id] ?? .upcoming
        HStack(spacing: 10) {
            Group {
                switch state {
                case .completed:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.white)
                case .inProgress:
                    Image(systemName: stage.icon)
                        .foregroundColor(.white)
                        .symbolEffect(.pulse.byLayer, options: .repeating)
                case .upcoming:
                    Image(systemName: "circle")
                        .foregroundColor(Color(.tertiaryLabel))
                case .skipped:
                    Image(systemName: "minus.circle")
                        .foregroundColor(Color(.tertiaryLabel))
                }
            }
            .font(.system(size: 14))
            .frame(width: 18, height: 18)

            Text(stage.title)
                .font(.system(size: 13))
                .foregroundColor(rowTextColor(state))
                .strikethrough(state == .skipped, color: Color(.tertiaryLabel))
                .lineLimit(1)

            if state == .skipped {
                Text("not needed")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundColor(Color(.tertiaryLabel))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(Color(.tertiarySystemBackground).opacity(0.6))
                    .clipShape(Capsule())
            }

            Spacer(minLength: 0)
        }
        .padding(.leading, stage.parent != nil ? 20 : 0)
    }

    private func rowTextColor(_ state: StageState) -> Color {
        switch state {
        case .completed, .inProgress: return .white
        case .upcoming:               return Color(.secondaryLabel)
        case .skipped:                return Color(.tertiaryLabel)
        }
    }
}

// MARK: - Completed Video (iOS-native card — clean thumbnail, contextMenu for actions)
//
// Tapping the thumbnail presents AVPlayerViewController as a true UIKit modal
// via UIWindowScene — no SwiftUI fullScreenCover wrapper, no custom X button,
// no NativeVideoPlayer representable. This uses iOS's standard video-modal
// presentation style (the same one Apple's own apps use): swipe-down to
// dismiss, native scrubber + PiP + AirPlay + Done button, nothing layered on top.

struct CompletedVideoView: View {
    let videoUrlStr: String
    let thumbnailUrlStr: String?

    var body: some View {
        Button {
            VideoPlayerPresenter.present(urlString: videoUrlStr)
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

// MARK: - Video Player Presenter (UIKit-native fullscreen)
//
// AVPlayerViewController presented directly via the key window's topmost
// controller, giving iOS's built-in "immersive video" modal — the same style
// Safari + Photos + Messages use. No SwiftUI wrapping means no overlapping or
// conflicting UI layers. Audio session is configured for .playback so the
// silent switch and interruptions don't kill audio.

enum VideoPlayerPresenter {
    @MainActor
    static func present(urlString: String) {
        guard let url = URL(string: urlString) else { return }

        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)

        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = 10

        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        player.actionAtItemEnd = .pause

        let playerVC = AVPlayerViewController()
        playerVC.player = player
        playerVC.allowsPictureInPicturePlayback = true
        playerVC.videoGravity = .resizeAspect
        playerVC.entersFullScreenWhenPlaybackBegins = false
        playerVC.modalPresentationStyle = .overFullScreen
        playerVC.modalTransitionStyle = .crossDissolve

        guard let topVC = topmostViewController() else { return }
        topVC.present(playerVC, animated: true) {
            player.play()
        }
    }

    @MainActor
    private static func topmostViewController() -> UIViewController? {
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive })
            ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene),
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first,
              let root = window.rootViewController
        else { return nil }

        var current = root
        while let presented = current.presentedViewController {
            current = presented
        }
        return current
    }
}
