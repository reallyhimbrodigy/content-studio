#if DEBUG
import SwiftUI

/// DEBUG-only snapshot harness for the §6 payoff + paywall-copy review.
///
/// Standing law: presentations proven by presentations. Zac reviews every visual
/// change as a delivered screenshot, so this renders the REAL views (MessageBubble,
/// PaywallView, TrialWallView) with mock data and lets an external
/// `xcrun simctl io booted screenshot` capture each state.
///
/// Launch with:  -snapshotPayoff YES -snapshotState N
///   N = 0  §6 result  (video + post package + Share hero)
///       1  failure card (credit note + one-tap retry)
///       2  paywall (feature list — copy audit)
///       3  upgrade wall (trial-wall bullets — copy audit)
///
/// Never compiled into Release; no effect without the launch argument.
struct PayoffSnapshotHarnessView: View {
    private var state: Int { Int(UserDefaults.standard.string(forKey: "snapshotState") ?? "0") ?? 0 }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch state {
            case 1: labeled("FAILURE — credit note + one-tap retry") { failureBubble }
            case 2: PaywallView(isPresented: .constant(true), reason: .manual)
            case 3: TrialWallView(context: .door, onPassed: {})
            default: labeled("§6 RESULT — video · post package · Share hero") { resultBubble }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func labeled<V: View>(_ title: String, @ViewBuilder _ content: () -> V) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.gray)
                content()
                Spacer(minLength: 40)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var resultBubble: some View { MessageBubble(message: Self.completedMock) }
    private var failureBubble: some View {
        MessageBubble(message: Self.failedMock, onRetry: {}, onMakeAnother: {})
    }

    static var completedMock: ChatMessage {
        var m = ChatMessage(role: .assistant, content: "Here's your edit — captioned and paced for the scroll.")
        m.jobId = "snapshot-demo"
        m.jobStatus = "completed"
        // A non-amazonaws/supabase host reads as CDN-ready (isStreamingReadyUrl),
        // so the video tile + Share hero render at full opacity, not dimmed.
        m.renderedVideoUrl = "https://cdn.usepromptly.app/demo.mp4"
        m.thumbnailUrl = "https://cdn.usepromptly.app/demo.jpg"
        m.originalVibe = "clean and engaging"
        m.postPackage = PostPackage(
            editRationale: "I tightened the intro and held on your reveal at 0:14 so the punchline lands. For a fuller edit — more B-roll and zooms — a slightly longer take gives me more to work with.",
            postCaption: "Behind every launch is a spreadsheet nobody saw #startup #buildinpublic",
            postHook: "Nobody talks about the spreadsheet."
        )
        return m
    }

    static var failedMock: ChatMessage {
        var m = ChatMessage(role: .assistant, content: "")
        m.jobId = "snapshot-fail"
        m.jobStatus = "failed"
        m.error = "That render didn't finish. Give it another go."
        m.isRetryable = true
        m.cachedSourceUrl = "https://cdn.usepromptly.app/source.mp4"
        m.cachedVibe = "clean and engaging"
        return m
    }
}
#endif
