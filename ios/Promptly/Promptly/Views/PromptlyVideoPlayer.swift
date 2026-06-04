import SwiftUI
import AVKit
import AVFoundation
import UIKit
import Combine

// MARK: - Pre-warm cache
//
// AVPlayer's "freeze before play" is asset metadata loading on the main
// thread. We pre-load tracks/duration off-thread the moment the message
// thumbnail comes on screen, then hand the ready item directly to the
// player at present time. Net: first-frame paint goes from 300-800 ms
// (cold metadata read) down to <100 ms.

@MainActor
final class PlayerAssetPrewarm {
    static let shared = PlayerAssetPrewarm()

    private var items: [String: AVPlayerItem] = [:]
    private var inFlight: Set<String> = []

    /// Begin loading the asset for `urlString`. Idempotent — repeat calls
    /// while in flight or already cached are no-ops.
    ///
    /// Two paths:
    ///   - MP4 / file:// — async-load tracks/duration off-thread so the
    ///     metadata read happens before the user taps. Saves the cold
    ///     300-800 ms moov-atom load.
    ///   - HLS (.m3u8) — DO NOT call `asset.load(.tracks)`. That API
    ///     is malformed for HLS master playlists; it can hang and the
    ///     resulting AVPlayerItem ends up in a broken state. AVPlayer
    ///     handles HLS manifest parsing internally on play(), and the
    ///     first segment is small enough (~300 KB) that pre-warming
    ///     doesn't move the needle. We just create the AVPlayerItem
    ///     here so takePlayerItem can hand it off without re-creating.
    func warm(_ urlString: String) {
        guard items[urlString] == nil, !inFlight.contains(urlString),
              let url = URL(string: urlString) else { return }

        if urlString.contains(".m3u8") {
            let asset = AVURLAsset(url: url)
            let item = AVPlayerItem(asset: asset)
            items[urlString] = item
            return
        }

        inFlight.insert(urlString)
        let asset = AVURLAsset(url: url)
        Task.detached(priority: .userInitiated) {
            _ = try? await asset.load(.tracks, .duration, .preferredTransform)
            await MainActor.run {
                let item = AVPlayerItem(asset: asset)
                self.items[urlString] = item
                self.inFlight.remove(urlString)
            }
        }
    }

    /// Hand off the cached item — or freshly create one if there's no warm
    /// hit. AVPlayerItem can only be in ONE player at a time, so we remove
    /// from the cache on take. Buffer settings are LEFT AT DEFAULTS so
    /// AVPlayer's adaptive logic can pick the right amount of look-ahead
    /// for the network conditions.
    func takePlayerItem(for urlString: String) -> AVPlayerItem? {
        if let cached = items.removeValue(forKey: urlString) {
            return cached
        }
        guard let url = URL(string: urlString) else { return nil }
        let asset = AVURLAsset(url: url)
        return AVPlayerItem(asset: asset)
    }
}

// MARK: - Frame strip cache
//
// AVAssetImageGenerator extracts ~24 thumbnails sampled across the full
// duration. Memo'd per URL so re-opening the player is instant.
//
// HLS URLs are skipped — the segment-based format makes per-frame
// extraction unreliable and we don't want to fall back to a slower
// scrubber on streaming videos.

@MainActor
final class FrameStripCache {
    static let shared = FrameStripCache()
    private var strips: [String: [UIImage]] = [:]
    private var inFlight: [String: Task<[UIImage], Never>] = [:]

    func strip(for urlString: String, asset: AVAsset, count: Int = 24) async -> [UIImage] {
        if let cached = strips[urlString] { return cached }
        if let task = inFlight[urlString] { return await task.value }
        let task = Task<[UIImage], Never> {
            let images = await Self.generate(asset: asset, count: count)
            await MainActor.run {
                self.strips[urlString] = images
                self.inFlight.removeValue(forKey: urlString)
            }
            return images
        }
        inFlight[urlString] = task
        return await task.value
    }

