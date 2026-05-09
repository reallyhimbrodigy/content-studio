import SwiftUI
import AVKit
import Photos

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
                        .accessibilityLabel("Attached video")
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
                    .accessibilityLabel("Attached video")
                }
            }

            if !message.content.isEmpty {
                Text(message.content)
                    // Use Dynamic Type for chat content so it scales with
                    // the user's accessibility text-size preference.
                    // Capped at .accessibility3 so the bubble doesn't
                    // bloat at the largest sizes.
                    .font(.body)
                    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    .foregroundColor(.white)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    // User bubble uses the lighter surface to read as the
                    // "active" / outgoing message — paired with the darker
                    // assistant bubble below, this gives a clear visual
                    // distinction without resorting to accent color.
                    .background(Theme.Surface.surface2)
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.06), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
        // Combine the video + text into a single VoiceOver element with
        // a "You said: ..." prefix so it's clear who's speaking.
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(message.videoAttachment != nil ? [] : [])
    }

    // MARK: - Assistant (left-aligned bubble, iMessage-style)

    @ViewBuilder
    private var assistantContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if message.isThinking {
                // Typing indicator wrapped in the same bubble shape as a
                // real reply, so the transition from "thinking" to "answer"
                // feels like the bubble's content morphing in place.
                ThinkingDots()
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
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
                    .font(.body)
                    .dynamicTypeSize(...DynamicTypeSize.accessibility3)
                    .foregroundColor(.white)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    // Translucent white overlay against the page's pure
                    // black gives a clearly distinct "received" treatment
                    // vs the user's solid `tertiarySystemBackground` fill.
                    // The two semantic system grays were only ~16 RGB
                    // points apart in dark mode — visually invisible.
                    // 6% white reads as a soft lift off black with
                    // ~50+ effective RGB difference from the user bubble.
                    .background(Color.white.opacity(0.06))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }

            if let videoUrlStr = message.renderedVideoUrl {
                CompletedVideoView(
                    videoUrlStr: videoUrlStr,
                    thumbnailUrlStr: message.thumbnailUrl,
                    jobId: message.jobId,
                    title: message.originalVibe,
                    onReedit: buildReeditHandler(for: message)
                )
            }

            if message.jobStatus == "failed" || message.jobStatus == "error" {
                Text(message.error ?? "Something went wrong.")
                    .font(.system(size: 14))
                    .foregroundColor(.red)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(Color.red.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
    }

    /// Produce the Re-edit closure for a completed video message. Requires a
    /// jobId (the server needs it as original_job_id to load the parent's
    /// saved edit_recipe / transcript / resolved B-roll). Nil when the message
    /// has no jobId — button is then hidden from the action row.
    private func buildReeditHandler(for message: ChatMessage) -> (() -> Void)? {
        guard let jobId = message.jobId else { return nil }
        let vibe = message.originalVibe ?? ""
        let thumb = message.thumbnailUrl
        return {
            AppState.shared.pendingReedit = ReeditSession(
                originalJobId: jobId,
                oldVibe: vibe,
                thumbnailUrl: thumb
            )
            AppState.shared.selectedTab = 0  // no-op if already on Edit
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
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
        // No stage has fired yet — show a neutral starting state instead of
        // pre-rendering the first catalog entry. The first server event lands
        // within a few hundred ms; during that window we don't want to
        // mislead the user about which specific stage is in progress.
        return nil
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
                Text(activeStage?.title ?? "Starting")
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
                // Only reveal stages that have actually begun (in_progress /
                // completed / skipped). Upcoming ones stay hidden until the
                // server fires their event — the list grows as the pipeline
                // progresses instead of dumping the whole roadmap on the
                // user at once.
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(timeline.stages.filter { (timeline.states[$0.id] ?? .upcoming) != .upcoming }) { stage in
                        stageRow(stage)
                            .transition(.opacity.combined(with: .move(edge: .leading)))
                    }
                }
                .padding(.top, 2)
                .animation(.easeOut(duration: 0.25), value: timeline.currentStageId)
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
            // Neutral "Starting…" glyph shown during the brief window between
            // user tapping Send and the first stage event arriving. Avoids
            // leading with a specific stage label before the worker confirms it.
            Image(systemName: "sparkles")
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.white)
                .symbolEffect(.pulse.byLayer, options: .repeating)
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

// MARK: - Video Exporter (Save to Photos)
//
// One VideoExporter per completed video message (via @StateObject on the
// VideoActionRow). Manages:
//   - Single download of the remote MP4 to a temp file (cached for the
//     session so re-taps don't re-download).
//   - Save-to-Photos with idle / loading / success / error state.
//
// All other share destinations go through the iOS share sheet
// (`shareLinkPill` → `ShareLink`), which handles AirDrop, Messages,
// Mail, copy-to-pasteboard, and any third-party app the user has
// installed (TikTok, Instagram, etc.) without us having to maintain
// per-app SDKs.

@MainActor
final class VideoExporter: ObservableObject {
    let videoUrlStr: String
    let thumbnailUrlStr: String?

    @Published var saveState: ActionState = .idle

    private var cachedLocalUrl: URL?
    private var cachedAssetId: String?

    enum ActionState: Equatable {
        case idle, loading, success
        case error(String)
    }

    enum ExportError: LocalizedError {
        case invalidUrl
        case photosDenied
        case saveFailed(String)
        case appNotInstalled(String)

        var errorDescription: String? {
            switch self {
            case .invalidUrl:        return "Invalid video URL"
            case .photosDenied:      return "Photos access was denied"
            case .saveFailed(let m): return "Couldn't save: \(m)"
            case .appNotInstalled(let app): return "\(app) isn't installed"
            }
        }
    }

    init(videoUrlStr: String, thumbnailUrlStr: String?) {
        self.videoUrlStr = videoUrlStr
        self.thumbnailUrlStr = thumbnailUrlStr
    }

    // MARK: - Private helpers

    private func ensureLocalFile() async throws -> URL {
        if let cached = cachedLocalUrl, FileManager.default.fileExists(atPath: cached.path) {
            return cached
        }
        guard let remoteUrl = URL(string: videoUrlStr) else { throw ExportError.invalidUrl }
        let (tempUrl, _) = try await URLSession.shared.download(from: remoteUrl)
        let finalUrl = FileManager.default.temporaryDirectory
            .appendingPathComponent("promptly-export-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: finalUrl)
        try FileManager.default.moveItem(at: tempUrl, to: finalUrl)
        cachedLocalUrl = finalUrl
        return finalUrl
    }

    private func ensureSavedToPhotos() async throws -> String {
        if let cached = cachedAssetId { return cached }

        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw ExportError.photosDenied
        }

        let localFile = try await ensureLocalFile()

        var placeholderId: String?
        try await PHPhotoLibrary.shared().performChanges {
            if let req = PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: localFile) {
                placeholderId = req.placeholderForCreatedAsset?.localIdentifier
            }
        }
        guard let id = placeholderId else { throw ExportError.saveFailed("no asset id") }
        cachedAssetId = id
        return id
    }

    // MARK: - Public actions

    func save() {
        Task {
            saveState = .loading
            do {
                _ = try await ensureSavedToPhotos()
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                saveState = .success
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if saveState == .success { saveState = .idle }
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                saveState = .error(error.localizedDescription)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if case .error = saveState { saveState = .idle }
            }
        }
    }

}

