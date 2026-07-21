import SwiftUI

/// Beat 6 — HONEST SOCIAL PROOF. One screen, true numbers only. We copy the
/// structure (a proof beat between the reveal and the wall), not the fiction:
/// no invented ratings, no fabricated testimonials, no "featured by." The
/// numbers here must be updatable release-to-release and TRUE at submission.
///
/// Current truth (2026-07): ~700 creators have signed up; renders complete in
/// about two minutes; the pipeline cuts, captions, and B-rolls automatically.
/// When real App Store ratings accumulate, they slot in here — not before.
struct SocialProofView: View {
    let onContinue: () -> Void

    private let facts: [(icon: String, headline: String, line: String)] = [
        ("person.2.fill", "700+ creators", "have started editing with Promptly"),
        ("clock.fill", "~2 minutes", "from raw upload to finished edit"),
        ("wand.and.stars", "Cuts · captions · B-roll", "picked for you by the AI editor"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            Text("You're in good company")
                .font(.system(size: 28, weight: .heavy))
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)

            VStack(spacing: 18) {
                ForEach(facts, id: \.headline) { f in
                    HStack(spacing: 16) {
                        Image(systemName: f.icon)
                            .font(.system(size: 22))
                            .foregroundColor(.yellow)
                            .frame(width: 34)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(f.headline)
                                .font(.system(size: 18, weight: .bold))
                                .foregroundColor(.white)
                            Text(f.line)
                                .font(.system(size: 14))
                                .foregroundColor(.white.opacity(0.6))
                        }
                        Spacer()
                    }
                    .padding(18)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                }
            }
            .padding(.horizontal, 24)
            .padding(.top, 30)

            Spacer()

            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                onContinue()
            } label: {
                Text("Continue")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(.black)
                    .frame(maxWidth: .infinity)
                    .frame(height: 54)
                    .background(Color.white, in: Capsule())
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 28)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .onAppear {
            Analytics.track("onboarding_step", props: ["step": "social_proof_view"])
        }
    }
}
