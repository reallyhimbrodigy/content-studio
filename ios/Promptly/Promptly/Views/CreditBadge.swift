import SwiftUI

/// The credit balance as an OBJECT in the chat header — a bolt in a circle,
/// always present, readable without opening anything.
///
/// WHY AN OBJECT RATHER THAN A NUMBER IN A STRIP. A number that appears only
/// when you go looking is something you check; a thing that lives in the header
/// is something you HAVE. That difference is the whole point of a meter: the
/// balance has to be on screen at the moment of the decision, not one tap away
/// behind a menu, and it has to be the same object each time so a change to it
/// reads as a change to something you recognise.
///
/// SILENT WHEN UNKNOWN, and this rule does not bend. `balance == nil` means we
/// have not read one — the currency code did not resolve, or the call failed. It
/// does NOT mean zero. The badge simply does not draw, because rendering "0"
/// from an unread balance would tell a paying user they have nothing left, and
/// this project has already paid once for treating an unreadable metric as a
/// confident zero.
struct CreditBadge: View {
    @ObservedObject private var credits = CreditsService.shared
    @ObservedObject private var onboarding = OnboardingState.shared
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The value the badge is currently showing. Tracked separately from the
    /// service so the view can animate BETWEEN two known values rather than
    /// snapping to whatever arrived — an animation needs a before and an after,
    /// and `@Published` only ever gives you the after.
    @State private var shown: Int?
    @State private var pulse: Bool = false
    @State private var refunding: Bool = false

    var body: some View {
        Group {
            if onboarding.creditsEnabled, let value = shown {
                HStack(spacing: 5) {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 11, weight: .bold))
                        // The refund flashes the glyph green — the one moment
                        // the badge is allowed to be loud.
                        .foregroundColor(refunding ? .green : .white.opacity(0.9))
                        .scaleEffect(refunding ? 1.35 : 1.0)

                    Text(value, format: .number)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white.opacity(0.9))
                        .monospacedDigit()   // the width must not jitter as digits change
                        .contentTransition(.numericText(countsDown: !refunding))
                }
                .padding(.horizontal, 9)
                .frame(height: 28)
                .background(
                    Capsule().fill(Color.white.opacity(refunding ? 0.16 : 0.08))
                )
                .overlay(
                    Capsule().strokeBorder(
                        refunding ? Color.green.opacity(0.55) : Color.white.opacity(0.10),
                        lineWidth: 1)
                )
                .scaleEffect(pulse ? 1.06 : 1.0)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Text("\(value) credits"))
            }
        }
        .task {
            guard onboarding.creditsEnabled else { return }
            await credits.refresh()
            // Seed WITHOUT animating: the first read is not a change, and
            // animating it would show a decrement from nothing on every launch.
            shown = credits.balance
        }
        .onChange(of: credits.balance) { old, new in
            apply(old: old, new: new)
        }
    }

    /// Animate from the old value to the new one, in the direction that
    /// actually happened.
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
            // Refund: green flash, a bigger pulse, and it holds long enough to
            // be noticed by someone who was looking at the failure message
            // rather than at the header.
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
