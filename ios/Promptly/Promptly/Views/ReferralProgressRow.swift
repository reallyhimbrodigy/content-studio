import SwiftUI

/// The referral entry point: what you have earned so far, and one tap to share.
///
/// THE GAP THIS CLOSES. Sharing was already reachable from four surfaces — the
/// ambient wall, the abandon overlay, the post-render card and the second
/// paywall — but PROGRESS was rendered on exactly one of them. So a user who
/// successfully referred someone saw nothing on three of the four places they
/// would look. The loop was working and looked broken, which is worse than
/// broken: they stop sharing, and the reason never appears in any funnel because
/// nothing failed.
///
/// So progress and the share action ship as ONE component. A surface cannot
/// adopt the button and forget the count, which is exactly how they drifted
/// apart the first time.
///
/// THE COUNT IS SERVER-TRUTH, NEVER LOCAL TAPS. `qualifiedCount` comes from
/// `refreshProgress()`, which reads rows where the referred friend actually
/// completed a render (`qualified_at != nil`). A user who shared five times and
/// had nobody join sees 0 — because that is what they have earned. Counting
/// shares would show 5 and promise a reward that is not coming, which is the
/// one number this surface must never invent.
struct ReferralProgressRow: View {
    /// Where this instance lives, for the impression and share events. The
    /// existing sources are ambient_wall / abandon / postrender / paywall2.
    let source: String
    /// Compact drops the reward line — for surfaces with a single row of space.
    var compact: Bool = false
    /// What the first line says.
    ///
    /// `.progress` leads with the count ("2 of 3 friends joined") — right for a
    /// surface someone returns to. `.invite` leads with the OFFER, for a
    /// surface meeting someone who has not shared yet: "0 of 3 friends joined"
    /// as an opening line states a failure before it states a reason to act.
    var style: Style = .progress
    /// Drop the container. On a surface where nothing else has a box — the
    /// paywall, where the only rounded element is the Continue button — a
    /// rounded card around this row is the one thing that looks pasted on.
    var chromeless: Bool = false

    enum Style { case progress, invite }

    @ObservedObject private var referrals = ReferralService.shared
    @ObservedObject private var onboarding = OnboardingState.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var count: Int { referrals.qualifiedCount }

    /// The offer leads until there is progress worth leading with.
    private var headline: String {
        if isComplete { return ReferralCopy.progressComplete }
        if style == .invite && count == 0 { return ReferralCopy.inviteOffer }
        return ReferralCopy.progress(count, target: target)
    }
    private var target: Int { ReferralService.rewardTarget }
    private var isComplete: Bool { count >= target }

    var body: some View {
        if referrals.shouldOffer { row }
    }

    private var row: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task { await referrals.presentShareSheet(source: source) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    // The count leads. It is the thing that changed since last
                    // time, and the reason to look.
                    Text(headline)
                        .cType(15, .semibold)
                        .foregroundColor(.white)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)

                    if !compact && !isComplete {
                        Text(ReferralCopy.progressReward)
                            .cType(13)
                            .foregroundColor(.white.opacity(0.6))
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    // Pips appear once there is progress to show. Three empty
                    // marks under an invitation is a picture of having done
                    // nothing, shown to someone being asked to start.
                    if !isComplete && (style == .progress || count > 0) {
                        pips
                            .padding(.top, 4)
                    }
                }
                Spacer(minLength: 8)
                // ONE TAP. The whole row is the button and it opens the system
                // share sheet directly — no intermediate screen, no explanation
                // step. An explanation step is where a share loop goes to die:
                // it adds a decision to an action the user already decided on.
                Image(systemName: "square.and.arrow.up")
                    .cType(17, .semibold)
                    .foregroundColor(.white.opacity(0.85))
            }
            .padding(.horizontal, chromeless ? 0 : 14)
            .padding(.vertical, chromeless ? 4 : 12)
            .background(
                Group {
                    if !chromeless {
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color.white.opacity(0.06))
                    }
                }
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(headline))
        .accessibilityHint(Text(ReferralCopy.shareAction))
        .task {
            // Read the server on every appearance. A count cached from the last
            // launch is the failure this surface exists to fix — the user opens
            // the app precisely because a friend just joined.
            await referrals.refreshProgress()
            referrals.trackImpression(source: source)
        }
    }

    /// Three pips rather than a bar. At a target of three, a progress bar reads
    /// as a rounding error at 33% and a bar cannot show WHICH step you are on;
    /// three discrete marks say "two done, one to go" without any text.
    private var pips: some View {
        HStack(spacing: 5) {
            ForEach(0..<target, id: \.self) { i in
                Capsule()
                    .fill(i < count ? Color.white : Color.white.opacity(0.18))
                    .frame(width: 18, height: 4)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: count)
            }
        }
        .accessibilityHidden(true)   // the label above already says it in words
    }
}
