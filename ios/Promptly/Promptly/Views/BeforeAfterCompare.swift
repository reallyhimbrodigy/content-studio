import SwiftUI
import AVFoundation

/// Hold to see the original. Release to return to the edit.
///
/// WHY HOLD, NOT A SLIDER. A slider needs two players decoding simultaneously
/// and kept frame-accurate against each other, and on a phone the handle sits
/// exactly where the thumb already is during playback. Hold-to-compare is one
/// player, one gesture, and it is the gesture people already know from photo
/// editors — press to see the original, let go to see the edit. It also makes
/// the comparison ACTIVE: the user performs the difference rather than reading
/// a labelled split, which is what makes it feel like proof.
///
/// NO LABELS. The spec asks for nothing competing with the video, and "BEFORE"
/// / "AFTER" chips are the usual way that gets violated — they sit on top of
/// the frame, they need translating, and they explain a gesture that explains
/// itself. The only affordance is a one-time hint, and it retires permanently
/// once the gesture has been used.
///
/// POSITION IS PRESERVED. Swapping sources seeks the original to the edit's
/// current time, so the comparison is of the SAME MOMENT. Restarting the source
/// from zero would compare two different instants and prove nothing — the edit
/// is shorter than its source, so the times do not correspond after the first
/// cut, and this is honest about that: it clamps rather than pretending.
struct BeforeAfterCompare: View {
    let editedUrl: String
    let sourceUrl: String
    /// The already-playing edit. Owned by the caller; this view drives it.
    @ObservedObject var player: PlayerBox

    @State private var showingSource = false
    @State private var hintShown = UserDefaults.standard.bool(forKey: "before_after_hint_seen")
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack(alignment: .bottom) {
            Color.clear
                .contentShape(Rectangle())
                .gesture(
                    // minimumDuration 0 so the swap is immediate — a delay here
                    // reads as lag, not as a deliberate long-press.
                    LongPressGesture(minimumDuration: 0)
                        .sequenced(before: DragGesture(minimumDistance: 0))
                        .onChanged { _ in if !showingSource { swap(toSource: true) } }
                        .onEnded { _ in swap(toSource: false) }
                )

            if !hintShown {
                Text("Hold to see the original")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.white.opacity(0.9))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(.ultraThinMaterial, in: Capsule())
                    .padding(.bottom, 14)
                    .transition(.opacity)
                    .allowsHitTesting(false)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.15), value: showingSource)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: hintShown)
        .accessibilityElement()
        .accessibilityLabel(Text("Compare with the original"))
        .accessibilityHint(Text("Double tap and hold to see the video before editing"))
        .accessibilityAddTraits(.isButton)
    }

    private func swap(toSource: Bool) {
        guard toSource != showingSource else { return }
        showingSource = toSource
        // The hint has done its job the first time the gesture is used; retire
        // it permanently rather than showing it on every finished video.
        if toSource, !hintShown {
            UserDefaults.standard.set(true, forKey: "before_after_hint_seen")
            hintShown = true
        }
        Analytics.track(toSource ? "before_after_held" : "before_after_released",
                        props: ["context": "result_bubble"])
        player.swapSource(to: toSource ? sourceUrl : editedUrl)
    }
}

/// Thin box around the AVPlayer so the compare view can drive it without
/// owning its lifecycle — the bubble already created and is already playing it.
final class PlayerBox: ObservableObject {
    let player: AVPlayer
    private var currentUrl: String

    init(player: AVPlayer, url: String) {
        self.player = player
        self.currentUrl = url
    }

    /// Swap the item, preserving position. The source is LONGER than the edit,
    /// so the edit's time is always valid within it; the reverse is not true,
    /// hence the clamp on the way back.
    func swapSource(to url: String) {
        guard url != currentUrl, let u = URL(string: url) else { return }
        let t = player.currentTime()
        let wasPlaying = player.timeControlStatus == .playing
        let item = AVPlayerItem(url: u)
        player.replaceCurrentItem(with: item)
        // Clamp: seeking past the end silently fails and leaves a black frame,
        // which reads as a broken video rather than as a shorter one.
        let target = CMTimeMinimum(t, CMTimeSubtract(item.asset.duration, CMTime(value: 1, timescale: 10)))
        player.seek(to: CMTimeMaximum(target, .zero), toleranceBefore: .zero, toleranceAfter: .zero)
        if wasPlaying { player.play() }
        currentUrl = url
    }
}
