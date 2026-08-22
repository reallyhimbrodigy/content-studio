import SwiftUI

/// First-run / empty-chat hero: the upload-first prompt shown whenever a chat has no
/// messages yet (first run OR a return visit to an empty chat).
///
/// Copy law (§4.2): honest and confident. Any video works; talking-head clips with
/// clear audio are where Promptly shines; up to 5 minutes. No narrow rules, no
/// rejection-implying hedges — the server-side routing/zero-reject work removed the
/// old cliff, so the copy stops apologising for it.
///
/// (The first-run sample-clip "Watch Promptly edit this" demo was removed — a stale
/// pre-render is a poor first impression; this upload-first hero is the whole hero now.)
///
/// Deliberately UIKit-free in the body (haptics live in the caller's closures) so it
/// renders standalone in the snapshot harness.
struct FirstRunHero: View {
    /// Open the picker to upload the user's own clip.
    let onUpload: () -> Void
    /// Conversion item 7 — "Hey [name]," one line, real warmth, costs nothing.
    /// nil (no display name — email-OTP users often have none) → no greeting
    /// line at all, never a hollow "Hey there".
    var greetName: String? = nil

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            uploadBody
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    private var uploadBody: some View {
        VStack(spacing: 0) {
            Image(systemName: "video.badge.plus")
                .font(.system(size: 56, weight: .thin))
                .foregroundStyle(.secondary)
                .padding(.bottom, 22)

            if let name = greetName {
                Text("Hey \(name),")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.bottom, 4)
            }

            Text("Upload a talking head video")
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 36)
                .padding(.bottom, 8)

            Text("Promptly cuts it, captions it, and matches your vibe.")
                .font(.system(size: 15))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
                .padding(.bottom, 28)

            Button(action: onUpload) {
                Text("Upload Video")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 220, height: 48)
            }
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(.black)
            .controlSize(.large)

            Text("Any video works — up to 5 minutes. We'll notify you the moment it's ready.")
                .font(.system(size: 13))
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 44)
                .padding(.top, 16)
        }
    }
}
