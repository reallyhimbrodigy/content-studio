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
/// THE APPROVED VIBES, in one place.
///
/// The composer's chip row carried its own list — "Viral engaging video",
/// "Professional corporate style", "Fast paced punchy" — as bare, unlocalized
/// literals, so the same screen offered one set of vibes in its empty state
/// and a different set above the composer the moment a render finished, and
/// the second set was English in every language. Two lists of the same thing
/// drift; there is now one.
///
/// "Upload a video" is deliberately not here: it is an ACTION on the empty
/// state, and a chip inserts text. Everything here is a sentence someone
/// would send.
enum VibeSuggestions {
    static var approved: [String] {
        [String(localized: "Fast cuts, big captions"),
         String(localized: "Clean and professional")]
    }
}

struct FirstRunHero: View {
    @Environment(\.conversionScale) private var k
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
        VStack(alignment: .leading, spacing: 0 * k) {
            Spacer(minLength: 0 * k)

            if let name = greetName {
                Text("Hey \(name),")
                    .font(.system(size: 14 * k))
                    .foregroundStyle(.tertiary)
                    .padding(.bottom, 10 * k)
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
            actionRow(icon: "scissors", title: VibeSuggestions.approved[0]) {
                onPrompt(VibeSuggestions.approved[0])
            }
            actionRow(icon: "sparkles", title: VibeSuggestions.approved[1]) {
                onPrompt(VibeSuggestions.approved[1])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20 * k)
        .padding(.bottom, 8 * k)
        .contentShape(Rectangle())
    }

    /// One row: a small glyph, a label, nothing else. No card, no fill, no
    /// chevron — the whole row is the target and it reads as text, which is the
    /// point of the reference.
    private func actionRow(icon: String, title: String,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 12 * k) {
                Image(systemName: icon)
                    .font(.system(size: 15 * k, weight: .regular))
                    .foregroundStyle(.secondary)
                    .frame(width: 22 * k, alignment: .center)
                Text(title)
                    .font(.system(size: 16 * k))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    // Wrap, never clip — the same rule the old subtitle broke at
                    // 375pt.
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0 * k)
            }
            .padding(.vertical, 11 * k)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
