import SwiftUI

/// Balance, shown BEFORE the action.
///
/// The spec's requirement, and the difference between a meter and a surprise:
/// a user who discovers the cost after committing has been charged by ambush.
/// This sits above the composer, so the number is on screen at the moment the
/// decision is made.
///
/// SILENT WHEN UNKNOWN. `balance == nil` means we have not read one — the
/// currency code did not resolve, or the call failed. It does NOT mean zero, and
/// rendering "0 credits" from an unread balance would tell a paying user they
/// have nothing left. This project has already paid once for treating an
/// unreadable metric as a confident zero; the strip simply does not draw.
struct CreditBalanceStrip: View {
    @ObservedObject private var credits = CreditsService.shared
    @ObservedObject private var onboarding = OnboardingState.shared

    var body: some View {
        if onboarding.creditsEnabled, let videos = credits.videosRemaining {
            HStack(spacing: 6) {
                Image(systemName: "bolt.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(.white.opacity(0.55))
                Text("\(videos) videos left")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(.white.opacity(0.55))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .accessibilityElement(children: .combine)
            .task { await credits.refresh() }
        }
    }
}

/// The zero-balance block, IN THE THREAD.
///
/// Not a modal, per the ruling — and for a reason beyond taste: the user just
/// sent something, and a sheet slamming over the conversation reads as a
/// paywall ambushing them rather than as the product answering. A message in the
/// thread is the product replying in the register it always uses.
///
/// It names three things, because a block that only says "no" is a dead end:
/// what they have, when it comes back, and the way out. The refresh date is the
/// most important of those — a user who knows the meter refills in nine days
/// makes a different decision from one who thinks it is gone.
///
/// RE-EDITS STAY FREE, and the copy says so. That is the strongest argument
/// available here and the product makes it for itself: someone at zero can still
/// iterate on everything they have already made.
struct CreditsExhaustedMessage: View {
    let refreshDate: Date?
    let onSeePlans: () -> Void

    private var refreshLine: String? {
        guard let d = refreshDate else { return nil }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        f.locale = Locale(identifier: AppLanguage.current)
        return String(localized: "Your credits refresh on \(f.string(from: d))")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("You're out of credits for now")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)

            if let refreshLine {
                Text(refreshLine)
                    .font(.system(size: 14))
                    .foregroundColor(.white.opacity(0.7))
            }

            // The product's own argument, not a sales line.
            Text("Re-editing anything you've already made is still free.")
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)

            Button(action: onSeePlans) {
                Text("See plans")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.black)
                    .padding(.horizontal, 16)
                    .frame(height: 36)
                    .background(Color.white, in: Capsule())
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            Analytics.track("credits_exhausted_shown", props: ["context": "composer"])
        }
    }
}

/// The refund, rendered in the thread when the server pushes it.
///
/// VISIBLE, NOT SILENT — the spec is explicit and it is right: a silent balance
/// restore is indistinguishable from never having been charged, so the user
/// cannot tell the system did the right thing. Seeing the refund is what makes a
/// failed render feel handled rather than merely survived.
///
/// The client never performs this restore; it renders what the server reports.
struct CreditsRefundedMessage: View {
    let amount: Int

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "arrow.uturn.backward.circle.fill")
                .font(.system(size: 14))
                .foregroundColor(.green.opacity(0.8))
            Text("\(amount) credits refunded — that render didn't count")
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.8))
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            Analytics.track("credits_refund_shown", props: ["amount": amount])
        }
    }
}

/// The free tier's export gate, when the export has been SPENT.
///
/// Deliberately distinct from both a render failure and the generic paywall,
/// per the ruling. Those three look identical to a user if they share copy, and
/// this is the moment the upgrade case is strongest — the video is finished and
/// sitting there. It should read as earned, not as a wall.
///
/// Its own event, so its conversion is readable separately from the credit wall.
struct FreeExportSpentMessage: View {
    let onSeePlans: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your video is ready — you've used your free export")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(.white)
            Text("Pro and Max save and share every video, with no export limit.")
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.7))
                .fixedSize(horizontal: false, vertical: true)
            Button(action: onSeePlans) {
                Text("See plans")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.black)
                    .padding(.horizontal, 16)
                    .frame(height: 36)
                    .background(Color.white, in: Capsule())
            }
            .padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear {
            // Distinct from the credit wall's event ON PURPOSE — blending them
            // makes it impossible to tell which of the two limits is actually
            // converting, and they argue for different things.
            Analytics.track("free_export_spent_shown", props: ["context": "result"])
        }
    }
}
