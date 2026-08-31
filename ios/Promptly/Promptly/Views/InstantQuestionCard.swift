import SwiftUI

/// One conversational question, rendered on the SAME run loop as send.
///
/// ZERO NETWORK, BY CONSTRUCTION. Every question and option below is a compile-
/// time constant. Nothing here awaits, fetches, or reads from disk, so the card
/// is on screen in the same frame as the user's own message — which is the
/// whole point. The precedent is `preselectedVibe` (EditorView:546), already
/// read from local state with no round trip.
///
/// A spinner here would defeat the feature: the user has just acted, and the
/// moment they are waiting on anything, this stops being the chat answering and
/// becomes a form loading.
///
/// IT DOES NOT GATE THE RENDER. The upload and dispatch proceed immediately.
/// This refines the edit if answered while the render is still early, and is
/// simply ignored if not. Blocking dispatch on an answer would ADD latency to
/// the one path this feature exists to make feel instant, and would strand
/// anyone who dismisses it.
enum InstantQuestion {

    struct Option: Identifiable {
        let id: String
        let label: String
        /// Appended to the vibe when chosen. Written as an editing instruction
        /// rather than a label, because it goes to the model verbatim.
        let vibeFragment: String
    }

    struct Spec {
        let id: String
        let prompt: String
        let options: [Option]
    }

    /// Asked when the composer text carries no styling intent of its own.
    /// Deliberately ONE question with four options: two would read as a form,
    /// and a free-text follow-up would reintroduce the typing this removes.
    static var pacing: Spec {
        Spec(
            id: "pacing",
            prompt: String(localized: "How should it feel?"),
            options: [
                Option(id: "fast", label: String(localized: "Fast cuts"),
                       vibeFragment: "fast cuts, high energy, punchy captions"),
                Option(id: "clean", label: String(localized: "Clean"),
                       vibeFragment: "clean and minimal, restrained captions"),
                Option(id: "cinematic", label: String(localized: "Cinematic"),
                       vibeFragment: "cinematic pacing, documentary feel"),
                Option(id: "surprise", label: String(localized: "You choose"),
                       vibeFragment: ""),
            ]
        )
    }

    /// Words that already state a style. When the user has said how they want
    /// it, asking again is worse than not asking — it reads as not having been
    /// listened to. Matched on the composer text before the card is offered.
    private static let intentWords = [
        "fast", "quick", "punchy", "energy", "hype", "viral",
        "clean", "minimal", "simple", "calm", "slow",
        "cinematic", "documentary", "dramatic", "moody",
    ]

    /// Whether to ask at all. Nil = stay quiet.
    static func spec(forComposerText text: String) -> Spec? {
        let t = text.lowercased()
        guard !intentWords.contains(where: { t.contains($0) }) else { return nil }
        return pacing
    }
}

/// The card itself — chips in the thread, not a sheet. No card background, no
/// border: it is the assistant's turn in the conversation, and anything heavier
/// reads as UI that has interrupted the chat rather than continued it.
struct InstantQuestionCard: View {
    let spec: InstantQuestion.Spec
    /// Called with the chosen option's vibe fragment (empty for "You choose").
    let onPick: (InstantQuestion.Option) -> Void
    @State private var picked: String? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(spec.prompt)
                .font(.system(size: 15))
                .foregroundColor(.white.opacity(0.9))

            // Wraps rather than scrolls: a horizontal scroller hides options
            // off-screen, and an option the user cannot see is an option that
            // does not exist.
            FlowRow(spacing: 8) {
                ForEach(spec.options) { opt in
                    Button {
                        guard picked == nil else { return }
                        picked = opt.id
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        onPick(opt)
                    } label: {
                        Text(opt.label)
                            .font(.system(size: 14, weight: .medium))
                            .foregroundColor(picked == opt.id ? .black : .white)
                            .padding(.horizontal, 14)
                            .frame(height: 36)
                            .background(picked == opt.id ? Color.white : Color.white.opacity(0.08),
                                        in: Capsule())
                            .overlay(Capsule().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
                    }
                    .disabled(picked != nil)
                    .opacity(picked == nil || picked == opt.id ? 1 : 0.35)
                }
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.18), value: picked)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Minimal wrapping row. SwiftUI has no built-in flow layout below iOS 16's
/// `Layout`, and the project targets a range wide enough that hand-rolling it
/// is cheaper than the availability dance.
struct FlowRow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > maxWidth, x > 0 { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
        return CGSize(width: maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            rowHeight = max(rowHeight, s.height)
        }
    }
}
