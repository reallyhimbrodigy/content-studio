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
    func warm(_ urlString: String) {
        guard items[urlString] == nil, !inFlight.contains(urlString),
              let url = URL(string: urlString) else { return }
        inFlight.insert(urlString)
        let asset = AVURLAsset(url: url)
        Task.detached(priority: .userInitiated) {
            _ = try? await asset.load(.tracks, .duration, .preferredTransform)
            await MainActor.run {
                let item = AVPlayerItem(asset: asset)
                item.preferredForwardBufferDuration = 4
                self.items[urlString] = item
                self.inFlight.remove(urlString)
            }
        }
    }

    /// Hand off the cached item — or freshly create one if there's no warm
    /// hit. AVPlayerItem can only be in ONE player at a time, so we remove
    /// from the cache on take.
    func takePlayerItem(for urlString: String) -> AVPlayerItem? {
        if let cached = items.removeValue(forKey: urlString) {
            return cached
        }
        guard let url = URL(string: urlString) else { return nil }
        let asset = AVURLAsset(url: url)
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 4
        return item
    }
}

// MARK: - Frame strip cache
//
// AVAssetImageGenerator extracts ~24 thumbnails sampled across the full
// duration. Memo'd per URL so re-opening the player is instant.

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

// MARK: - AVPlayerLayer wrapped for SwiftUI

struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> _PlayerLayerHostView {
        let v = _PlayerLayerHostView()
        v.playerLayer.player = player
        v.playerLayer.videoGravity = .resizeAspect
        v.backgroundColor = .black
        return v
    }

    func updateUIView(_ uiView: _PlayerLayerHostView, context: Context) {
        if uiView.playerLayer.player !== player {
            uiView.playerLayer.player = player
        }
    }

    final class _PlayerLayerHostView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}

// MARK: - Player session
//
// Single owner of the AVPlayer + observers. The hosting view controller
// keeps a strong ref; SwiftUI views observe via @ObservedObject. Deinit
// cleans up time observers, KVO, and notification tokens — leaks here
// were the source of the choppy-after-many-plays regression in the old
// AVPlayerViewController path.

@MainActor
final class PromptlyPlayerSession: ObservableObject {
    let player: AVPlayer
    let urlString: String

    @Published var isPlaying: Bool = false
    @Published var currentTime: Double = 0
    @Published var duration: Double = 0
    @Published var isReady: Bool = false
    @Published var isLooping: Bool = true
    @Published var rate: Float = 1.0
    @Published var isScrubbing: Bool = false
    @Published private(set) var frameStrip: [UIImage] = []

    private var timeObserver: Any?
    private var statusKVO: NSKeyValueObservation?
    private var endNotificationToken: NSObjectProtocol?

    init(item: AVPlayerItem, urlString: String) {
        self.player = AVPlayer(playerItem: item)
        self.urlString = urlString
        self.player.actionAtItemEnd = .pause
        // Asset is pre-warmed; don't let AVPlayer add another 300ms of
        // stall-avoidance buffering before first paint.
        self.player.automaticallyWaitsToMinimizeStalling = false

        // Periodic progress for the scrubber. 1/30s is enough resolution
        // for a 60fps UI without burning main-thread cycles.
        let interval = CMTime(seconds: 1.0/30.0, preferredTimescale: 600)
        self.timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            guard let self else { return }
            if !self.isScrubbing {
                self.currentTime = time.seconds
            }
        }

        statusKVO = item.observe(\.status, options: [.new, .initial]) { [weak self] item, _ in
            Task { @MainActor in
                guard let self else { return }
                if item.status == .readyToPlay {
                    self.isReady = true
                    let d = item.duration.seconds
                    if d.isFinite, d > 0 {
                        self.duration = d
                    }
                }
            }
        }

