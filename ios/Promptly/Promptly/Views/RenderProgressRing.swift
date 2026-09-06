import SwiftUI

/// A rounded-rectangle progress trace that starts at TOP CENTER.
///
/// `RoundedRectangle().trim()` would be the one-liner, but its path begins at
/// the end of the top-left corner arc, so the fill starts from the upper-left
/// and reads as though the render began somewhere arbitrary. A progress trace
/// has a natural origin — top centre, like a clock — and on a tall 9:16 frame
/// the difference is obvious rather than pedantic.
///
/// Rotating a `RoundedRectangle` to fake it does not work either: rotation turns
/// the whole non-square frame on its side.
private struct FrameTrace: Shape {
    var cornerRadius: CGFloat

    func path(in rect: CGRect) -> Path {
        let r = min(cornerRadius, min(rect.width, rect.height) / 2)
        let midX = rect.midX
        var p = Path()
        // Top edge, from centre to the top-right corner.
        p.move(to: CGPoint(x: midX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX - r, y: rect.minY))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.minY + r), radius: r,
                 startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
        p.addArc(center: CGPoint(x: rect.maxX - r, y: rect.maxY - r), radius: r,
                 startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.maxY - r), radius: r,
                 startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + r))
        p.addArc(center: CGPoint(x: rect.minX + r, y: rect.minY + r), radius: r,
                 startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.addLine(to: CGPoint(x: midX, y: rect.minY))
        return p
    }
}

/// The render, presented as the footage itself: the user's own frame, large, in
/// a device-shaped container, with the progress tracing that container's edge
/// and ONE line of stage text under it.
///
/// REBUILT 2026-08-31 after review. The first version was rejected, and the
/// notes are worth keeping because each one names a different way a chat message
/// can start behaving like an app screen:
///   - The frame was a CIRCLE. Video is not round. A circle crops a 9:16 clip to
///     its centre square and throws away most of the shot the user picked, so
///     the one thing the surface is supposed to show is the thing it hid.
///   - It was SMALL — an icon beside text rather than the subject of the
///     message.
///   - It sat under a bordered card carrying the prompt and a row of feature
///     chips, which is settings-panel furniture. In a thread it reads as a
///     dialog pasted into the conversation.
///   - The prompt inside that card TRUNCATED. A half-sentence in quotation marks
///     is worse than no sentence: it looks like the product misquoting the user.
///   - And the frame was usually EMPTY, which is the defect underneath the other
///     four — see the thumbnail note below.
///
/// THE EMPTY FRAME WAS A PERSISTENCE BUG, not a styling one. The only source was
/// `VideoAttachment.thumbnail`, a UIImage held in memory and never written to
/// storage; `SerializedMessage` persists `attachmentThumbnailUrl` instead. So the
/// image survived exactly as long as the process did, and every reload — every
/// relaunch, every chat switch, every scroll that recycled the row — left the
/// ring framing nothing. Styling the empty state would have made a permanent
/// blank look intentional. It now falls back to the persisted URL.
///
/// IT IS A MESSAGE, NOT A MODAL: no card, no border, no elevated surface, no
/// icon row. The footage is the object and the trace is drawn on it.
///
/// THE DATA UNDERNEATH IS UNCHANGED. Same `StageTimeline`, same 17-stage feed,
/// same `TrickleProgress`. The trace is driven by the trickle, NOT by the
/// backend percentage — mirroring the backend pct is what produced the
/// stuck-at-99 behaviour this project already fixed once, and a redesign is
/// exactly the moment that regression sneaks back in.
struct RenderProgressRing: View {
    @ObservedObject var timeline: StageTimeline
    let progress: Int
    /// The source clip's frame, in memory. Present on the launch that picked the
    /// clip and nil on every reload after it.
    var thumbnail: UIImage? = nil
    /// The PERSISTED frame. Survives relaunch and row recycling, which the
    /// UIImage does not, and is what keeps the container from being empty for
    /// most of a render's life.
    var thumbnailUrl: String? = nil
    var subMessage: String? = nil
    var finishing: Bool = false
    var onCancel: (() -> Void)? = nil

    @StateObject private var trickle = TrickleProgress()
    @State private var showCancelConfirm = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Large enough to be the subject of the message. 9:16, the shape of the
    /// footage people actually bring, so a vertical clip fills it rather than
    /// being cropped to fit a frame of some other proportion.
    @Environment(\.horizontalSizeClass) private var hSize

    /// THE RENDER CONTAINER IS THE COLUMN, NOT A PHONE OUTLINE (ruled
    /// 2026-09-05). 208pt is a phone frame; in an 820pt conversation column it
    /// read as a little portrait rectangle floating on the left. On iPad it
    /// takes the column width and stands 480pt tall, with the source thumbnail
    /// filling it and the trace drawn around it — the same box the finished
    /// video lands in, so in-progress → finished does not jump.
    private var frameWidth: CGFloat {
        hSize == .regular ? ThreadColumn.maxWidth - ThreadColumn.videoInset : 208
    }
    private var frameHeight: CGFloat {
        hSize == .regular ? ThreadColumn.videoHeight : frameWidth * 16 / 9
    }
    private let corner: CGFloat = 26