// MARK: - Video Action Row (iOS Share Sheet aesthetic — circle icon + label)

struct VideoActionRow: View {
    let videoUrlStr: String
    let thumbnailUrlStr: String?
    let onReedit: (() -> Void)?
    @StateObject private var exporter: VideoExporter

    init(videoUrlStr: String, thumbnailUrlStr: String?, onReedit: (() -> Void)?) {
        self.videoUrlStr = videoUrlStr
        self.thumbnailUrlStr = thumbnailUrlStr
        self.onReedit = onReedit
        _exporter = StateObject(wrappedValue: VideoExporter(videoUrlStr: videoUrlStr, thumbnailUrlStr: thumbnailUrlStr))
    }

    var body: some View {
        HStack(spacing: 14) {
            if let onReedit {
                pill(
                    icon: "wand.and.stars",
                    label: "Re-edit",
                    state: .idle,
                    action: onReedit
                )
            }

            pill(
                icon: "square.and.arrow.down",
                label: "Save",
                state: exporter.saveState,
                action: exporter.save
            )

            shareLinkPill

            Spacer(minLength: 0)
        }
        .padding(.top, 8)
    }

    // MARK: - Pill subviews

    @ViewBuilder
    private func pill(
        icon: String,
        label: String,
        state: VideoExporter.ActionState,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }) {
            VStack(spacing: 6) {
                ZStack {
                    Circle().fill(Color(.tertiarySystemBackground))
                    pillSymbol(icon: icon, state: state)
                }
                .frame(width: 48, height: 48)
                .overlay(
                    Circle()
                        .stroke(Color.white.opacity(0.08), lineWidth: 0.5)
                )

                Text(labelText(state: state, defaultLabel: label))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Color(.secondaryLabel))
                    .lineLimit(1)
                    .contentTransition(.identity)
            }
        }
        .buttonStyle(.plain)
        .disabled(state == .loading)
        // Combine the icon + text into one VoiceOver element with a
        // dedicated label per action and a value reflecting in-flight
        // state. Stops VoiceOver from reading the SF symbol name.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel(for: label))
        .accessibilityValue(accessibilityValue(for: state))
    }

    private func accessibilityLabel(for label: String) -> String {
        switch label {
        case "Re-edit": return "Re-edit this video"
        case "Save":    return "Save video to Photos"
        default:        return label
        }
    }

    private func accessibilityValue(for state: VideoExporter.ActionState) -> String {
        switch state {
        case .idle:     return ""
        case .loading:  return "in progress"
        case .success:  return "done"
        case .error:    return "failed"
        }
    }

    @ViewBuilder
    private func pillSymbol(
        icon: String,
        state: VideoExporter.ActionState
    ) -> some View {
        switch state {
        case .idle:
            Image(systemName: icon)
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(.white)
                .symbolRenderingMode(.hierarchical)
        case .loading:
            ProgressView()
                .controlSize(.small)
                .tint(.white)
        case .success:
            Image(systemName: "checkmark")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(.white)
                .transition(.scale.combined(with: .opacity))
        case .error:
            Image(systemName: "exclamationmark")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(.white)
        }
    }

    private func labelText(state: VideoExporter.ActionState, defaultLabel: String) -> String {
        switch state {
        case .success: return "Done"
        case .error:   return "Error"
        default:       return defaultLabel
        }
    }

    @ViewBuilder
    private var shareLinkPill: some View {
        if let url = URL(string: videoUrlStr) {
            ShareLink(item: url) {
                VStack(spacing: 6) {
                    Circle()
                        .fill(Color(.tertiarySystemBackground))
                        .frame(width: 48, height: 48)
                        .overlay {
                            Image(systemName: "square.and.arrow.up")
                                .font(.system(size: 18, weight: .medium))
                                .foregroundColor(.white)
                                .symbolRenderingMode(.hierarchical)
                                .accessibilityHidden(true)
                        }
                    Text("Share")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(.secondaryLabel))
                }
            }
            .accessibilityLabel("Share video")
            .accessibilityAddTraits(.isButton)
            .simultaneousGesture(TapGesture().onEnded {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            })
        }
    }
}