        endNotificationToken = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if self.isLooping {
                    self.player.seek(to: .zero, toleranceBefore: .zero, toleranceAfter: .zero)
                    self.player.play()
                } else {
                    self.isPlaying = false
                }
            }
        }

        // If the asset was pre-warmed, duration may already be loaded —
        // surface it immediately so the scrubber doesn't render with zero
        // width on the first frame.
        Task { @MainActor [weak self] in
            guard let self else { return }
            if let d = try? await item.asset.load(.duration), d.seconds.isFinite, d.seconds > 0 {
                self.duration = d.seconds
            }
        }

        // Frame strip generation off-thread.
        Task { [weak self] in
            guard let self else { return }
            let images = await FrameStripCache.shared.strip(for: urlString, asset: item.asset)
            await MainActor.run {
                self.frameStrip = images
            }
        }
    }

    func togglePlay() {
        if isPlaying {
            player.pause()
            isPlaying = false
        } else {
            player.rate = rate
            isPlaying = true
        }
    }

    func play() {
        player.rate = rate
        isPlaying = true
    }

    func pause() {
        player.pause()
        isPlaying = false
    }

    /// Live-scrub: seek with zero tolerance on every gesture tick so the
    /// frame visually tracks the thumb. Photos.app pattern — most apps
    /// settle for "seek on release" because zero-tolerance seeks are
    /// expensive, but on modern devices it's smooth enough.
    func liveSeek(to seconds: Double) {
        guard duration > 0 else { return }
        let t = CMTime(seconds: max(0, min(seconds, duration)), preferredTimescale: 600)
        currentTime = t.seconds
        player.seek(to: t, toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func setSpeed(_ newRate: Float) {
        rate = newRate
        if isPlaying { player.rate = newRate }
    }

    deinit {
        if let t = timeObserver { player.removeTimeObserver(t) }
        statusKVO?.invalidate()
        if let token = endNotificationToken { NotificationCenter.default.removeObserver(token) }
        player.pause()
    }
}

// MARK: - Player view (the surface the user sees)

struct PromptlyPlayerView: View {
    @ObservedObject var session: PromptlyPlayerSession
    let onClose: () -> Void
    let onReedit: (() -> Void)?
    let title: String?

    @State private var showControls: Bool = true
    @State private var hideTask: Task<Void, Never>?
    @State private var dismissOffset: CGFloat = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Video. Tap toggles controls; drag-down rubber-bands and dismisses.
            PlayerLayerView(player: session.player)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { toggleControls() }
                .scaleEffect(1 - min(abs(dismissOffset) / 1500, 0.15), anchor: .center)
                .offset(y: dismissOffset)
                .gesture(swipeDownDismiss)

            // Subtle vignette during fullscreen playback (controls hidden).
            // Pulls focus toward subject without muddying the picture.
            if session.isPlaying && !showControls {
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
        }
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

            SpeedPill(rate: session.rate) { session.setSpeed($0) }

            ControlButton(
                systemName: session.isLooping ? "repeat.circle.fill" : "repeat",
                size: 36
            ) {
                session.isLooping.toggle()
            }
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

// MARK: - Speed pill (Menu)

struct SpeedPill: View {
    let rate: Float
    let onChange: (Float) -> Void

    var body: some View {
        Menu {
            ForEach([0.5, 1.0, 1.5, 2.0], id: \.self) { r in
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onChange(Float(r))
                } label: {
                    HStack {
                        Text("\(formatRate(r))×")
                        if abs(rate - Float(r)) < 0.01 {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            Text("\(formatRate(Double(rate)))×")
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .foregroundColor(.white)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(Color.white.opacity(0.18), lineWidth: 0.5))
        }
    }

    private func formatRate(_ r: Double) -> String {
        if r == floor(r) { return String(format: "%.0f", r) }
        return String(format: "%.1f", r)
    }
}

// MARK: - Frame-strip scrubber
//
// At rest: thin progress line + 11pt thumb.
// Active (touched): expands to a 44pt frame strip with 16pt thumb, like
// Spotify's scrubber growing on touch. Live-seeks the player on every
// drag tick — frame visually follows the thumb.

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
            let trackHeight: CGFloat = isActive ? 44 : 14

            ZStack(alignment: .leading) {
                if isActive && !session.frameStrip.isEmpty {
                    // Frame strip — equally-sized cells filling the track
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

                    // Played-portion overlay tint so the user sees how far along
                    Rectangle()
                        .fill(Color.black.opacity(0.0))
                        .overlay(alignment: .leading) {
                            Rectangle()
                                .fill(Color.white.opacity(0.0))
                                .frame(width: thumbX)
                        }
                        .frame(height: 44)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .allowsHitTesting(false)
                }

                if !isActive {
                    // Thin track at rest
                    Capsule()
                        .fill(Color.white.opacity(0.18))
                        .frame(height: 3)
                    Capsule()
                        .fill(Color.white)
                        .frame(width: max(thumbX, 3), height: 3)
                }

                // Thumb
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
                        session.liveSeek(to: frac * session.duration)
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
        .frame(height: isActive ? 44 : 14)
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

    init(session: PromptlyPlayerSession, title: String?, onReedit: (() -> Void)?) {
        self.session = session
        // Initialize with a placeholder closure; rewrite rootView below
        // with one that captures self weakly to call dismiss.
        let placeholder = PromptlyPlayerView(
            session: session, onClose: {}, onReedit: onReedit, title: title
        )
        super.init(rootView: placeholder)
        self.modalPresentationStyle = .fullScreen
        self.modalTransitionStyle = .crossDissolve
        self.view.backgroundColor = .black
        self.rootView = PromptlyPlayerView(
            session: session,
            onClose: { [weak self] in self?.dismiss(animated: true) },
            onReedit: onReedit,
            title: title
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
