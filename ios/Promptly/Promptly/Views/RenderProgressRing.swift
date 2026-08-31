import SwiftUI

/// The render, presented as the video itself: the source thumbnail framed, a
/// progress ring around it, and ONE line naming the current stage.
///
/// WHAT THIS REPLACES AND WHY. `PipelineProgressView` showed a bar plus a
/// running bullet list of completed stages. The list is the part that had to
/// go: it turns a two-minute wait into a wall of machine vocabulary the reader
/// has to parse, and it grows downward as the render proceeds so the message
/// visibly bloats inside the thread. The user does not need a manifest of what
/// already finished — they need to know it is alive and roughly how far along.
///
/// IT IS A MESSAGE, NOT A MODAL. This sits in a chat thread, so it carries no
/// card chrome, no border, no elevated surface and no separate background: the
/// thumbnail IS the object, and the ring is drawn on it. Anything heavier reads
/// as a dialog that has been pasted into the conversation.
///
/// THE DATA UNDERNEATH IS UNCHANGED. Same `StageTimeline`, same 17-stage server
/// feed, same `TrickleProgress`. The ring is driven by the trickle, NOT by the
/// backend percentage — a self-driving continuous ramp that never freezes or
/// snaps backwards. Mirroring the backend pct is what produced the stuck-at-99
/// behaviour this project has already fixed once; re-introducing it here
/// because a ring "looks smoother" would undo that silently.
struct RenderProgressRing: View {
    @ObservedObject var timeline: StageTimeline
    let progress: Int
    /// The source clip's own frame. Nil until the picker's thumbnail resolves —
    /// the ring stands alone rather than showing a grey placeholder box, which
    /// would read as a failed image.
    var thumbnail: UIImage? = nil
    var subMessage: String? = nil
    var finishing: Bool = false
    var onCancel: (() -> Void)? = nil

    @StateObject private var trickle = TrickleProgress()
    @State private var showCancelConfirm = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var activeStage: PipelineStage? {
        if let did = timeline.currentDerivedId, let s = timeline.stages.first(where: { $0.id == did }) { return s }
        if let cid = timeline.currentStageId, let s = timeline.stages.first(where: { $0.id == cid }) { return s }
        return nil
    }

    /// One line. The finer SSE message wins when present, because it is the more
    /// specific truth about what is happening right now; the catalog stage is
    /// the fallback. Never both — stacking them re-creates the list.
    private var line: String {
        if let m = subMessage, !m.isEmpty { return m }
        if let s = activeStage { return s.title }
        return String(localized: "Getting started…")
    }

    private var ringValue: Double { min(max(trickle.displayed / 100.0, 0), 1) }

    var body: some View {
        VStack(spacing: 14) {
            ZStack {
                // The video, framed. Square-ish so it reads as the subject
                // rather than as an icon beside text.
                Group {
                    if let t = thumbnail {
                        Image(uiImage: t)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                    } else {
                        // No placeholder chrome — just the ring's own ground.
                        Color.white.opacity(0.04)
                    }
                }
                .frame(width: 148, height: 148)
                .clipShape(Circle())
                // Slightly dimmed while working so the ring reads as the
                // foreground element and the frame does not compete with it.
                .opacity(finishing ? 1.0 : 0.82)

                Circle()
                    .stroke(Color.white.opacity(0.10), lineWidth: 3)
                    .frame(width: 164, height: 164)

                Circle()
                    .trim(from: 0, to: ringValue)
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .frame(width: 164, height: 164)
                    .rotationEffect(.degrees(-90))
                    .animation(reduceMotion ? nil : .linear(duration: 0.12), value: ringValue)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(line))
            .accessibilityValue(Text("\(Int(trickle.displayed))%"))

            Text(line)
                .font(.system(size: 14, weight: .medium))
                .foregroundColor(.white.opacity(0.85))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 24)
                // The line changes often; without an id the text animates as a
                // character-level diff, which reads as jitter.
                .id(line)
                .transition(.opacity)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: line)

            if let onCancel, timeline.isCancellable {
                Button(role: .destructive) { showCancelConfirm = true } label: {
                    Text("Cancel render")
                        .font(.system(size: 13))
                        .foregroundColor(.red.opacity(0.75))
                }
                .confirmationDialog(String(localized: "Cancel this render?"),
                                    isPresented: $showCancelConfirm, titleVisibility: .visible) {
                    Button(String(localized: "Cancel render"), role: .destructive) { onCancel() }
                    Button(String(localized: "Keep rendering"), role: .cancel) {}
                } message: {
                    Text("This stops the edit before it starts — your daily render won't be used.")
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        // Driven EXACTLY as PipelineProgressView drives it — rehydrate on
        // appear so a recreated view starts at true progress rather than 0,
        // feed the backend value in as a ceiling clamped below 100 until real
        // completion, and let the animator own all motion and monotonicity.
        // Copying this contract rather than inventing a ring-specific one is
        // the point: the presentation changed, the progress semantics did not.
        .onAppear {
            trickle.rehydrate(to: finishing ? progress : min(progress, 99))
            if finishing { trickle.complete() }
        }
        .onDisappear { trickle.stop() }
        .onChange(of: progress, initial: true) { _, new in
            trickle.update(target: finishing ? new : min(new, 99))
        }
        .onChange(of: finishing) { _, done in
            if done { trickle.complete() }
        }
    }
}
