import SwiftUI
import StoreKit

/// Beat 5 — THE REVEAL. "Building your studio": an animated moment assembling
/// their setup from their quiz answers, ending in their personalized framing.
/// The investment peak lands here — which is exactly why the native review
/// prompt (beat 4) fires at the END of this screen: after the quiz, before
/// the wall, at maximum good-will (Cal AI's documented placement).
struct BuildingStudioView: View {
    let answers: OnboardingState.QuizAnswers
    let onComplete: () -> Void

    @State private var visibleRows = 0
    @State private var done = false
    @Environment(\.requestReview) private var requestReview

    private var rows: [(icon: String, text: String)] {
        var r: [(String, String)] = []
        if let c = answers.creates { r.append(("video.fill", "Tuned for \(c.lowercased())")) }
        if let p = answers.platform, p != "Not posting yet" {
            r.append(("square.grid.2x2.fill", "Framed for \(p)"))
        } else {
            r.append(("square.grid.2x2.fill", "Framed for short-form"))
        }
        r.append(("captions.bubble.fill", "Captions styled to hold attention"))
        r.append(("film.stack.fill", "B-roll matched to what you say"))
        if let g = answers.goal { r.append(("target", g)) }
        return r
    }

    private var aspirationLine: String {
        switch answers.aspiration {
        case "Posting consistently":   return "Your studio is built for a consistent posting habit."
        case "First 1,000 followers":  return "Your studio is built to get you to 1,000 followers."
        case "First viral video":      return "Your studio is built to give every take its best shot."
        case "Content is my job":      return "Your studio is built like it's your job — because it will be."
        default:                        return "Your studio is ready."
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Text(LocalizedStringKey(done ? aspirationLine : "Building your studio…"))
                .font(.system(size: 26, weight: .heavy))
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 28)
                .animation(.easeOut(duration: 0.3), value: done)

            VStack(alignment: .leading, spacing: 16) {
                ForEach(Array(rows.enumerated()), id: \.offset) { idx, row in
                    HStack(spacing: 14) {
                        Image(systemName: idx < visibleRows ? "checkmark.circle.fill" : row.icon)
                            .font(.system(size: 20))
                            .foregroundColor(idx < visibleRows ? .green : .white.opacity(0.4))
                            .frame(width: 26)
                        Text(LocalizedStringKey(row.text))
                            .font(.system(size: 16, weight: .medium))
                            .foregroundColor(.white.opacity(idx < visibleRows ? 1.0 : 0.35))
                    }
                    .animation(.spring(response: 0.35, dampingFraction: 0.9), value: visibleRows)
                }
            }
            .padding(28)

            Spacer()

            if done {
                Button {
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    onComplete()
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
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .onAppear {
            Analytics.track("onboarding_step", props: ["step": "building_view"])
            // Rows tick in one by one; the reveal lands, then the review
            // prompt fires at the peak. requestReview is rate-limited by the
            // system (max 3/yr per user) and may silently no-op — never gate
            // flow on it.
            for i in 0..<rows.count {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.55 * Double(i + 1)) {
                    visibleRows = i + 1
                }
            }
            let total = 0.55 * Double(rows.count) + 0.5
            DispatchQueue.main.asyncAfter(deadline: .now() + total) {
                withAnimation { done = true }
                Analytics.track("onboarding_step", props: ["step": "building_done"])
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    requestReview()
                    Analytics.track("onboarding_step", props: ["step": "review_prompt_requested"])
                }
            }
        }
    }
}