// MARK: - Completed Video (iOS-native card — clean thumbnail + in-chat quick actions)
//
// Tapping the thumbnail presents AVPlayerViewController as a true UIKit modal
// via UIWindowScene — no SwiftUI fullScreenCover wrapper, no custom X button,
// no NativeVideoPlayer representable. This uses iOS's standard video-modal
// presentation style (the same one Apple's own apps use): swipe-down to
// dismiss, native scrubber + PiP + AirPlay + Done button, nothing layered on top.
//
// Below the thumbnail: VideoActionRow — Re-edit / Save / TikTok / Instagram /
// Share pill buttons so the user never has to leave the chat for common tasks.

struct CompletedVideoView: View {
    let videoUrlStr: String
    let thumbnailUrlStr: String?
    let jobId: String?
    let title: String?
    let onReedit: (() -> Void)?

    /// When AsyncImage hits a 403 (signed URL expired past 7 days),
    /// we ask the server for fresh URLs and stash them here. Future
    /// renders of this view use the live URLs in preference to the
    /// stale stored ones.
    @State private var liveVideoUrl: String?
    @State private var liveThumbnailUrl: String?
    @State private var refreshAttempted = false

    /// Drives the loading-vs-playable thumbnail state. Updates the
    /// instant `VideoCache.shared.cachedIds` flips for this jobId.
    @ObservedObject private var cache = VideoCache.shared

