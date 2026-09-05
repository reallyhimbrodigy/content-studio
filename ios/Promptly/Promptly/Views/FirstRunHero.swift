import SwiftUI

/// The empty chat: three things you can do, stated plainly, sitting above the
/// composer.
///
/// REBUILT 2026-09-02 against the ChatGPT reference. What went, and why:
///   - the camera hero glyph — decoration that took the top third of an SE and
///     said nothing the title did not
///   - the big white Upload Video button — one loud action crowding out the two
///     other things this product does
///   - the vibe chip row — a horizontal scroller whose content ran off the edge
///     and read as clipped
///   - the "Any video works" footnote — reassurance nobody had asked for yet
///
/// What replaced them is three rows of plain text. The point of the reference
/// shape is that an empty state should offer CHOICES at equal weight rather than
/// a single shouted call to action: the user who wants to upload still uploads,
/// and the two who did not know the product could caption or re-cut now see it.
///
/// Deliberately UIKit-free in the body (haptics live in the caller's closures)
/// so it renders standalone in the snapshot harness.
struct FirstRunHero: View {
    @Environment(\.horizontalSizeClass) private var padSize
    /// Open the picker to upload the user's own clip.
    let onUpload: () -> Void
    /// Put a starting instruction in the composer and focus it.
    var onPrompt: (String) -> Void = { _ in }
    /// Conversion item 7 — "Hey [name]," one line, real warmth, costs nothing.
    /// nil (no display name — email-OTP users often have none) → no greeting
    /// line at all, never a hollow "Hey there".
    var greetName: String? = nil

    var body: some View {
        // THE EMPTY SPACE BELONGS ABOVE. One Spacer, at the top: the rows sit
        // directly on the composer at normal spacing, the way the reference
        // does it. Centred between two Spacers they floated mid-screen with a
        // gap under them, which reads as an unfinished layout on a tall device
        // and wastes the reachable area on a phone held one-handed.
        VStack(alignment: .leading, spacing: padSize == .regular ? 18 : 0) {
            Spacer(minLength: 0)

            if let name = greetName {
                Text("Hey \(name),")
                    .font(.system(size: 14))
                    .foregroundStyle(.tertiary)
                    .padding(.bottom, 10)
            }

            // NO HEADING. The reference has none, and the rows already say what
            // the screen is for — a title above them only restated it louder.
            actionRow(icon: "video.badge.plus",
                      title: String(localized: "Upload a video"),
                      action: onUpload)
            // ROWS 2 AND 3 ARE VIBES, AND THE LABEL IS THE PAYLOAD.
            //
            // They were INSTRUCTIONS, and instructions are the one thing this
            // composer cannot act on from an empty chat. "Cut a long video into
            // clips" filled the field with "Cut this into short clips for
            // social" — a different sentence from the one tapped, about a video
            // that does not exist yet, which `send()` then routes to the text
            // chat because there is nothing attached. The row named an edit and
            // produced a conversation.
            //
            // The composer's contract is a VIBE — `injectWelcomeIfEmpty` seeds
            // it from the onboarding answer for exactly that reason, "so they
            // land ON A VIBE, not a blank field". These now match that
            // contract, and the label IS the inserted text: what you tapped is
            // what you would send, so nothing is substituted behind your back.
            actionRow(icon: "scissors",
                      title: String(localized: "Fast cuts, big captions")) {
                onPrompt(String(localized: "Fast cuts, big captions"))
            }
            actionRow(icon: "sparkles",
                      title: String(localized: "Clean and professional")) {
                onPrompt(String(localized: "Clean and professional"))
            }

            // CENTRED ON A TABLET, bottom-anchored on a phone.
            //
            // The single top Spacer is right for a phone — the note above says
            // so, and it puts the choices within thumb reach. On a 1376pt iPad
            // it left 949pt of black above three cards sitting on the composer.
            // A second Spacer balances them into the middle of the screen,
            // which is where a tablet empty state reads as composed rather
            // than as content that fell to the bottom.
            if padSize == .regular { Spacer(minLength: 0) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.bottom, 8)
        .contentShape(Rectangle())
    }

    /// One row: a small glyph, a label, nothing else. No card, no fill, no
    /// chevron — the whole row is the target and it reads as text, which is the
    /// point of the reference.
    private func actionRow(icon: String, title: String,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: icon)
                    .font(.system(size: padSize == .regular ? 22 : 15, weight: .regular))
                    .foregroundStyle(.secondary)
                    .frame(width: 22, alignment: .center)
                Text(title)
                    .font(.system(size: padSize == .regular ? 24 : 16))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    // Wrap, never clip — the same rule the old subtitle broke at
                    // 375pt.
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            // CARDS ON A TABLET, rows on a phone. The same three choices at
            // the same weight — the structure does not change, the size does.
            .padding(.vertical, padSize == .regular ? 26 : 11)
            .padding(.horizontal, padSize == .regular ? 22 : 0)
            .background {
                if padSize == .regular {
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .fill(Color.white.opacity(0.06))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