    private static func generate(asset: AVAsset, count: Int) async -> [UIImage] {
        guard let duration = try? await asset.load(.duration), duration.seconds > 0 else { return [] }
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 80, height: 0)
        gen.requestedTimeToleranceBefore = .zero
        gen.requestedTimeToleranceAfter = .zero

        let totalSeconds = duration.seconds
        let stamps: [CMTime] = (0..<count).map { i in
            let t = totalSeconds * Double(i) / Double(max(count - 1, 1))
            return CMTime(seconds: t, preferredTimescale: 600)
        }

        return await withCheckedContinuation { continuation in
            var collected: [(Double, UIImage)] = []
            var done = 0
            let lock = NSLock()
            let total = stamps.count
            gen.generateCGImagesAsynchronously(forTimes: stamps.map { NSValue(time: $0) }) { requested, cgImage, _, result, _ in
                lock.lock()
                done += 1
                if let cgImage, result == .succeeded {
                    collected.append((requested.seconds, UIImage(cgImage: cgImage)))
                }
                let isFinished = done == total
                lock.unlock()
                if isFinished {
                    let sorted = collected.sorted { $0.0 < $1.0 }.map { $0.1 }
                    continuation.resume(returning: sorted)
                }
            }
        }
    }
}

// MARK: - Audio session helper
//
// AVPlayer audio routing depends on the AVAudioSession being in `.playback`
// category and ACTIVE. The previous flow used `try?` everywhere and silently
// swallowed errors — if a prior session left things in a bad state, audio
// would go missing on the next play with no log line. This wrapper logs
// every error and is idempotent on the happy path.

@MainActor
enum AudioSession {
    static func activatePlayback() {
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playback, mode: .moviePlayback, options: [])
        } catch {
            print("[audio-session] setCategory failed: \(error.localizedDescription)")
        }
        do {
            try s.setActive(true, options: [])
        } catch {
            print("[audio-session] setActive(true) failed: \(error.localizedDescription)")
        }
    }

    static func deactivate() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        } catch {
            // Common when other audio is being held — fine to ignore visibly.
            print("[audio-session] setActive(false) failed: \(error.localizedDescription)")
        }
    }
}

// MARK: - Player pool
//
// Three pre-warmed AVPlayer instances kept alive for the entire app
// session. Industry standard for short-form video (TikTok / Reels /
// CapCut). The only purpose is to avoid the ~50-150 ms cold-init cost
// on every tap. Every other setting is AVPlayer's default — we don't
// override stall avoidance, buffer duration, or end action because
// those defaults are what production apps use.

@MainActor
final class PlayerPool {
    static let shared = PlayerPool()
    private var pool: [AVPlayer] = []
    private let capacity = 3

    private init() {
        for _ in 0..<capacity {
            pool.append(AVPlayer())
        }
    }

    func acquire() -> AVPlayer {
        AudioSession.activatePlayback()
        if pool.isEmpty { return AVPlayer() }
        return pool.removeFirst()
    }

    func release(_ p: AVPlayer) {
        p.pause()
        p.replaceCurrentItem(with: nil)
        if pool.count < capacity { pool.append(p) }
    }
}

// MARK: - AVPlayerLayer wrapped for SwiftUI
//
// Forwards the layer's `isReadyForDisplay` signal up to SwiftUI so we
// know exactly when the first frame is decoded and ready to paint —
// that's the moment we crossfade the poster image out.

struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer
    let onReadyForDisplay: () -> Void

    func makeUIView(context: Context) -> _PlayerLayerHostView {
        let v = _PlayerLayerHostView()
        v.playerLayer.player = player
        v.playerLayer.videoGravity = .resizeAspect
        v.backgroundColor = .black
        v.onReadyForDisplay = onReadyForDisplay
        v.bindReadyObservation()
        return v
    }

    func updateUIView(_ uiView: _PlayerLayerHostView, context: Context) {
        if uiView.playerLayer.player !== player {
            uiView.playerLayer.player = player
            uiView.bindReadyObservation()
        }
    }

    final class _PlayerLayerHostView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
        var onReadyForDisplay: (() -> Void)?
        private var readyObservation: NSKeyValueObservation?

        func bindReadyObservation() {
            readyObservation?.invalidate()
            // Already painting? Fire immediately so the poster can fade
            // even if the layer was ready before SwiftUI mounted.
            if playerLayer.isReadyForDisplay {
                onReadyForDisplay?()
                return
            }
            readyObservation = playerLayer.observe(\.isReadyForDisplay, options: [.new]) { [weak self] _, change in
                if change.newValue == true {
                    DispatchQueue.main.async { self?.onReadyForDisplay?() }
                }
            }
        }

        deinit {
            readyObservation?.invalidate()
        }
    }
}

// MARK: - Player session
//
// Owns the per-presentation state — the AVPlayerItem, observers, and
// scrubber/UI bindings. Acquires an AVPlayer from PlayerPool on init,
// returns it on deinit so the pool stays warm across plays.

@MainActor
final class PromptlyPlayerSession: ObservableObject {
    let player: AVPlayer
    let urlString: String

    @Published var isPlaying: Bool = false
    @Published var currentTime: Double = 0
    @Published var duration: Double = 0
    @Published var isScrubbing: Bool = false
    @Published var isBuffering: Bool = false
    @Published private(set) var frameStrip: [UIImage] = []

    private let item: AVPlayerItem
    private var timeObserver: Any?
    private var statusKVO: NSKeyValueObservation?
    private var timeControlKVO: NSKeyValueObservation?
    private var bufferingShowTask: Task<Void, Never>?
    private var endNotificationToken: NSObjectProtocol?

    init(item: AVPlayerItem, urlString: String) {
        self.item = item
        self.player = PlayerPool.shared.acquire()
        self.urlString = urlString

        player.replaceCurrentItem(with: item)

        // 1 Hz time observer — enough to update the time labels and the
        // scrubber thumb without saturating SwiftUI with @Published
        // updates. The thumb is interpolated visually between ticks via
        // SwiftUI's implicit animation on the progress value.
        let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
        self.timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            guard let self, !self.isScrubbing else { return }
            self.currentTime = time.seconds
        }

        statusKVO = item.observe(\.status, options: [.new, .initial]) { [weak self] item, _ in
            Task { @MainActor in
                guard let self else { return }
                if item.status == .readyToPlay {
                    let d = item.duration.seconds
                    if d.isFinite, d > 0 { self.duration = d }
                    self.player.play()
                    self.isPlaying = true
                }
            }
        }

        // Buffering signal. timeControlStatus is the cleanest source: it
        // tells us whether the player is .playing, .paused, or
        // .waitingToPlayAtSpecifiedRate (stalled). Show a spinner only
        // when the player WANTS to be playing but is waiting — and
        // debounce by 250ms so micro-stalls (decoder catch-ups, rebuffer
        // ticks shorter than a frame) don't flash the spinner. Hide
        // immediately when playback resumes — Netflix / YouTube-style.
        timeControlKVO = player.observe(\.timeControlStatus, options: [.new, .initial]) { [weak self] player, _ in
            Task { @MainActor in
                guard let self else { return }
                switch player.timeControlStatus {
                case .waitingToPlayAtSpecifiedRate:
                    self.bufferingShowTask?.cancel()
                    self.bufferingShowTask = Task { @MainActor [weak self] in
                        try? await Task.sleep(for: .milliseconds(250))
                        guard let self, !Task.isCancelled else { return }
                        if self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate {
                            self.isBuffering = true
                        }
                    }
                case .playing, .paused:
                    self.bufferingShowTask?.cancel()
                    self.bufferingShowTask = nil
                    if self.isBuffering { self.isBuffering = false }
                @unknown default:
                    break
                }
            }
        }