    private var effectiveVideoUrl: String { liveVideoUrl ?? videoUrlStr }
    private var effectiveThumbnailUrl: String? { liveThumbnailUrl ?? thumbnailUrlStr }
    private var isCached: Bool {
        guard let jobId else { return false }
        return cache.cachedIds.contains(jobId)
    }
    /// CDN-backed URLs are safe to play directly — AVPlayer streams
    /// from the edge with consistent throughput. No need to wait for
    /// a local cache. Origin S3 URLs require the cache-first path.
    private var isStreamingReady: Bool {
        isStreamingReadyUrl(effectiveVideoUrl)
    }
    /// The play button (and tap) unlock when EITHER the file is
    /// already cached OR the URL points at our CDN. Background
    /// download still runs for offline replay either way.
    private var isPlayable: Bool {
        isCached || isStreamingReady
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button {
                guard isPlayable else { return }
                VideoPlayerPresenter.present(
                    urlString: effectiveVideoUrl,
                    jobId: jobId,
                    title: title,
                    onReedit: onReedit,
                    onRefreshNeeded: { await self.refreshAndReturnVideoUrl() }
                )
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
                    .overlay { thumbnailOverlay }
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!isPlayable)
            .accessibilityLabel(isPlayable ? "Play your edited video" : "Preparing your edited video")
            .accessibilityAddTraits(.isButton)
            .task(id: jobId) {
                // Auto-download the moment this thumbnail comes on screen
                // (no-op if already cached or in flight). Once it lands,
                // VideoCache flips cachedIds and the overlay swaps to
                // the play button without any user action.
                guard let jobId else { return }
                // Pre-warm the AVAsset so that when the user taps Play,
                // tracks/duration are already loaded and first-frame paint
                // is sub-100ms instead of the 300-800ms cold-load window.
                // For streaming-ready URLs this is a small metadata fetch
                // (~moov atom); for cached file URLs the warm hits disk.
                if isStreamingReady {
                    PlayerAssetPrewarm.shared.warm(effectiveVideoUrl)
                }
                if cache.cachedIds.contains(jobId) {
                    if let local = VideoCache.shared.localUrl(forJobId: jobId)?.absoluteString {
                        PlayerAssetPrewarm.shared.warm(local)
                    }
                    return
                }
                _ = await VideoCache.shared.downloadIfNeeded(
                    jobId: jobId,
                    from: effectiveVideoUrl,
                    priority: .userInitiated
                )
                if let local = VideoCache.shared.localUrl(forJobId: jobId)?.absoluteString {
                    PlayerAssetPrewarm.shared.warm(local)
                }
            }
            .contextMenu {
                if isPlayable, let url = URL(string: videoUrlStr) {
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

            VideoActionRow(
                videoUrlStr: videoUrlStr,
                thumbnailUrlStr: thumbnailUrlStr,
                onReedit: onReedit
            )
            .opacity(isPlayable ? 1 : 0.4)
            .disabled(!isPlayable)
        }
    }

    /// The play-button or loading-spinner overlay sits on top of the
    /// thumbnail. Crossfades between states when the cache flips.
    @ViewBuilder
    private var thumbnailOverlay: some View {
        ZStack {
            if isPlayable {
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 62, height: 62)
                Image(systemName: "play.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundColor(.white)
                    .offset(x: 2)
                    .accessibilityHidden(true)
            } else {
                // Dim the thumbnail and show a centered spinner while the
                // file is downloading. Only reached for legacy (non-CDN)
                // URLs where streaming isn't smooth — CDN URLs flip to
                // the play button immediately.
                Color.black.opacity(0.45)
                    .allowsHitTesting(false)
                ProgressView()
                    .progressViewStyle(.circular)
                    .tint(.white)
                    .scaleEffect(1.2)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: isPlayable)
    }

    @ViewBuilder
    private var thumbnailContent: some View {
        if let thumbUrl = effectiveThumbnailUrl, let url = URL(string: thumbUrl) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().aspectRatio(contentMode: .fit)
                } else if phase.error != nil {
                    // Stored signed URL expired (or otherwise rejected).
                    // Ask the server for a fresh one; on success the
                    // @State change re-renders with the new URL.
                    Color(.tertiarySystemBackground)
                        .aspectRatio(9/16, contentMode: .fit)
                        .task { await refreshIfNeeded() }
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

    /// Fire one refresh attempt per view lifetime. AsyncImage retries
    /// the load automatically when the URL changes, so once we set
    /// `liveThumbnailUrl` the image either renders or stays placeholder.
    private func refreshIfNeeded() async {
        guard !refreshAttempted, let jobId = jobId else { return }
        refreshAttempted = true
        guard let fresh = await APIService.shared.refreshUrls(jobId: jobId) else { return }
        await MainActor.run {
            if let v = fresh.videoUrl { liveVideoUrl = v }
            if let t = fresh.thumbnailUrl { liveThumbnailUrl = t }
        }
    }

    /// Synchronous-from-the-call-site refresh helper used by the play
    /// button. Returns the freshly-signed video URL (or nil on failure)
    /// so VideoPlayerPresenter can present immediately with the new URL.
    private func refreshAndReturnVideoUrl() async -> String? {
        guard let jobId = jobId else { return nil }
        guard let fresh = await APIService.shared.refreshUrls(jobId: jobId) else { return nil }
        await MainActor.run {
            if let v = fresh.videoUrl { liveVideoUrl = v }
            if let t = fresh.thumbnailUrl { liveThumbnailUrl = t }
        }
        return fresh.videoUrl
    }
}

// MARK: - Video Player Presenter
//
// Presents the custom Promptly player (PromptlyPlayerHostVC). Path
// selection (cache hit / CDN streaming / download-then-play) and SigV4
// refresh logic live here; the actual playback chrome lives in
// PromptlyVideoPlayer.swift.

/// Full-screen loader shown while downloading a video on a cache miss.
/// Black backdrop, centered spinner, "Preparing video..." subtitle,
/// top-left X to cancel. Same modal style as the player so the
/// transition from loader → player feels like the same surface.
final class VideoLoaderVC: UIViewController {
    private let spinner = UIActivityIndicatorView(style: .large)
    private let label = UILabel()
    private let cancelButton = UIButton(type: .system)
    var onCancel: (() -> Void)?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        spinner.color = .white
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        view.addSubview(spinner)

        label.text = "Preparing video..."
        label.textColor = UIColor.white.withAlphaComponent(0.7)
        label.font = .systemFont(ofSize: 14, weight: .medium)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)

        let cfg = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        cancelButton.setImage(UIImage(systemName: "xmark", withConfiguration: cfg), for: .normal)
        cancelButton.tintColor = .white
        cancelButton.backgroundColor = UIColor.white.withAlphaComponent(0.15)
        cancelButton.layer.cornerRadius = 18
        cancelButton.layer.cornerCurve = .continuous
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.addTarget(self, action: #selector(handleCancel), for: .touchUpInside)
        cancelButton.accessibilityLabel = "Cancel"
        view.addSubview(cancelButton)

        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),

            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 16),

            cancelButton.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
            cancelButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            cancelButton.widthAnchor.constraint(equalToConstant: 36),
            cancelButton.heightAnchor.constraint(equalToConstant: 36),
        ])
    }

    @objc private func handleCancel() {
        onCancel?()
        dismiss(animated: true)
    }
}

