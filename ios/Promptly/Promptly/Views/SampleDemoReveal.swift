import SwiftUI
import AVKit

/// Identifiable payload driving the cached demo's `.fullScreenCover(item:)`.
struct DemoRevealData: Identifiable {
    let id = UUID()
    let raw: URL?      // optional "before"
    let edited: URL    // the pre-rendered edit
}

/// §4 cached sample-clip demo — the honest before→after reveal (Zac's ratified UX).
///
/// Plays a PRE-RENDERED edit of the official sample clip. There is NO live render
/// and NO fabricated progress: the user sees the same clip **raw** and then
/// **edited by Promptly**, and understands the transformation instantly. The copy
/// never claims their own footage was just processed — it's an honest example, and
/// the payoff (a felt success on a real clip) comes before they risk their own.
///
/// Default side is `.after` — lead with the payoff — with a Before/After toggle so
/// they can see exactly what went in. A single primary CTA hands them straight to
/// uploading their own.
struct SampleDemoReveal: View {
    let rawUrl: URL?         // "before" — the untouched clip (nil ⇒ After-only)
    let editedUrl: URL       // "after"  — Promptly's pre-rendered edit
    let onUpload: () -> Void
    let onClose: () -> Void

    enum Side: String, CaseIterable { case before = "Before", after = "After" }
    @State private var side: Side = .after

    private var currentUrl: URL { side == .before ? (rawUrl ?? editedUrl) : editedUrl }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            VStack(spacing: 0) {
                header

                Text(side == .after
                     ? "The same clip — edited by Promptly, start to finish."
                     : "The raw clip that went in — untouched.")
                    .font(.system(size: 14))
                    .foregroundStyle(.white.opacity(0.6))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 40)
                    .frame(height: 40)

                LoopingPlayer(url: currentUrl)
                    .aspectRatio(9.0 / 16.0, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(alignment: .topLeading) { sideBadge }
                    .overlay(
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
                    .padding(.horizontal, 28)
                    .padding(.vertical, 14)

                if rawUrl != nil { beforeAfterToggle }

                Spacer(minLength: 8)
                cta
            }
            .padding(.vertical, 12)
        }
    }

    private var header: some View {
        ZStack {
            Text("A real Promptly edit")
                .font(.system(size: 19, weight: .bold))
                .foregroundStyle(.white)
            HStack {
                Spacer()
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.white.opacity(0.7))
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(Color.white.opacity(0.10)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            .padding(.trailing, 18)
        }
        .padding(.top, 6)
    }

    // Gold "AFTER · Promptly's edit" / neutral "BEFORE · raw clip" badge.
    private var sideBadge: some View {
        let after = side == .after
        return HStack(spacing: 5) {
            Image(systemName: after ? "sparkles" : "video")
                .font(.system(size: 10, weight: .bold))
            Text(after ? "AFTER · Promptly's edit" : "BEFORE · raw clip")
                .font(.system(size: 11, weight: .bold))
                .tracking(0.4)
        }
        .foregroundStyle(after ? .black : .white)
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(Capsule().fill(after ? Color(red: 1, green: 0.82, blue: 0.5) : Color.black.opacity(0.55)))
        .padding(12)
    }

    private var beforeAfterToggle: some View {
        HStack(spacing: 4) {
            ForEach(Side.allCases, id: \.self) { s in
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    withAnimation(.easeInOut(duration: 0.18)) { side = s }
                } label: {
                    Text(s.rawValue)
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(side == s ? .black : .white.opacity(0.7))
                        .frame(width: 108, height: 36)
                        .background(Capsule().fill(side == s ? Color.white : Color.clear))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(Capsule().fill(Color.white.opacity(0.08)))
    }

    private var cta: some View {
        VStack(spacing: 10) {
            Button(action: onUpload) {
                Text("Upload yours")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .frame(height: 52)
                    .background(Capsule().fill(Color.white))
                    .padding(.horizontal, 40)
            }
            .buttonStyle(.plain)

            Text("Any video works. Talking-head clips with clear audio shine.")
                .font(.system(size: 12))
                .foregroundStyle(.white.opacity(0.35))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
        }
        .padding(.bottom, 8)
    }
}

/// A muted, auto-looping AVPlayer with no controls chrome — for the reveal clips.
/// Recreates its player when the URL changes (Before/After swap).
private struct LoopingPlayer: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> PlayerContainer { PlayerContainer() }
    func updateUIView(_ view: PlayerContainer, context: Context) { view.play(url: url) }

    final class PlayerContainer: UIView {
        override static var layerClass: AnyClass { AVPlayerLayer.self }
        private var looper: Any?
        private var currentUrl: URL?
        private var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

        func play(url: URL) {
            guard url != currentUrl else { return }
            currentUrl = url
            let item = AVPlayerItem(url: url)
            let queue = AVQueuePlayer(playerItem: item)
            queue.isMuted = true
            looper = AVPlayerLooper(player: queue, templateItem: item)
            playerLayer.player = queue
            playerLayer.videoGravity = .resizeAspectFill
            queue.play()
        }
    }
}