        // Default `actionAtItemEnd = .pause` stops at the end frame. We
        // loop manually by seeking to zero and resuming when the
        // didPlayToEndTime notification fires — short clips, always loop.
        endNotificationToken = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                self.player.seek(to: .zero)
                self.player.play()
                self.isPlaying = true
            }
        }

        // Frame strip generation off-thread. AVAssetImageGenerator on
        // a progressive MP4 with dense keyframes (server emits one per
        // second) populates the strip within a few hundred ms.
        Task { [weak self] in
            guard let self else { return }
            let images = await FrameStripCache.shared.strip(for: urlString, asset: item.asset)
            await MainActor.run { self.frameStrip = images }
        }
    }

    func togglePlay() { isPlaying ? pause() : play() }

    func play() {
        player.play()
        isPlaying = true
    }

    func pause() {
        player.pause()
        isPlaying = false
    }

    /// Update the on-screen time during scrubber drag. We don't seek
    /// the AVPlayer during the drag — that thrashes the decoder. The
    /// frame strip is the visual preview; on release, we do ONE seek.
    func liveSeek(to seconds: Double) {
        guard duration > 0 else { return }
        currentTime = max(0, min(seconds, duration))
    }

    /// Single seek on scrubber release. Frame-accurate (zero tolerance).
    func finalSeek(to seconds: Double) {
        guard duration > 0 else { return }
        let t = CMTime(seconds: max(0, min(seconds, duration)), preferredTimescale: 600)
        currentTime = t.seconds
        player.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero)
    }

    deinit {
        if let t = timeObserver { player.removeTimeObserver(t) }
        statusKVO?.invalidate()
        timeControlKVO?.invalidate()
        bufferingShowTask?.cancel()
        if let token = endNotificationToken { NotificationCenter.default.removeObserver(token) }
        let p = player
        Task { @MainActor in PlayerPool.shared.release(p) }
    }
}

// MARK: - Player view (the surface the user sees)

struct PromptlyPlayerView: View {
    @ObservedObject var session: PromptlyPlayerSession
    let onClose: () -> Void
    let onReedit: (() -> Void)?
    let title: String?
    let posterUrl: String?

    @State private var showControls: Bool = true
    @State private var hideTask: Task<Void, Never>?
    @State private var dismissOffset: CGFloat = 0
    @State private var firstFrameReady: Bool = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Unlock ProMotion 120Hz refresh while the player is mounted.
            ProMotionFrameRateRequest()
                .frame(width: 0, height: 0)
                .allowsHitTesting(false)

