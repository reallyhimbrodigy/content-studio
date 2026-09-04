import SwiftUI

/// THE CREDIT MARK — one component, every surface that shows a balance.
///
/// There were three. The chat header badge, the composer strip and the top-up
/// screen each drew their own `bolt.fill`: one with a cool blue gradient and a
/// glow, one flat white at 55% opacity, one blue-gradient again at a third
/// size. Three treatments of the same idea, which is how a currency stops
/// reading as a currency — the user has no single object to recognise, so the
/// number in the header and the number on the purchase screen look like they
/// are counting different things.
///
/// It is the RUNNER, not a system bolt, and that is the substantive part. A
/// bolt is SF Symbols' generic "energy" glyph; it appears in a hundred other
/// apps and says nothing about whose credits these are. The runner is the mark
/// on the paywall, the auth screen and the onboarding flow, so a balance now
/// carries the same identity as the thing being sold.
///
/// PURPLE, the funnel accent — the colour of the buy CTA, the selected pack,
/// the reveal and the invite rung. Cool blue was chosen to sit quietly beside
/// the gold Upgrade pill; the accent is the better answer because it links the
/// balance to the action that refills it.
///
/// MUTED AT ZERO, NEVER SWAPPED. An empty balance dims — the way an empty
/// wallet is still a wallet. It does not become a slashed or crossed-out
/// variant: nothing is broken when a user spends what they bought, and an
/// error-shaped glyph would collide with the genuine failure states in the
/// thread below.
/// A TOKEN, NOT A FLOATING SYMBOL. The mark sits in a filled disc, so the
/// balance reads as a thing you HOLD some of rather than an icon decorating a
/// number. That is the whole difference between a currency and a status glyph,
/// and it is why the disc is here and not a larger runner: scale makes a symbol
/// louder, containment makes it an object.
///
/// The disc is the accent at low opacity — present enough to bound the mark,
/// quiet enough that the header does not grow a second button. It carries the
/// muting too, so a spent balance recedes as one object instead of a dim runner
/// inside a bright coin.
struct CreditMark: View {
    /// The TOKEN's diameter. The glyph is inset within it, so call sites size
    /// the object they are placing rather than the artwork inside it.
    var size: CGFloat = 22
    /// Zero, not unknown. An unread balance must not dim — see every
    /// "silent when unknown" rule on the surfaces that host this.
    var isSpent: Bool = false

    static let accent = Color(hex: "6C5CE7")

    /// 0.7, checked against a render rather than picked. At 0.5 the accent on
    /// black stopped reading as "receded" and started reading as "disabled" —
    /// a greyed-out control beside a full-strength number says the balance is
    /// broken rather than spent.
    private var strength: Double { isSpent ? 0.7 : 1 }

    var body: some View {
        ZStack {
            Circle().fill(Self.accent.opacity(0.16 * strength))
            Circle().strokeBorder(Self.accent.opacity(0.30 * strength), lineWidth: 1)
            Image("PromptlyLogo")
                // TEMPLATE, so the mark takes the accent. The asset ships with
                // an `original` rendering intent for the places that want the
                // full logo; here it is a glyph and has to tint.
                .renderingMode(.template)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: size * 0.54, height: size * 0.54)
                .foregroundColor(Self.accent.opacity(strength))
        }
        .frame(width: size, height: size)
    }
}

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
        // THE .task MUST HANG OFF THE ALWAYS-PRESENT CONTAINER, not off the
        // inner HStack. It used to sit inside the `if`, which made this view
        // structurally incapable of ever drawing: the branch needs
        // `videosRemaining != nil`, that needs `balance != nil`, and `balance`
        // is only ever set by `refresh()` — the very call the branch was
        // gating. balance starts nil, so the condition was false forever, the
        // .task never ran, and nothing ever set balance. A permanent
        // self-deadlock that looks exactly like "the flag is off".
        //
        // It would have shipped invisible and been debugged as a server
        // problem. The fix is placement, not logic: read first, then decide
        // whether to draw.
        Group {
            if onboarding.creditsEnabled, let videos = credits.videosRemaining {
                HStack(spacing: 6) {
                    CreditMark(size: 18, isSpent: videos == 0)
                    Text("\(videos) videos left")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white.opacity(0.55))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .accessibilityElement(children: .combine)
            }
        }
        // Gated on the FLAG only. An unconditional read would call RevenueCat
        // on every composer appearance for the 100% of users the experiment is
        // dark for.
        .task {
            guard onboarding.creditsEnabled else { return }
            await credits.refresh()
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
            Text("\(amount) credits back. That video didn't count.")
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