enum VideoPlayerPresenter {
    /// Present the player. When `jobId` is provided, the local cache is
    /// checked first — if the video is on disk, AVPlayer plays from
    /// `file://` and the result feels exactly like Apple Photos
    /// (instant, no buffering, no stalls).
    /// On cache miss, we present a loader and download the full file
    /// before playback so the player ALWAYS reads from disk. Streaming
    /// over a signed URL was producing constant mid-playback freezes
    /// even on healthy Wi-Fi (AVPlayer's automaticallyWaitsToMinimizeStalling
    /// rebuffers every time bandwidth dips), and the user's expectation
    /// is "should play even with no internet" — only local files
    /// satisfy that.
    /// Optional `onRefreshNeeded` is called when the URL fails a
    /// pre-flight HEAD check (or AVPlayer reports a 403/expired error
    /// during load) so the caller can return a freshly-signed URL and
    /// we present with that instead.
    @MainActor
    static func present(
        urlString: String,
        jobId: String? = nil,
        title: String? = nil,
        onReedit: (() -> Void)? = nil,
        onRefreshNeeded: (() async -> String?)? = nil
    ) {
        print("[player] present url=\(urlString) jobId=\(jobId ?? "-")")
        guard URL(string: urlString) != nil else {
            print("[player] FAILED: invalid URL")
            return
        }

        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)

