import SwiftUI
import AVFoundation

/// Conversion item 5 — the RESULTS WALL: a grid of real Promptly outputs shown
/// immediately before the second paywall (social proof right before the ask —
/// the teardown's mechanism, our brand).
///
/// Content is SERVER-SWAPPABLE WITHOUT A BUILD: /api/health.results_wall is an
/// array of {video_url, thumb_url} curated server-side (env), so the clips are
/// always current renders from the live pipeline — the stale-sample-demo
/// failure mode is structurally impossible to repeat here. An EMPTY list skips
/// the beat entirely (auto-advance): no clips, no screen, never a blank wall.
struct ResultsWallView: View {
    let onContinue: () -> Void

    @State private var tiles: [(video: URL, thumb: URL?)] = []
    @State private var loaded = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if loaded && !tiles.isEmpty {
                VStack(spacing: 0) {
                    Text("Made with Promptly")
                        .font(.system(size: 28, weight: .heavy))
                        .foregroundColor(.white)
                        .padding(.top, 24)
                        .entrance()
                    Text("Real videos, edited by talking to it.")
                        .font(.system(size: 15))
                        .foregroundColor(.white.opacity(0.65))
                        .padding(.top, 6)

                    ScrollView(showsIndicators: false) {
                        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10),
                                            GridItem(.flexible(), spacing: 10)],
                                  spacing: 10) {
                            ForEach(Array(tiles.enumerated()), id: \.offset) { idx, tile in
                                LoopingVideoTile(url: tile.video, thumb: tile.thumb)
                                    .aspectRatio(9.0 / 16.0, contentMode: .fit)
                                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                                    // Tiles cascade in reading order, capped so a
                                    // long grid never feels slow to assemble.
                                    .entrance(delay: min(Double(idx) * 0.07, 0.42) + 0.10)
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 20)
                        .padding(.bottom, 12)
                    }

                    Button {
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onContinue()
                    } label: {
                        Text("Continue")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.black)
                            .frame(maxWidth: .infinity)
                            .frame(height: 54)
                            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white))
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 16)
                }
            }
        }
        .task {
            // One cheap unauthenticated fetch; same host as everything else.
            // Failure or empty list → skip the beat, never a blank wall.
            defer { loaded = true }
            do {
                var req = URLRequest(url: URL(string: "https://usepromptly.app/api/health")!)
                req.timeoutInterval = 5
                let (data, _) = try await URLSession.shared.data(for: req)
                let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
                let list = (obj?["results_wall"] as? [[String: Any]]) ?? []
                tiles = list.compactMap { entry in
                    guard let v = entry["video_url"] as? String, let vu = URL(string: v) else { return nil }
                    let t = (entry["thumb_url"] as? String).flatMap(URL.init(string:))
                    return (video: vu, thumb: t)
                }
            } catch { tiles = [] }
            if tiles.isEmpty { onContinue() }
        }
    }
}

/// A muted, looping, autoplay video tile (poster first). Kept deliberately
/// minimal: one AVPlayer per tile, looping via AVPlayerLooper, muted always.
private struct LoopingVideoTile: View {
    let url: URL
    let thumb: URL?

    var body: some View {
        ZStack {
            if let thumb {
                AsyncImage(url: thumb) { phase in
                    if let img = phase.image { img.resizable().scaledToFill() }
                    else { Color.white.opacity(0.06) }
                }
            } else {
                Color.white.opacity(0.06)
            }
            LoopingPlayerView(url: url)
        }
    }
}

private struct LoopingPlayerView: UIViewRepresentable {
    let url: URL

    final class PlayerUIView: UIView {
        private let playerLayer = AVPlayerLayer()
        private var player: AVQueuePlayer?
        private var looper: AVPlayerLooper?

        init(url: URL) {
            super.init(frame: .zero)
            let item = AVPlayerItem(url: url)
            let player = AVQueuePlayer()
            player.isMuted = true
            self.player = player
            self.looper = AVPlayerLooper(player: player, templateItem: item)
            playerLayer.player = player
            playerLayer.videoGravity = .resizeAspectFill
            layer.addSublayer(playerLayer)
            player.play()
        }
        required init?(coder: NSCoder) { fatalError("unused") }
        override func layoutSubviews() {
            super.layoutSubviews()
            playerLayer.frame = bounds
        }
        deinit { player?.pause() }
    }

    func makeUIView(context: Context) -> PlayerUIView { PlayerUIView(url: url) }
    func updateUIView(_ uiView: PlayerUIView, context: Context) {}
}
