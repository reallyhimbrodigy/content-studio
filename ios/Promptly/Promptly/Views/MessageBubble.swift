import SwiftUI
import AVKit
import Photos

#if canImport(TikTokOpenShareSDK)
import TikTokOpenShareSDK
#endif

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
                CompletedVideoView(
                    videoUrlStr: videoUrlStr,
                    thumbnailUrlStr: message.thumbnailUrl,
                    onReedit: buildReeditHandler(for: message)
                )
            }

            if message.jobStatus == "failed" || message.jobStatus == "error" {
                Text(message.error ?? "Something went wrong.")
                    .font(.system(size: 14))
                    .foregroundColor(.red)
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

// MARK: - Video Exporter (Save to Photos + TikTok + Instagram)
//
// One VideoExporter per completed video message (via @StateObject on the
// VideoActionRow). Manages:
//   - Single download of the remote MP4 to a temp file (cached for the
//     session so re-taps don't re-download).
//   - Single save to Photos (cached PHAsset localIdentifier so repeated
//     TikTok/Instagram shares reuse the same asset).
//   - Per-action state machines (idle / loading / success / error) so each
//     button can animate independently.
//
// TikTok path: if TikTokOpenShareSDK is linked, uses TikTokShareRequest to
// hand off directly to TikTok's upload composer. Without the SDK the code
// falls back to opening TikTok via URL scheme (still useful — the video
// is pre-saved in Photos so the user just taps + in TikTok).
//
// Instagram path: uses URL schemes officially documented by Meta. There is
// no Instagram SDK for third-party share on iOS — URL schemes + pasteboard
// IS the production approach (same method used by Canva, Adobe Express,
// etc.). Feed/Reel flow is instagram://library?LocalIdentifier=... and
// drops the user into Instagram's media picker with the asset preselected.

@MainActor
final class VideoExporter: ObservableObject {
    let videoUrlStr: String
    let thumbnailUrlStr: String?

    @Published var saveState: ActionState = .idle
    @Published var tiktokState: ActionState = .idle
    @Published var instagramState: ActionState = .idle

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

    func shareToTikTok() {
        Task {
            tiktokState = .loading
            do {
                let assetId = try await ensureSavedToPhotos()

                #if canImport(TikTokOpenShareSDK)
                // Production SDK path — direct-to-composer handoff.
                let request = TikTokShareRequest(
                    localIdentifiers: [assetId],
                    mediaType: .video,
                    redirectURI: "app.usepromptly.ios://tiktok-share-callback"
                )
                _ = request.send { _ in }
                tiktokState = .success
                #else
                // SDK not linked — fall back to opening TikTok app. The video is
                // already saved to Photos above, so the user just has to tap +
                // once inside TikTok and pick the fresh clip from their library.
                guard let url = URL(string: "snssdk1233://") else {
                    throw ExportError.invalidUrl
                }
                if await UIApplication.shared.canOpenURL(url) {
                    await UIApplication.shared.open(url)
                    tiktokState = .success
                } else if let storeUrl = URL(string: "https://apps.apple.com/app/id835599320") {
                    await UIApplication.shared.open(storeUrl)
                    throw ExportError.appNotInstalled("TikTok")
                }
                #endif

                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if tiktokState == .success { tiktokState = .idle }
                _ = assetId  // keep capture live
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                tiktokState = .error(error.localizedDescription)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if case .error = tiktokState { tiktokState = .idle }
            }
        }
    }

    func shareToInstagram() {
        Task {
            instagramState = .loading
            do {
                let assetId = try await ensureSavedToPhotos()
                // Instagram's library deep link opens its picker with the
                // specific video preselected — user picks Feed / Reel / Story.
                guard let url = URL(string: "instagram://library?LocalIdentifier=\(assetId)") else {
                    throw ExportError.invalidUrl
                }
                if await UIApplication.shared.canOpenURL(url) {
                    await UIApplication.shared.open(url)
                    instagramState = .success
                } else if let storeUrl = URL(string: "https://apps.apple.com/app/id389801252") {
                    await UIApplication.shared.open(storeUrl)
                    throw ExportError.appNotInstalled("Instagram")
                }

                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if instagramState == .success { instagramState = .idle }
            } catch {
                UINotificationFeedbackGenerator().notificationOccurred(.error)
                instagramState = .error(error.localizedDescription)
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if case .error = instagramState { instagramState = .idle }
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

    // Brand gradients — pulled from Instagram + TikTok brand kits
    private static let instagramGradient = LinearGradient(
        colors: [
            Color(red: 0.996, green: 0.855, blue: 0.459),  // #FEDA75
            Color(red: 0.980, green: 0.494, blue: 0.118),  // #FA7E1E
            Color(red: 0.839, green: 0.161, blue: 0.463),  // #D62976
            Color(red: 0.588, green: 0.184, blue: 0.749),  // #962FBF
            Color(red: 0.310, green: 0.357, blue: 0.835)   // #4F5BD5
        ],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    private static let tiktokBlack = Color.black
    private static let tiktokAccent = Color(red: 0.996, green: 0.173, blue: 0.333)  // #FE2C55

    var body: some View {
        HStack(spacing: 14) {
            if let onReedit {
                pill(
                    icon: "wand.and.stars",
                    label: "Re-edit",
                    state: .idle,
                    fill: .neutral,
                    action: onReedit
                )
            }

            pill(
                icon: "square.and.arrow.down",
                label: "Save",
                state: exporter.saveState,
                fill: .neutral,
                action: exporter.save
            )

            pill(
                icon: "music.note",
                label: "TikTok",
                state: exporter.tiktokState,
                fill: .tiktok,
                action: exporter.shareToTikTok
            )

            pill(
                icon: "camera",
                label: "Instagram",
                state: exporter.instagramState,
                fill: .instagram,
                action: exporter.shareToInstagram
            )

            shareLinkPill

            Spacer(minLength: 0)
        }
        .padding(.top, 8)
    }

    // MARK: - Pill subviews

    private enum PillFill {
        case neutral
        case tiktok
        case instagram
    }

    @ViewBuilder
    private func pill(
        icon: String,
        label: String,
        state: VideoExporter.ActionState,
        fill: PillFill,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        }) {
            VStack(spacing: 6) {
                ZStack {
                    pillBackground(fill: fill)
                    pillSymbol(icon: icon, state: state, fill: fill)
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
    }

    @ViewBuilder
    private func pillBackground(fill: PillFill) -> some View {
        switch fill {
        case .neutral:
            Circle().fill(Color(.tertiarySystemBackground))
        case .tiktok:
            Circle().fill(Self.tiktokBlack)
        case .instagram:
            Circle().fill(Self.instagramGradient)
        }
    }

    @ViewBuilder
    private func pillSymbol(
        icon: String,
        state: VideoExporter.ActionState,
        fill: PillFill
    ) -> some View {
        let color: Color = fill == .neutral ? .white : .white
        switch state {
        case .idle:
            Image(systemName: icon)
                .font(.system(size: 18, weight: .medium))
                .foregroundColor(color)
                .symbolRenderingMode(.hierarchical)
        case .loading:
            ProgressView()
                .controlSize(.small)
                .tint(color)
        case .success:
            Image(systemName: "checkmark")
                .font(.system(size: 18, weight: .bold))
                .foregroundColor(color)
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
                        }
                    Text("Share")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(Color(.secondaryLabel))
                }
            }
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
    let onReedit: (() -> Void)?

    @State private var fallbackThumb: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
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

            VideoActionRow(
                videoUrlStr: videoUrlStr,
                thumbnailUrlStr: thumbnailUrlStr,
                onReedit: onReedit
            )
        }
    }

    @ViewBuilder
    private var thumbnailContent: some View {
        if let thumbUrl = thumbnailUrlStr, let url = URL(string: thumbUrl) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().aspectRatio(contentMode: .fit)
                } else if phase.error != nil {
                    // Server thumbnail URL failed (CDN miss, expired, deleted) —
                    // fall back to grabbing a frame from the rendered video URL
                    // and cache it on this view's lifetime.
                    fallbackThumbView
                } else {
                    Color(.tertiarySystemBackground)
                        .aspectRatio(9/16, contentMode: .fit)
                }
            }
        } else {
            // No thumbnail URL was ever set (server didn't deliver one in
            // the SSE complete event, or the message was restored from a
            // pre-thumbnail-era chat). Generate from the video file.
            fallbackThumbView
        }
    }

    @ViewBuilder
    private var fallbackThumbView: some View {
        if let img = fallbackThumb {
            Image(uiImage: img).resizable().aspectRatio(contentMode: .fit)
        } else {
            Color(.tertiarySystemBackground)
                .aspectRatio(9/16, contentMode: .fit)
                .task(id: videoUrlStr) {
                    guard fallbackThumb == nil,
                          let url = URL(string: videoUrlStr) else { return }
                    if let img = await ThumbnailGenerator.generate(from: url) {
                        await MainActor.run { fallbackThumb = img }
                    }
                }
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

/// AVPlayerViewController subclass that owns the diagnostic observers
/// and tears them down on dismiss. The earlier static-dict approach
/// leaked: every video play stacked four NotificationCenter
/// observers + one KVO that never got cleaned up. After many plays
/// memory + main-thread observer dispatch piled up, which manifested
/// as choppy or stuck playback — the regression the user noticed.
final class PromptlyPlayerVC: AVPlayerViewController {
    private var statusKVO: NSKeyValueObservation?
    private var notificationTokens: [NSObjectProtocol] = []

    func attachDiagnostics(item: AVPlayerItem) {
        statusKVO = item.observe(\.status, options: [.new, .initial]) { item, _ in
            switch item.status {
            case .readyToPlay:
                print("[player] readyToPlay")
            case .failed:
                let err = item.error?.localizedDescription ?? "unknown"
                let underlying = (item.error as NSError?)?.userInfo[NSUnderlyingErrorKey] as? NSError
                let code = (item.error as NSError?)?.code ?? 0
                print("[player] FAILED code=\(code) error=\(err) underlying=\(underlying?.localizedDescription ?? "none")")
            case .unknown:
                print("[player] status=unknown (still loading)")
            @unknown default:
                break
            }
        }
        notificationTokens.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemPlaybackStalled, object: item, queue: .main
        ) { _ in
            print("[player] stalled")
        })
        notificationTokens.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemNewErrorLogEntry, object: item, queue: .main
        ) { _ in
            if let log = item.errorLog(), let last = log.events.last {
                print("[player] errorLog code=\(last.errorStatusCode) domain=\(last.errorDomain) comment=\(last.errorComment ?? "")")
            }
        })
        notificationTokens.append(NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime, object: item, queue: .main
        ) { note in
            let err = note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            print("[player] failedToPlayToEnd error=\(err?.localizedDescription ?? "unknown")")
        })
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        player?.pause()
    }

    deinit {
        statusKVO?.invalidate()
        notificationTokens.forEach { NotificationCenter.default.removeObserver($0) }
    }
}

enum VideoPlayerPresenter {
    @MainActor
    static func present(urlString: String) {
        print("[player] present url=\(urlString)")
        guard let url = URL(string: urlString) else {
            print("[player] FAILED: invalid URL")
            return
        }

        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)

        let item = AVPlayerItem(url: url)
        item.preferredForwardBufferDuration = 10

        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        player.actionAtItemEnd = .pause

        let playerVC = PromptlyPlayerVC()
        playerVC.player = player
        playerVC.allowsPictureInPicturePlayback = true
        playerVC.videoGravity = .resizeAspect
        playerVC.entersFullScreenWhenPlaybackBegins = false
        playerVC.modalPresentationStyle = .overFullScreen
        playerVC.modalTransitionStyle = .crossDissolve
        playerVC.attachDiagnostics(item: item)

        guard let topVC = topmostViewController() else {
            print("[player] FAILED: no topmost view controller")
            return
        }
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