            // Poster — instant first paint surface. Sits BEHIND the
            // video layer and fades out when the AVPlayerLayer reports
            // its first frame is ready to display. This is the trick
            // that makes the player feel instant: the user never sees
            // a black flash between tap and video start, even though
            // AVPlayer is technically still warming up underneath.
            if !firstFrameReady, let posterUrl, let url = URL(string: posterUrl) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        image
                            .resizable()
                            .aspectRatio(contentMode: .fit)
                            .ignoresSafeArea()
                    default:
                        Color.black
                    }
                }
                .transition(.opacity)
            }

            // Video. Tap toggles controls; drag-down rubber-bands and dismisses.
            PlayerLayerView(player: session.player) {
                withAnimation(.easeOut(duration: 0.18)) {
                    firstFrameReady = true
                }
            }
            .ignoresSafeArea()
            .opacity(firstFrameReady ? 1 : 0)
            .contentShape(Rectangle())
            .onTapGesture { toggleControls() }
            .scaleEffect(1 - min(abs(dismissOffset) / 1500, 0.15), anchor: .center)
            .offset(y: dismissOffset)
            .gesture(swipeDownDismiss)

            // Subtle vignette during fullscreen playback (controls hidden).
            // Pulls focus toward subject without muddying the picture.
            if session.isPlaying && !showControls && firstFrameReady {
                LinearGradient(
                    colors: [.black.opacity(0.04), .clear, .clear, .black.opacity(0.18)],
                    startPoint: .top, endPoint: .bottom
                )
                .ignoresSafeArea()
                .allowsHitTesting(false)
                .transition(.opacity)
            }

            if showControls {
                ControlOverlay(
                    session: session,
                    title: title,
                    onClose: animateClose,
                    onReedit: onReedit,
                    onScrubChanged: { resetHide() }
                )
                .transition(.opacity)
            }

            // Buffering spinner — appears center-screen any time the
            // player is waiting on data while it WANTS to be playing.
            // Sits above the control overlay so it doesn't get blocked
            // by the center play/pause hit area, and fades cleanly.
            // 250ms debounce in the session means we never flash on
            // sub-frame stalls — only real rebuffer events surface.
            if session.isBuffering && firstFrameReady {
                BufferingSpinner()
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: session.isBuffering)
        .preferredColorScheme(.dark)
        .statusBarHidden(true)
        .persistentSystemOverlays(.hidden)
        .onAppear {
            session.play()
            scheduleHide()
        }
        .onDisappear {
            hideTask?.cancel()
            session.pause()
        }
    }

    private func toggleControls() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
            showControls.toggle()
        }
        if showControls {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            scheduleHide()
        }
    }

    private func resetHide() {
        hideTask?.cancel()
        scheduleHide()
    }

    private func scheduleHide() {
        hideTask?.cancel()
        hideTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.5))
            if Task.isCancelled || session.isScrubbing { return }
            withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                showControls = false
            }
        }
    }

    private var swipeDownDismiss: some Gesture {
        DragGesture()
            .onChanged { v in
                if v.translation.height > 0 {
                    dismissOffset = v.translation.height
                }
            }
            .onEnded { v in
                if v.translation.height > 120 || v.predictedEndTranslation.height > 220 {
                    animateClose()
                } else {
                    withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                        dismissOffset = 0
                    }
                }
            }
    }

    private func animateClose() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        session.pause()
        onClose()
    }
}

// MARK: - Control overlay (top + center + bottom)

