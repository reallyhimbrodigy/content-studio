import SwiftUI

/// Hold to see the original. Release to return to the edit.
///
/// WHY HOLD, NOT A SLIDER. A slider needs two players decoding simultaneously
/// and kept frame-accurate against each other, and on a phone the handle sits
/// exactly where the thumb already is during playback. Hold-to-compare is one
/// player, one gesture, and it is the gesture people already know from photo
/// editors. It also makes the comparison ACTIVE: the user performs the
/// difference rather than reading a labelled split, which is what makes it feel
/// like proof.
///
/// IT LIVES ON THE FULL-SCREEN PLAYER, NOT THE RESULT BUBBLE. The bubble was the
/// original brief and it is not possible there: `CompletedVideoView` is a static
/// `AsyncImage` thumbnail with no AVPlayer at all, so a hold gesture would have
/// swapped the item of a player that is not on screen — a no-op the user could
/// never see. The comparison also wants the large surface. The flag comment and
/// this file's analytics context were updated to match reality rather than left
/// describing the surface we did not build.
///
/// THIS VIEW OWNS NO PLAYER. It reports hold and release; the player session
/// performs the swap, because that is where the item observers live and they
/// must be rebound whenever the item changes. An earlier draft wrapped its own
/// `PlayerBox` around the AVPlayer, which both shadowed an existing type of that
/// name and put the swap somewhere that could not maintain the observers.
///
/// BOUNDED HIT REGION, DELIBERATELY. The first draft was `Color.clear` across
/// the whole frame with a zero-threshold long-press. Over
/// `AVPlayerViewController` that swallows every tap to the native transport
/// controls and fights the swipe-to-dismiss gesture on the same surface. So the
/// affordance is an explicit, finite control — which also means the user can see
/// what to press instead of having to be told a hidden gesture exists.
struct BeforeAfterCompare: View {
    let isShowingSource: Bool
    let onChange: (Bool) -> Void

    @State private var hintShown = UserDefaults.standard.bool(forKey: "before_after_hint_seen")
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: isShowingSource ? "eye.fill" : "rectangle.on.rectangle")
                .font(.system(size: 13, weight: .semibold))
            Text(hintShown ? "Original" : "Hold for original")
                .font(.system(size: 13, weight: .medium))
                .fixedSize()
        }
        .foregroundColor(.white.opacity(isShowingSource ? 1 : 0.85))
        .padding(.horizontal, 14)
        .frame(height: 40)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay(
            Capsule().strokeBorder(Color.white.opacity(isShowingSource ? 0.5 : 0.15), lineWidth: 1)
        )
        .scaleEffect(isShowingSource ? 0.96 : 1)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.14), value: isShowingSource)
        .contentShape(Capsule())
        .gesture(
            // minimumDuration 0 so the swap is immediate — a delay here reads as
            // lag, not as a deliberate long-press.
            LongPressGesture(minimumDuration: 0)
                .sequenced(before: DragGesture(minimumDistance: 0))
                .onChanged { _ in if !isShowingSource { set(true) } }
                .onEnded { _ in set(false) }
        )
        .accessibilityElement()
        .accessibilityLabel(Text("Compare with the original"))
        .accessibilityHint(Text("Double tap and hold to see the video before editing"))
        .accessibilityAddTraits(.isButton)
    }

    private func set(_ toSource: Bool) {
        guard toSource != isShowingSource else { return }
        // The hint has done its job the first time the gesture is used; retire
        // it permanently rather than re-teaching on every finished video.
        if toSource, !hintShown {
            UserDefaults.standard.set(true, forKey: "before_after_hint_seen")
            hintShown = true
        }
        Analytics.track(toSource ? "before_after_held" : "before_after_released",
                        props: ["context": "fullscreen_player"])
        onChange(toSource)
    }
}
