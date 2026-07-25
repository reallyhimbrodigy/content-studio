import SwiftUI

/// First-run hero for an empty chat (1.3.3 first-render conversion pass, §4).
///
/// Two modes, one component so the shipped surface and the review screenshots are
/// the SAME code:
///   • `.demo`       — first run with the sample-clip demo available. Leads with
///                     "Watch Promptly edit this": a felt success on a real clip
///                     BEFORE the user risks their own footage (the single biggest
///                     activation lever — most users never reach a finished render).
///                     Uploading your own is demoted to a quiet secondary.
///   • `.uploadOnly` — return visits, or the demo not yet enabled by the server.
///                     The upload-first hero, with the honest+confident copy.
///
/// Copy law (§4.2): honest and confident. Any video works; talking-head clips with
/// clear audio are where Promptly shines; up to 5 minutes. No narrow rules, no
/// rejection-implying hedges — the server-side routing/zero-reject work removed the
/// old cliff, so the copy stops apologising for it.
///
/// Deliberately UIKit-free in the body (haptics live in the caller's closures) so it
/// renders standalone in the snapshot harness for Zac's before/after review.
struct FirstRunHero: View {
    enum Mode { case demo, uploadOnly }

    let mode: Mode
    /// Fire the sample-clip demo (only meaningful in `.demo`).
    var onWatchDemo: () -> Void = {}
    /// Open the picker to upload the user's own clip.
    let onUpload: () -> Void

    // Brand gold — matches AskCard's sparkle accent (Color(red:1, green:0.82, blue:0.5)).
    private static let gold = Color(red: 1.0, green: 0.82, blue: 0.5)
    private static let goldDeep = Color(red: 1.0, green: 0.70, blue: 0.36)
    private var goldGradient: LinearGradient {
        LinearGradient(colors: [Self.gold, Self.goldDeep],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            switch mode {
            case .demo:      demoBody
            case .uploadOnly: uploadBody
            }
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    // MARK: - Demo-first (the activation lever)

    private var demoBody: some View {
        VStack(spacing: 0) {
            // Glyph: a play mark ringed in gold — reads as "watch", not "upload".
            ZStack {
                Circle()
                    .strokeBorder(goldGradient, lineWidth: 2)
                    .frame(width: 84, height: 84)
                Image(systemName: "play.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(goldGradient)
                    .offset(x: 3) // optical-center the triangle in the ring
            }
            .padding(.bottom, 24)

            Text("Watch Promptly edit a real clip")
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(.white)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .padding(.bottom, 10)

            Text("See a talking-head video get cut, captioned,\nand color-matched — start to finish.")
                .font(.system(size: 15))
                .foregroundStyle(.white.opacity(0.6))
                .multilineTextAlignment(.center)
                .lineSpacing(2)
                .padding(.horizontal, 36)
                .padding(.bottom, 30)

            // Primary: the demo. Gold, unmissable.
            Button(action: onWatchDemo) {
                HStack(spacing: 9) {
                    Image(systemName: "play.fill").font(.system(size: 15, weight: .bold))
                    Text("Watch Promptly edit this").font(.system(size: 16, weight: .semibold))
                }
                .foregroundStyle(.black)
                .frame(height: 52)
                .frame(maxWidth: .infinity)
                .background(Capsule().fill(goldGradient))
                .padding(.horizontal, 44)
            }
            .buttonStyle(.plain)

            // Secondary: your own footage, quiet.
            Button(action: onUpload) {
                Text("Or upload your own")
                    .font(.system(size: 15, weight: .medium))
                    .foregroundStyle(.white.opacity(0.72))
                    .padding(.vertical, 14)
            }
            .buttonStyle(.plain)

            Text("Any video works. Talking-head clips with clear\naudio shine. Up to 5 minutes.")
                .font(.system(size: 12.5))
                .foregroundStyle(.white.opacity(0.34))
                .multilineTextAlignment(.center)
                .lineSpacing(1)
                .padding(.horizontal, 40)
                .padding(.top, 4)
        }
    }

    // MARK: - Upload-first (return visits / demo off)

    private var uploadBody: some View {
        VStack(spacing: 0) {
            Image(systemName: "video.badge.plus")
                .font(.system(size: 56, weight: .thin))
                .foregroundStyle(.secondary)
                .padding(.bottom, 22)

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