struct ControlOverlay: View {
    @ObservedObject var session: PromptlyPlayerSession
    let title: String?
    let onClose: () -> Void
    let onReedit: (() -> Void)?
    let onScrubChanged: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Spacer(minLength: 0)
            centerPlayPause
                .allowsHitTesting(true)
            Spacer(minLength: 0)
            bottomBar
        }
    }

    @ViewBuilder
    private var topBar: some View {
        HStack(spacing: 12) {
            ControlButton(systemName: "xmark", size: 36) { onClose() }

            if let title = title, !title.isEmpty {
                Text(title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .padding(.leading, 4)
            }

            Spacer()
            // Speed pill and loop toggle removed — short-form chat
            // clips just auto-loop, and speed adjustment belongs in
            // the editor view, not the playback surface. (Veed and
            // captions.ai both do the same.)
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 14)
        .background(
            LinearGradient(colors: [.black.opacity(0.55), .black.opacity(0.0)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
        )
    }

    @ViewBuilder
    private var centerPlayPause: some View {
        Button {
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            session.togglePlay()
        } label: {
            ZStack {
                Circle()
                    .fill(.ultraThinMaterial)
                    .frame(width: 76, height: 76)
                    .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
                Image(systemName: session.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundColor(.white)
                    .contentTransition(.symbolEffect(.replace.byLayer))
                    .offset(x: session.isPlaying ? 0 : 2)  // optical center for play triangle
            }
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private var bottomBar: some View {
        VStack(spacing: 12) {
            FrameStripScrubber(session: session, onChanged: onScrubChanged)

            HStack(spacing: 12) {
                Text(formatTime(session.currentTime))
                    .monospacedDigit()
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Color.white.opacity(0.85))

                Spacer()

                if let onReedit {
                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onReedit()
                        onClose()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "wand.and.stars")
                                .font(.system(size: 12, weight: .semibold))
                            Text("Re-edit")
                                .font(.system(size: 13, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(.ultraThinMaterial, in: Capsule())
                        .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 0.5))
                    }
                    .buttonStyle(.plain)
                }

                Spacer()

                Text("-" + formatTime(max(0, session.duration - session.currentTime)))
                    .monospacedDigit()
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Color.white.opacity(0.85))
            }
            .padding(.horizontal, 4)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(
            LinearGradient(colors: [.black.opacity(0.0), .black.opacity(0.6)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .bottom)
        )
    }

    private func formatTime(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        let s = Int(seconds.rounded())
        let m = s / 60
        let r = s % 60
        return String(format: "%d:%02d", m, r)
    }
}

// MARK: - ProMotion frame-rate request
//
// SwiftUI / Core Animation default to a 60 Hz refresh on ProMotion iPhones
// even when the device supports 120 Hz. Adding a CADisplayLink with an
// explicit `preferredFrameRateRange` of 80-120 forces the compositor to
// 120 Hz while this view is in the hierarchy — making the scrubber thumb,
// fade transitions, and pinch gestures noticeably smoother. The link
// callback is a no-op; the act of having a link with the right range is
// what unlocks the high refresh rate.

struct ProMotionFrameRateRequest: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let v = UIView(frame: .zero)
        v.isUserInteractionEnabled = false
        v.backgroundColor = .clear
        context.coordinator.attach()
        return v
    }
    func updateUIView(_ uiView: UIView, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject {
        private var displayLink: CADisplayLink?

        func attach() {
            let link = CADisplayLink(target: self, selector: #selector(tick))
            link.preferredFrameRateRange = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)
            link.add(to: .main, forMode: .common)
            displayLink = link
        }

        @objc private func tick() { /* no-op; presence is the signal */ }

        deinit {
            displayLink?.invalidate()
        }
    }
}

// MARK: - Frame-strip scrubber
//
// At rest: thin progress line + 11pt thumb.
// Active (touched): expands to a 44pt frame strip with 16pt thumb, like
// Spotify's scrubber growing on touch. Live-seeks the player on every
// drag tick — frame visually follows the thumb.
//
// On HLS streams the frame strip is empty (extraction is unreliable),
// and the scrubber falls back to a thin-line scrubber that still
// supports live-seeking — just without the thumbnail preview.

struct FrameStripScrubber: View {
    @ObservedObject var session: PromptlyPlayerSession
    let onChanged: () -> Void

    @State private var isActive: Bool = false

    var body: some View {
        GeometryReader { geo in
            let width = geo.size.width
            let progress: Double = session.duration > 0
                ? min(1, max(0, session.currentTime / session.duration))
                : 0
            let thumbX = CGFloat(progress) * width
            let thumbSize: CGFloat = isActive ? 16 : 11
            let hasFrameStrip = !session.frameStrip.isEmpty
            let trackHeight: CGFloat = (isActive && hasFrameStrip) ? 44 : 14

            ZStack(alignment: .leading) {
                if isActive && hasFrameStrip {
                    HStack(spacing: 1) {
                        ForEach(Array(session.frameStrip.enumerated()), id: \.offset) { _, img in
                            Image(uiImage: img)
                                .resizable()
                                .aspectRatio(contentMode: .fill)
                                .frame(maxWidth: .infinity)
                                .frame(height: 44)
                                .clipped()
                        }
                    }
                    .frame(height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(Color.white.opacity(0.18), lineWidth: 0.5)
                    )
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .bottom)))
                }

                if !isActive || !hasFrameStrip {
                    // Thin track at rest — also the fallback scrubber for
                    // HLS streams where we can't generate a frame strip.
                    Capsule()
                        .fill(Color.white.opacity(0.18))
                        .frame(height: 3)
                    Capsule()
                        .fill(Color.white)
                        .frame(width: max(thumbX, 3), height: 3)
                }

                Circle()
                    .fill(Color.white)
                    .frame(width: thumbSize, height: thumbSize)
                    .shadow(color: .black.opacity(0.35), radius: 3, y: 1)
                    .offset(x: max(0, min(thumbX - thumbSize / 2, width - thumbSize)))
                    .animation(.spring(response: 0.28, dampingFraction: 0.85), value: isActive)
            }
            .frame(height: trackHeight)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { v in
                        if !isActive {
                            withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                                isActive = true
                            }
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        }
                        if !session.isScrubbing {
                            session.isScrubbing = true
                            session.pause()
                        }
                        let frac = max(0, min(1, v.location.x / width))
                        session.liveSeek(to: frac * session.duration)
                        onChanged()
                    }
                    .onEnded { v in
                        let frac = max(0, min(1, v.location.x / width))
                        // Final frame-accurate seek on release. Live-seek
                        // during the drag uses tolerance on HLS to avoid
                        // segment thrash; this snap lands exactly where
                        // the user let go.
                        session.finalSeek(to: frac * session.duration)
                        session.isScrubbing = false
                        session.play()
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                            isActive = false
                        }
                        onChanged()
                    }
            )
        }
        .frame(height: (isActive && !session.frameStrip.isEmpty) ? 44 : 14)
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: isActive)
    }
}

