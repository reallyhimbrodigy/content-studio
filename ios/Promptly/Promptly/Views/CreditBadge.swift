import SwiftUI

/// The credit balance as a CURRENCY you hold, not a counter running down.
///
/// THE DIFFERENCE IS THE WHOLE DESIGN. A counter invites you to watch it fall:
/// red states, "running low" warnings, a depleting bar. Every one of those tells
/// a paying user they are nearly out of something, on every screen, all session
/// — which makes the product feel like a meter rather than a tool. So there are
/// no thresholds here and no colour changes with value. The number is the same
/// object at 4 as at 400.
///
/// THE BOLT IS AN OBJECT, NOT AN ICON. It carries a cool gradient and a faint
/// luminance of its own, so it reads as a minted thing you have some of. The
/// glow is on the GLYPH only — a glowing pill would be a second Upgrade button,
/// and the gold pill next to it is already the loud one. Cool against that gold
/// on purpose: the two sit beside each other without competing, and the eye
/// still reaches the composer first.
///
/// SILENT WHEN UNKNOWN, and this rule does not bend. `balance == nil` means we
/// have not read one — the call failed, or there is no account yet. It does NOT
/// mean zero. The badge simply does not draw, because rendering "0" from an
/// unread balance would tell a paying user they have nothing left, and this
/// project has already paid once for treating an unreadable metric as a
/// confident zero.
struct CreditBadge: View {
    /// Tapping a balance is the natural moment to want MORE of that balance, so
    /// it opens the top-up screen rather than the subscription paywall. Someone
    /// checking what they hold is asking to add to it; answering with a plan
    /// comparison is answering a question they did not ask.
    var onTap: () -> Void = { AppState.shared.showCredits = true }

    @ObservedObject private var credits = CreditsService.shared
    @ObservedObject private var onboarding = OnboardingState.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The value the badge is currently showing. Tracked separately from the
    /// service so the view can animate BETWEEN two known values rather than
    /// snapping to whatever arrived — an animation needs a before and an after,
    /// and `@Published` only ever gives you the after.
    @State private var shown: Int?
    @State private var pulse = false
    @State private var refunding = false

    var body: some View {
        Group {
            if onboarding.creditsEnabled, let value = shown {
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    onTap()
                } label: {
                    HStack(spacing: 5) {
                        mark(spent: value == 0)
                        Text(value, format: .number)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(.white.opacity(value == 0 ? 0.45 : 0.92))
                            .monospacedDigit()   // width must not jitter as digits change
                            .contentTransition(.numericText(countsDown: !refunding))
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    // The PILL stays neutral and flat. No glow, no gradient —
                    // the glyph carries the identity.
                    //
                    // ZERO DIMS, IT DOES NOT ALARM (ruled). Red is the colour of
                    // something being wrong, and nothing is wrong — the user
                    // spent what they bought, which is the currency working as
                    // intended. Dimming says SPENT: the badge recedes the way an
                    // empty wallet does, still legible, still tappable, making
                    // no accusation. An error colour here would also collide
                    // with the failure states in the thread below, where red
                    // means a render actually broke.
                    .background(Capsule().fill(Color.white.opacity(value == 0 ? 0.05 : 0.08)))
                    .overlay(Capsule().strokeBorder(Color.white.opacity(value == 0 ? 0.07 : 0.10), lineWidth: 1))
                    .opacity(value == 0 ? 0.75 : 1.0)
                    .contentShape(Capsule())
                    .scaleEffect(pulse ? 1.06 : 1.0)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("\(value) credits"))
                .accessibilityHint(Text("Get more"))
            } else {
                // A ZERO-SIZE NODE, NOT EmptyView. The condition above depends
                // on `shown`, and `shown` is only ever set by the `.task` below
                // — but a Group that resolves to EmptyView gets no node in the
                // view tree, so the task never runs, so `shown` stays nil
                // forever. The badge was invisible for that reason alone: a
                // self-deadlock, the same shape that once stopped
                // CreditBalanceStrip from ever drawing, and it does not announce
                // itself because an invisible view looks exactly like a view
                // that decided not to draw.
                Color.clear.frame(width: 0, height: 0)
            }
        }
        .task { await seed() }
        // THE FLAG CAN ARRIVE AFTER THE FIRST RENDER. `seed()` guards on
        // `creditsEnabled`, and a bare `.task` runs once — so if the server's
        // flag payload lands a moment after this view appears, the guard returns
        // and the badge stays blank until something unrelated redraws it. That
        // is indistinguishable from the badge being broken, and it is exactly
        // what happened in the simulator: the balance was set and the composer
        // strip rendered it while the header stayed empty.
        .onChange(of: onboarding.creditsEnabled) { _, on in
            if on { Task { await seed() } }
        }
        .onChange(of: credits.balance) { old, new in apply(old: old, new: new) }
    }

    /// Read the balance and show it without animating — the first read is not a
    /// change, and animating it would show a decrement from nothing on launch.
    private func seed() async {
        guard onboarding.creditsEnabled else { return }
        await credits.refresh()
        shown = credits.balance
    }

    /// THE SHARED MARK, with this surface's refund flare on top.
    ///
    /// It was its own `bolt.fill` with a bespoke blue gradient — one of three
    /// different credit glyphs in the app. The GLYPH now comes from
    /// `CreditMark`, so the header, the composer strip and the top-up screen
    /// show the same object; what stays local is the ANIMATION, which is about
    /// this badge's job rather than about what a credit looks like.
    ///
    /// The bloom is on the glyph ALONE — a glowing pill would be a second
    /// Upgrade button, and the gold pill beside it is already the loud one.
    private func mark(spent: Bool) -> some View {
        CreditMark(size: 20, isSpent: spent)
            .shadow(color: CreditMark.accent.opacity(refunding ? 0.9 : 0.35),
                    radius: refunding ? 6 : 3)
            .scaleEffect(refunding ? 1.3 : 1.0)
    }

    /// Animate from the old value to the new one, in the direction that actually
    /// happened.
    ///
    /// THE TWO DIRECTIONS ARE DELIBERATELY NOT SYMMETRIC. A decrement is the
    /// product taking something the user agreed to spend — it should be quiet,
    /// or it reads as the app making a fuss about charging you. A refund is the
    /// product giving something back after failing, which is the moment a user
    /// is most likely to feel cheated, so it is the one thing here allowed to be
    /// visible and slightly satisfying. Same magnitude of change, opposite
    /// emotional weight.
    private func apply(old: Int?, new: Int?) {
        guard let new else { return }          // never animate INTO unknown
        guard let old, old != new else { shown = new; return }

        if new < old {
            // Spend: a small pulse, nothing more.
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                shown = new
                pulse = true
            }
            withAnimation(reduceMotion ? nil : .easeIn(duration: 0.22).delay(0.18)) {
                pulse = false
            }
        } else {
            // Refund: the bolt flares and holds long enough to be noticed by
            // someone who was looking at the failure message, not the header.
            withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.6)) {
                shown = new
                refunding = true
                pulse = true
            }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.45).delay(0.9)) {
                refunding = false
                pulse = false
            }
        }
    }
}
