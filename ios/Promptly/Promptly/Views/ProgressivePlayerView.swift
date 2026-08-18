import SwiftUI
import AVKit
import AVFoundation

/// §5 progressive playback — the preview→final swap Zac approved.
///
/// Terminology (locked, per the codebase): "progressive MP4" = `renderedVideoUrl`
/// (faststart, already plays); "HLS/adaptive" = `hlsManifestUrl` (the .m3u8 the
/// worker grows as it encodes). This view plays the HLS manifest as a muted inline
/// PREVIEW the moment the backend emits it mid-render, then SWAPS IN PLACE to the
/// final MP4 the instant it lands (same AVPlayer, seek to preserve the playhead) —
/// a seamless "it's coming together" experience instead of a dead spinner.
///
/// Gated by `UsageService.progressivePlaybackEnabled`; both client and backend flip
/// on the same word. The whole component is inert until then, and Zac confirms the
/// real swap on-device during the 219 TestFlight pass.
struct ProgressivePlayerView: View {
    /// The HLS master playlist (grows during the render). Nil until the backend emits it.
    let manifestUrl: String?
    /// The final progressive MP4. Nil until completion; its arrival triggers the swap.
    let finalUrl: String?
    /// Poster shown until the first frame paints.
    let posterUrl: String?
    /// Open the full-screen player (final URL preferred). Wired by the bubble to the
    /// same VideoPlayerPresenter path the completed video uses.
    var onTapFullscreen: () -> Void = {}

    // Preview vs final is derived, not stored: once the final URL exists we've swapped
    // (or are swapping), so the "Live preview" badge drops. No cross-layer state.
    private var isPreview: Bool { finalUrl == nil }

    var body: some View {
        LivePlayerSurface(manifestUrl: manifestUrl, finalUrl: finalUrl)
            .aspectRatio(9.0 / 16.0, contentMode: .fit)
            .frame(maxWidth: 300)
            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(alignment: .topLeading) {
                if isPreview { livePreviewBadge }
            }
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
            .contentShape(Rectangle())
            .onTapGesture { onTapFullscreen() }
            .accessibilityLabel(isPreview ? "Live preview of your edit" : "Your finished edit")
    }

    private var livePreviewBadge: some View {
        HStack(spacing: 5) {
            Circle().fill(Color(red: 1, green: 0.82, blue: 0.5)).frame(width: 6, height: 6)
            Text("LIVE PREVIEW · finishing")
                .font(.system(size: 10, weight: .bold)).tracking(0.4)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 9).padding(.vertical, 5)
        .background(Capsule().fill(Color.black.opacity(0.55)))
        .padding(10)
    }
}

/// AVPlayer surface that starts on the HLS manifest and swaps to the final MP4 in
/// place. UIKit (AVPlayerLayer) — AVPlayer streams HLS natively and swapping items
/// with a seek is the only way to preserve the playhead across the preview→final cut.
private struct LivePlayerSurface: UIViewRepresentable {
    let manifestUrl: String?
    let finalUrl: String?

    func makeUIView(context: Context) -> PlayerBox { PlayerBox() }
    func updateUIView(_ box: PlayerBox, context: Context) {
        box.apply(manifest: manifestUrl, final: finalUrl)
    }
    static func dismantleUIView(_ box: PlayerBox, coordinator: ()) { box.teardown() }

    final class PlayerBox: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        private var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
        private let player = AVPlayer()
        private var startedManifest: String?
        private var swappedFinal: String?

        override init(frame: CGRect) {
            super.init(frame: frame)
            player.isMuted = true                 // muted inline preview (standard in-feed)
            player.actionAtItemEnd = .pause
            playerLayer.player = player
            playerLayer.videoGravity = .resizeAspectFill
        }
        required init?(coder: NSCoder) { fatalError("init(coder:) unavailable") }

        func apply(manifest: String?, final: String?) {
            // 1) Start the HLS preview once, as soon as a manifest exists.
            if startedManifest == nil, let m = manifest, !m.isEmpty, let url = URL(string: m) {
                startedManifest = m
                let item = PlayerAssetPrewarm.shared.takePlayerItem(for: m) ?? AVPlayerItem(url: url)
                player.replaceCurrentItem(with: item)
                player.play()
            }
            // 2) Swap to the final MP4 once, the instant it lands — carry the playhead
            //    so the cut is seamless. If the preview never started (manifest absent),
            //    this simply becomes the first (and only) item.
            if swappedFinal == nil, let f = final, !f.isEmpty, let url = URL(string: f) {
                swappedFinal = f
                // Capture the preview's playhead AND its end BEFORE replacing the item.
                let at = player.currentTime()
                let outEnd: Double? = {
                    guard let out = player.currentItem else { return nil }
                    let d = out.duration
                    if d.isNumeric, d.seconds > 0 { return d.seconds }        // definite (VOD)
                    return out.seekableTimeRanges.last?.timeRangeValue.end.seconds // growing HLS
                }()
                let item = PlayerAssetPrewarm.shared.takePlayerItem(for: f) ?? AVPlayerItem(url: url)
                player.replaceCurrentItem(with: item)
                // Carry the playhead ONLY when the preview genuinely advanced AND hasn't
                // reached the end. Seeking a same-length final to ~its own duration would
                // park it on the last frame (actionAtItemEnd = .pause) — a frozen swap.
                // When the preview has caught up (or we can't tell its end), play the
                // final from 0. PRECISE seek (both tolerances .zero) so the cut lands
                // exactly, never a keyframe forward that would drop up to a GOP.
                let t = at.seconds
                if at.isValid, t > 0.3, let end = outEnd, t < end - 0.5 {
                    player.seek(to: at, toleranceBefore: .zero, toleranceAfter: .zero)
                }
                player.play()
            }
        }

        func teardown() {
            player.pause()
            player.replaceCurrentItem(with: nil)
        }
    }
}
