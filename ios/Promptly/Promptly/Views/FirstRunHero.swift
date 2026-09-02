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
    /// Open the picker to upload the user's own clip.
    let onUpload: () -> Void
    /// Put a starting instruction in the composer and focus it.
    var onPrompt: (String) -> Void = { _ in }
    /// Conversion item 7 — "Hey [name]," one line, real warmth, costs nothing.
    /// nil (no display name — email-OTP users often have none) → no greeting
    /// line at all, never a hollow "Hey there".
    var greetName: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            VStack(alignment: .leading, spacing: 0) {
                if let name = greetName {
                    Text("Hey \(name),")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.secondary)
                        .padding(.bottom, 6)
                }

                Text("What are we making?")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 18)

                // THREE ROWS, EQUAL WEIGHT. The upload is still first because it
                // is still the thing most people came to do — but it is a row,
                // not a billboard, so the other two are discoverable instead of
                // being drowned by it.
                actionRow(icon: "video.badge.plus",
                          title: String(localized: "Upload a video"),
                          action: onUpload)
                actionRow(icon: "scissors",
                          title: String(localized: "Cut a long video into clips")) {
                    onPrompt(String(localized: "Cut this into short clips for social"))
                }
                actionRow(icon: "captions.bubble",
                          title: String(localized: "Add captions and graphics")) {
                    onPrompt(String(localized: "Add captions and graphics"))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(.secondary)
                    .frame(width: 22, alignment: .center)
                Text(title)
                    .font(.system(size: 16))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    // Wrap, never clip — the same rule the old subtitle broke at
                    // 375pt.
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