        // Cache hit → straight to file:// playback. No HEAD, no refresh.
        if let jobId, let local = VideoCache.shared.localUrl(forJobId: jobId) {
            print("[player] cache HIT for \(jobId)")
            doPresent(urlString: local.absoluteString, title: title, onReedit: onReedit)
            // Background prefetch is a no-op since this jobId is already
            // cached; nothing more to do.
            return
        }

        // CDN-backed URLs stream directly. AVPlayer + CloudFront edge =
        // first frame in 1-2s, no rebuffering. Same engine that
        // Loom / Runway / Twitch / iMessage use. Background download
        // still runs so subsequent watches are local-instant.
        if isStreamingReadyUrl(urlString) {
            print("[player] streaming directly from CDN: \(urlString)")
            if let jobId {
                Task.detached(priority: .background) {
                    await VideoCache.shared.downloadIfNeeded(jobId: jobId, from: urlString)
                }
            }
            Task { @MainActor in
                let resolvedUrl = await preflightOrRefresh(
                    urlString: urlString,
                    onRefreshNeeded: onRefreshNeeded
                )
                doPresent(urlString: resolvedUrl, title: title, onReedit: onReedit)
            }
            return
        }

        // Legacy non-CDN cache miss. Without an edge cache, raw S3
        // streaming rebuffered constantly — fall back to the
        // download-then-play loader so playback is at least smooth.
        if let jobId {
            presentWithDownload(
                jobId: jobId,
                urlString: urlString,
                title: title,
                onReedit: onReedit,
                onRefreshNeeded: onRefreshNeeded
            )
        } else {
            Task { @MainActor in
                let resolvedUrl = await preflightOrRefresh(
                    urlString: urlString,
                    onRefreshNeeded: onRefreshNeeded
                )
                doPresent(urlString: resolvedUrl, title: title, onReedit: onReedit)
            }
        }
    }

    /// Cache-miss flow: present a loader, resolve the URL (refreshing
    /// the SigV4 signature if needed), download to disk with userInitiated
    /// priority, then transition to the player from the local file. On
    /// download failure or user cancel, the loader dismisses. On a
    /// hard timeout (90s) we fall back to streaming as a last resort
    /// so the user doesn't get stuck staring at a spinner.
    @MainActor
    private static func presentWithDownload(
        jobId: String,
        urlString: String,
        title: String?,
        onReedit: (() -> Void)?,
        onRefreshNeeded: (() async -> String?)?
    ) {
        guard let topVC = topmostViewController() else { return }

        let loader = VideoLoaderVC()
        loader.modalPresentationStyle = .fullScreen
        var cancelled = false
        loader.onCancel = { cancelled = true }
        topVC.present(loader, animated: true)

        Task { @MainActor in
            let resolvedUrl = await preflightOrRefresh(
                urlString: urlString,
                onRefreshNeeded: onRefreshNeeded
            )
            if cancelled { return }

            // Race the download against a 90s hard timeout — if the
            // network is genuinely too slow to deliver the file in
            // 90s, we'd rather try streaming than leave the user
            // staring at a spinner indefinitely.
            let result: URL? = await withTaskGroup(of: URL?.self) { group in
                group.addTask {
                    await VideoCache.shared.downloadIfNeeded(
                        jobId: jobId,
                        from: resolvedUrl,
                        priority: .userInitiated
                    )
                }
                group.addTask {
                    try? await Task.sleep(for: .seconds(90))
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }

            if cancelled { return }

            // Dismiss loader without animation, then immediately hand off
            // to the player so the visible transition feels like a swap.
            loader.dismiss(animated: false) {
                if let local = result {
                    doPresent(urlString: local.absoluteString, title: title, onReedit: onReedit)
                } else {
                    // Download didn't land in time — try streaming as a
                    // fallback so SOMETHING happens. AVPlayer will surface
                    // its own error UI if even that fails.
                    print("[player] download timed out, falling back to streaming")
                    doPresent(urlString: resolvedUrl, title: title, onReedit: onReedit)
                }
            }
        }
    }

    @MainActor
    private static func doPresent(urlString: String, title: String?, onReedit: (() -> Void)?) {
        guard let url = URL(string: urlString) else {
            print("[player] FAILED: invalid URL after refresh")
            return
        }
        // Custom Promptly player. Drops AVPlayerViewController so the
        // chrome is intentional — branded glass overlay, frame-strip
        // scrubber, speed pill, loop, re-edit pill, swipe-to-dismiss.
        // The pre-warmed AVPlayerItem (loaded when the thumbnail came
        // on screen) is handed to the player here for sub-100ms
        // first-frame paint.
        let item = PlayerAssetPrewarm.shared.takePlayerItem(for: urlString)
            ?? AVPlayerItem(url: url)
        let session = PromptlyPlayerSession(item: item, urlString: urlString)
        let host = PromptlyPlayerHostVC(session: session, title: title, onReedit: onReedit)

        guard let topVC = topmostViewController() else {
            print("[player] FAILED: no topmost view controller")
            return
        }
        topVC.present(host, animated: true)
    }

    /// HEAD the URL with a tight 5s timeout. On any 4xx response (or a
    /// network error), try the refresh callback and return whatever it
    /// gives us. If refresh isn't provided or also fails, falls back to
    /// the original URL — the player will surface its own error UI.
    private static func preflightOrRefresh(
        urlString: String,
        onRefreshNeeded: (() async -> String?)?
    ) async -> String {
        guard let url = URL(string: urlString) else { return urlString }
        var req = URLRequest(url: url)
        req.httpMethod = "HEAD"
        req.timeoutInterval = 5
        do {
            let (_, resp) = try await URLSession.shared.data(for: req)
            if let http = resp as? HTTPURLResponse, (200..<400).contains(http.statusCode) {
                return urlString
            }
            print("[player] preflight \( (resp as? HTTPURLResponse)?.statusCode ?? -1) — refreshing")
        } catch {
            print("[player] preflight network error — refreshing: \(error.localizedDescription)")
        }
        if let refresh = onRefreshNeeded, let fresh = await refresh() {
            print("[player] refreshed url")
            return fresh
        }
        // No refresh available — fall back to original URL. Player will
        // surface its own native error chrome rather than us showing
        // nothing.
        return urlString
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
