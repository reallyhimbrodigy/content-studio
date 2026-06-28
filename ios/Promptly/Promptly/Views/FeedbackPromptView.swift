import SwiftUI

/// Subtle inline feedback card shown under a completed render.
///
/// Visual language matches the assistant bubble + ProcessingIndicator:
/// ultraThinMaterial glass, a faint white wash, a 0.5pt hairline stroke,
/// and the 20pt card radius from `Theme.Radius.lg`. It's deliberately
/// quiet — it never blocks, it eases in and out, and it collapses to a
/// thin confirmation or a single text field rather than growing into a
/// modal.
///
/// Three terminal paths, each driven by a closure the parent supplies:
///   • thumbs-up  → shows "Glad you like it!" briefly, then `onThumbsUp()`
///   • thumbs-down → expands inline to an optional text field + Send,
///                   then `onThumbsDown(text)` (text may be empty)
///   • dismiss (x) → `onDismiss()`
///
/// The parent owns placement and wiring (e.g. CompletedVideoView) — this
/// view knows nothing about the network, FeedbackManager, or job ids.
struct FeedbackPromptView: View {

    // MARK: - Callbacks

    let onThumbsUp: () -> Void
    let onThumbsDown: (String) -> Void
    let onDismiss: () -> Void

    init(
        onThumbsUp: @escaping () -> Void,
        onThumbsDown: @escaping (String) -> Void,
        onDismiss: @escaping () -> Void
    ) {
        self.onThumbsUp = onThumbsUp
        self.onThumbsDown = onThumbsDown
        self.onDismiss = onDismiss
    }

    // MARK: - Local state

    /// Which inline surface is showing. `prompt` is the default
    /// thumbs/dismiss row; the other two are terminal sub-states that
    /// transition in place so the card never jumps size abruptly.
    private enum Phase {
        case prompt
        case thanks       // thumbs-up acknowledged, brief pause before onThumbsUp
        case detail       // thumbs-down expanded: optional note + Send
    }

    @State private var phase: Phase = .prompt
    @State private var note: String = ""
    @FocusState private var noteFocused: Bool

    // Gentle, consistent spring used for every phase change so the
    // card resizes/fades the same way regardless of which path fired.
    private var transitionAnimation: Animation { .easeInOut(duration: 0.28) }

    // MARK: - Body

    var body: some View {
        content
            .padding(.horizontal, Theme.Space.md)
            .padding(.vertical, Theme.Space.sm)
            .frame(maxWidth: 320, alignment: .leading)
            .background(
                // Same soft glass as the assistant bubble: material +
                // a barely-there white wash so it sits a hair above the
                // page without competing with the video above it.
                ZStack {
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .fill(.ultraThinMaterial)
                    RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                        .fill(Color.white.opacity(0.03))
                }
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.06), lineWidth: 0.5)
            )
            .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous))
            .animation(transitionAnimation, value: phase)
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .prompt:  promptRow
        case .thanks:  thanksRow
        case .detail:  detailColumn
        }
    }

    // MARK: - Prompt (default)

    private var promptRow: some View {
        HStack(spacing: Theme.Space.sm) {
            Text("Happy with this edit?")
                .font(Theme.Font.body)
                .tracking(0.2)
                .foregroundColor(.white)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: Theme.Space.xs)

            ratingButton(systemName: "hand.thumbsup", label: "Yes, I like this edit") {
                withAnimation(transitionAnimation) { phase = .thanks }
                // Hold the confirmation briefly so it registers, then
                // hand control back to the parent. Non-blocking — the
                // card stays put until the parent removes it.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.1) {
                    onThumbsUp()
                }
            }

            ratingButton(systemName: "hand.thumbsdown", label: "No, this could be better") {
                withAnimation(transitionAnimation) { phase = .detail }
                // Defer focus until after the field has animated in so
                // the keyboard doesn't fight the transition.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    noteFocused = true
                }
            }

            dismissButton
        }
        .transition(.opacity)
    }

    // MARK: - Thumbs-up confirmation

    private var thanksRow: some View {
        HStack(spacing: Theme.Space.xs) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 15, weight: .regular))
                .foregroundColor(.white)

            Text("Glad you like it!")
                .font(Theme.Font.body)
                .tracking(0.2)
                .foregroundColor(.white)

            Spacer(minLength: 0)
        }
        .transition(.opacity)
    }

    // MARK: - Thumbs-down detail

    private var detailColumn: some View {
        VStack(alignment: .leading, spacing: Theme.Space.sm) {
            HStack(spacing: Theme.Space.xs) {
                Text("What would make it better?")
                    .font(Theme.Font.body)
                    .tracking(0.2)
                    .foregroundColor(.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: Theme.Space.xs)

                dismissButton
            }

            // Optional note. Plain rounded field on the deepest surface
            // wash so it reads as inset within the glass card.
            TextField("", text: $note, prompt: notePlaceholder, axis: .vertical)
                .font(Theme.Font.body)
                .foregroundColor(.white)
                .tint(.white)
                .focused($noteFocused)
                .lineLimit(1...4)
                .submitLabel(.send)
                .onSubmit(send)
                .padding(.horizontal, Theme.Space.sm)
                .padding(.vertical, Theme.Space.xs)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
                )

            // Send is always enabled — the note is optional, so even an
            // empty thumbs-down is a useful signal.
            Button(action: send) {
                Text("Send")
                    .font(Theme.Font.bodyMedium)
                    .tracking(0.2)
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Theme.Space.sm)
                    .background(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .fill(Color.white.opacity(0.12))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
                    )
            }
            .buttonStyle(.plain)
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    private var notePlaceholder: Text {
        Text("What would make it better? (optional)")
            .foregroundColor(.white.opacity(0.4))
    }

    // MARK: - Shared controls

    /// Circular ghost button used for both thumb ratings. Tappable
    /// affordance is the full circle, not just the glyph.
    private func ratingButton(
        systemName: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .regular))
                .foregroundColor(.white)
                .frame(width: 34, height: 34)
                .background(
                    Circle().fill(Color.white.opacity(0.08))
                )
                .overlay(
                    Circle().strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var dismissButton: some View {
        Button(action: onDismiss) {
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(.secondary)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Dismiss feedback")
    }

    // MARK: - Actions

    private func send() {
        noteFocused = false
        let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
        onThumbsDown(trimmed)
    }
}

#if DEBUG
#Preview("Feedback prompt") {
    ZStack {
        Color.black.ignoresSafeArea()
        FeedbackPromptView(
            onThumbsUp: { print("up") },
            onThumbsDown: { print("down: \($0)") },
            onDismiss: { print("dismiss") }
        )
        .padding()
    }
}
#endif