    private var activeStage: PipelineStage? {
        if let did = timeline.currentDerivedId, let s = timeline.stages.first(where: { $0.id == did }) { return s }
        if let cid = timeline.currentStageId, let s = timeline.stages.first(where: { $0.id == cid }) { return s }
        return nil
    }

    /// ONE line. THE LOCAL CATALOG STAGE WINS; the server's message is the
    /// fallback. This ordering used to be the other way round, and inverting it
    /// is the difference between the plain-language pass being visible and being
    /// decorative.
    ///
    /// WHY. `EditorView` assigns `stepMessage` straight from the SSE frame
    /// (EditorView.swift:3483, `messages[i].stepMessage = event.message`). That
    /// string is composed on the SERVER, so it is (a) not in the String Catalog
    /// and therefore ENGLISH FOR EVERY USER IN EVERY LANGUAGE, and (b) untouched
    /// by the rewrite that turned "Final encode" into "Almost done". With the
    /// old ordering it won on every frame the server sent, which is most of a
    /// render — so seventeen rewritten, translated stage names were the branch
    /// almost nobody reached. I nearly shipped a pass that changed nothing.
    ///
    /// The trade is specificity for correctness, and it is worth taking: the
    /// stage catalog is driven by the same token feed, so it tracks the same
    /// progress at slightly coarser grain, and it is translated. A more precise
    /// sentence in a language the reader does not speak is not more precise.
    ///
    /// The server message still shows when no stage is active — early frames
    /// before the first token, and the ask-back pause — where it is the only
    /// thing we have and English beats blank.
    ///
    /// SERVER-SIDE COPY IS A SEPARATE FIX and is Builder's: those strings need
    /// the same plain-language pass, and they can never be translated from here.
    private var line: String {
        if let s = activeStage { return s.title }
        if let m = subMessage, !m.isEmpty { return m }
        return String(localized: "Getting started…")
    }

    private var traceValue: Double { min(max(trickle.displayed / 100.0, 0), 1) }

    var body: some View {
        // LEFT-ALIGNED, MESSAGE-WIDTH. It reads as a message because it sits
        // where a message sits — not because it is in the thread, which it
        // already was. Centering it full-width was the whole problem: every
        // other assistant bubble hangs off the leading edge, so a centered block
        // spanning the full width is the one shape in the conversation that
        // belongs to no speaker, which is exactly how a modal looks.
        VStack(alignment: .leading, spacing: 16) {
            ZStack {
                frameContent
                    .frame(width: frameWidth, height: frameHeight)
                    .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
                    // Held slightly back while working so the trace reads as the
                    // live element; full strength at the finish.
                    .opacity(finishing ? 1.0 : 0.88)

                // The unfilled track. Faint — it should suggest the path without
                // competing with the progress itself.
                FrameTrace(cornerRadius: corner + 3)
                    .stroke(Color.white.opacity(0.12), lineWidth: 3)
                    .frame(width: frameWidth + 6, height: frameHeight + 6)

                FrameTrace(cornerRadius: corner + 3)
                    .trim(from: 0, to: traceValue)
                    .stroke(Color.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .frame(width: frameWidth + 6, height: frameHeight + 6)
                    .animation(reduceMotion ? nil : .linear(duration: 0.12), value: traceValue)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(line))
            .accessibilityValue(Text("\(Int(trickle.displayed))%"))

            Text(line)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(.white.opacity(0.9))
                // ONE line, and it never truncates mid-word into an ellipsis:
                // these are short catalog titles that fit, and the scale floor
                // absorbs the longest translations rather than cutting them.
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: 208, alignment: .leading)
                .id(line)
                .transition(.opacity)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: line)

            if let onCancel, timeline.isCancellable {
                Button(role: .destructive) { showCancelConfirm = true } label: {
                    Text("Stop making this")
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.4))
                }
                .confirmationDialog(String(localized: "Stop making this video?"),
                                    isPresented: $showCancelConfirm, titleVisibility: .visible) {
                    Button(String(localized: "Stop making it"), role: .destructive) { onCancel() }
                    Button(String(localized: "Keep going"), role: .cancel) {}
                } message: {
                    Text("This stops your video before it starts. It won't count against today's free one.")
                }
            }
        }
        // Hug the content and hang off the LEADING edge, like every other
        // assistant bubble. Not maxWidth: .infinity — that stretched the block
        // across the thread and centered it.
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 8)
        // Driven EXACTLY as PipelineProgressView drives it. Copying the contract
        // rather than inventing a trace-specific one is the point: the
        // presentation changed twice now, the progress semantics have not.
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

    /// In-memory frame first, persisted URL second, and a quiet ground last.
    /// The ground is deliberately plain — no icon, no "no preview" label. A
    /// placeholder graphic in a container this large would announce a missing
    /// image; an empty tone just reads as a frame that has not painted yet.
    @ViewBuilder private var frameContent: some View {
        if let t = thumbnail {
            Image(uiImage: t).resizable().aspectRatio(contentMode: .fill)
        } else if let u = thumbnailUrl, let url = URL(string: u) {
            AsyncImage(url: url) { phase in
                if case .success(let img) = phase {
                    img.resizable().aspectRatio(contentMode: .fill)
                } else {
                    Color.white.opacity(0.05)
                }
            }
        } else {
            Color.white.opacity(0.05)
        }
    }
}