// MARK: - Glass control button

struct ControlButton: View {
    let systemName: String
    var size: CGFloat = 36
    let action: () -> Void

    var body: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            Image(systemName: systemName)
                .font(.system(size: 14, weight: .semibold))
                .foregroundColor(.white)
                .frame(width: size, height: size)
                .background(.ultraThinMaterial, in: Circle())
                .overlay(Circle().stroke(Color.white.opacity(0.18), lineWidth: 0.5))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Hosting view controller for modal presentation
//
// Presented as a fullScreen UIHostingController. Cross-dissolve transition
// keeps the open/close feel premium (no system slide-up that screams
// "stock modal"). The host owns the session strongly so SwiftUI-side
// re-renders never lose the player.

@MainActor
final class PromptlyPlayerHostVC: UIHostingController<PromptlyPlayerView> {
    let session: PromptlyPlayerSession

    init(session: PromptlyPlayerSession, title: String?, posterUrl: String?, onReedit: (() -> Void)?) {
        self.session = session
        let placeholder = PromptlyPlayerView(
            session: session,
            onClose: {},
            onReedit: onReedit,
            title: title,
            posterUrl: posterUrl
        )
        super.init(rootView: placeholder)
        self.modalPresentationStyle = .fullScreen
        self.modalTransitionStyle = .crossDissolve
        self.view.backgroundColor = .black
        self.rootView = PromptlyPlayerView(
            session: session,
            onClose: { [weak self] in self?.dismiss(animated: true) },
            onReedit: onReedit,
            title: title,
            posterUrl: posterUrl
        )
    }

    @MainActor required init?(coder: NSCoder) {
        fatalError("init(coder:) not used")
    }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { [.portrait, .landscape] }

    deinit {
        Task { @MainActor [session] in session.pause() }
    }
}

// MARK: - Buffering spinner
//
// Center-screen indicator that pops in when AVPlayer stalls mid-playback.
// Matches the visual weight of the play/pause button (76pt circle) so
// the eye stays anchored to the same focal point. ultraThinMaterial
// keeps it legible over any frame — bright daylight shots and dark
// night scenes alike — without a hard chip that would feel out of place.
struct BufferingSpinner: View {
    var body: some View {
        ZStack {
            Circle()
                .fill(.ultraThinMaterial)
                .frame(width: 64, height: 64)
                .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.35), radius: 18, y: 6)
            ProgressView()
                .progressViewStyle(.circular)
                .tint(.white)
                .scaleEffect(1.15)
        }
        .accessibilityLabel("Loading")
    }
}
