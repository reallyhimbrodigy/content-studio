import SwiftUI
import RevenueCat

/// Conversion item 4 — the SECOND, PERSONALISED paywall. Runs after the three
/// questions + the results wall, before the app. The copy is fed by Q1/Q2 —
/// that is the point of asking them. The third option is the REFERRAL (ruled
/// 2026-08-21: it replaces the first-month discount as the alternative to
/// paying): a day of Pro for each person you invite who finishes a first video,
/// three days plus a bonus at three. Copy lives in ReferralCopy — this file
/// spells none of it. Re-laddered 2026-08-29: the old shape stated a quota of
/// three before the user had shared once, so a first successful invite paid
/// nothing and the loop never taught itself.
///
/// SKU order comes from the RevenueCat OFFERING (annual first + pre-selected,
/// weekly second — dashboard-owned, reversible without a build); both SKUs
/// read in weekly terms. Always leaveable: "Not now" is honest and visible.
struct SecondPaywallView: View {
    /// Called on every exit: purchased, shared, or declined — all land in the app.
    let onDone: () -> Void

    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var referrals = ReferralService.shared
    @ObservedObject private var onboarding = OnboardingState.shared

    @State private var selectedPackage: Package?
    @State private var isPurchasing = false
    @State private var didPurchaseHere = false

    private var packages: [Package] {
        SubscriptionService.sortedByDuration(subscription.offerings?.current?.availablePackages ?? [])
    }

    // MARK: Personalised copy (Q1 audience + Q2 intents feed this)

    private var headline: String {
        switch onboarding.intents.first {
        case "viral":       return "Made to go viral"
        case "promo":       return "Sell more with every video"
        case "storytime":   return "Tell stories people finish"
        case "talkinghead": return "Crisp talking-head edits, daily"
        case "highlights":  return "Every highlight, cut for you"
        default:            return "Your editor, on every video"
        }
    }

    private var personalBenefit: String {
        switch onboarding.audience {
        case "clients":  return "Client-ready output, every time"
        case "business": return "On-brand videos without hiring an editor"
        case "creator":  return "Post daily without burning out"
        case "event":    return "Recaps ready before the event ends"
        // The generic fallback is the headline claim itself — taken from the
        // shared source, not respelled. This line was the fourth copy of it.
        default:         return ProBenefits.core[0].text
        }
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 40)

                    AnimatedPromptlyMark(size: 72, halo: true)
                        .padding(.bottom, 16)

                    Text(headline)
                        .font(.system(size: 28, weight: .heavy))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)
                        .entrance(delay: 0.05)

                    Text(personalBenefit)
                        .font(.system(size: 16))
                        .foregroundColor(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 8)
                        .entrance(delay: 0.11)

                    Spacer().frame(height: 24)

                    if !packages.isEmpty {
                        VStack(spacing: 10) {
                            ForEach(packages, id: \.identifier) { pkg in
                                packageRow(pkg)
                            }
                            // Flag-gated 2026-08-29. Was unconditional.
                            if onboarding.secondPaywallReferralEnabled {
                                referralRow
                            }
                        }
                        .padding(.horizontal, 24)
                        .entrance(delay: 0.18)
                    } else if subscription.isLoadingOfferings {
                        ProgressView().tint(.white).padding(.vertical, 30)
                    } else {
                        // Offerings unavailable: the referral option still stands.
                        if onboarding.secondPaywallReferralEnabled {
                            referralRow.padding(.horizontal, 24)
                        }
                    }

                    Spacer().frame(height: 20)

                    ctaButton.padding(.horizontal, 24).entrance(delay: 0.28)

                    Button {
                        onDone()
                    } label: {
                        Text("Not now")
                            .font(.system(size: 15, weight: .medium))
                            .foregroundColor(.white.opacity(0.55))
                    }
                    .padding(.top, 14)

                    Text(TrialCopy.fineprint)
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.4))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 12)
                        .padding(.bottom, 36)
                }
            }

            if didPurchaseHere, let confirmation = subscription.lastConfirmation {
                ProCelebrationView(price: confirmation.price) { onDone() }
                    .transition(.opacity)
            }
        }
        .task {
            Analytics.track("upgrade_wall_viewed", props: (["context": "post_onboarding"] as [String: Any]).merging(SubscriptionService.cachedStorefrontProps) { a, _ in a })
            if packages.isEmpty { await subscription.refreshOfferings() }
            if selectedPackage == nil { selectedPackage = packages.first }
            await referrals.refreshProgress()
        }
        .onChange(of: subscription.offerings?.current?.availablePackages.count ?? 0) { _, _ in
            if selectedPackage == nil { selectedPackage = packages.first }
        }
    }

    // MARK: Rows

    private func packageRow(_ pkg: Package) -> some View {
        let isSelected = selectedPackage?.identifier == pkg.identifier
        let isFirst = pkg.identifier == packages.first?.identifier
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedPackage = pkg
            Analytics.track("plan_selected", props: ["plan": subscription.planKey(pkg), "currency": pkg.storeProduct.currencyCode ?? "", "price": "\(pkg.storeProduct.price)"].merging(SubscriptionService.cachedStorefrontProps) { a, _ in a })
        } label: {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .stroke(isSelected ? Color.white : Color.white.opacity(0.2), lineWidth: 2)
                        .frame(width: 22, height: 22)
                    if isSelected { Circle().fill(Color.white).frame(width: 12, height: 12) }
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(pkg.packageType == .annual ? "Yearly"
                             : pkg.packageType == .monthly ? "Monthly"
                             : pkg.packageType == .weekly ? "Weekly" : "Promptly Pro")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                        if isFirst {
                            Text("BEST VALUE")
                                .font(.system(size: 9, weight: .heavy)).tracking(0.6)
                                .foregroundColor(.black)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Capsule().fill(Color.white))
                        }
                    }
                    Text("\(pkg.storeProduct.localizedPriceString) \(periodText(pkg))")
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.7))
                    if pkg.packageType == .annual, let monthly = monthlyAnchor(for: pkg) {
                        Text(monthly)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(.white.opacity(0.55))
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(isSelected ? 0.08 : 0.04)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(isSelected ? Color.white : Color.white.opacity(0.08),
                        lineWidth: isSelected ? 1.5 : 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The referral option — visually parallel to the SKUs but NOT part of the
    /// radio selection (it must never wedge the buy button). Tapping opens the
    /// share sheet; progress shows qualified friends toward the reward.
    /// The impression fires from INSIDE this row, not from its mount sites.
    ///
    /// It used to be an `.onAppear` on the mount, and this row is mounted
    /// TWICE — once with packages present, once in the offerings-unavailable
    /// branch. Only the first carried it, so the second rendered the full row,
    /// offer and progress line, with no `referral_shown`. Its share button
    /// takes the default `source`, "paywall2", so those shares landed in a
    /// bucket whose denominator excluded their own views: paywall2's share
    /// RATE read high by exactly the amount offerings were failing. That is
    /// the number the ladder is judged on.
    ///
    /// Anchored on the view's own root — the pattern AbandonRecoveryOverlay
    /// already uses across its three mounts — a third mount cannot be added
    /// without instrumentation, because there is no mount-site step to forget.
    private var referralRow: some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            Task { await referrals.presentShareSheet(source: "paywall2") }
        } label: {
            HStack(spacing: 14) {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.white)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Or get Pro free")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                    Text(ReferralCopy.offer)
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.7))
                        .fixedSize(horizontal: false, vertical: true)
                    // Visible progress toward the reward — most of what makes
                    // referral programs work.
                    // Honesty (ruled 2026-08-27): the progress line must state
                    // the QUALIFICATION (made a video, not signed up) — a
                    // promise that pays out days later has to say what ticks
                    // the counter, or the first cohort learns the reward
                    // "doesn't arrive".
                    // No denominator: a target reintroduces the quota the
                    // ladder exists to remove, and this one counted toward a
                    // reward nobody could reach while attribution was 0%.
                    Text(ReferralCopy.progress(referrals.qualifiedCount))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundColor(.white.opacity(0.55))
                }
                Spacer()
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 16))
                    .foregroundColor(.white.opacity(0.6))
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color.white.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Color.white.opacity(0.08), lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onAppear { referrals.trackImpression(source: "paywall2") }
    }

    private var ctaButton: some View {
        Button {
            guard let pkg = selectedPackage, !isPurchasing else { return }
            isPurchasing = true
            Task {
                // Surface stamp. Without it this screen's purchases land in the
                // canonical revenue-per-wall-view read with no surface at all —
                // silently absent from the by-surface cut rather than visibly
                // wrong, which is the harder failure to notice.
                let ok = await subscription.purchase(pkg, context: "second_paywall")
                isPurchasing = false
                if ok { withAnimation { didPurchaseHere = true } }
            }
        } label: {
            HStack {
                if isPurchasing { ProgressView().tint(.black) }
                Text(isPurchasing ? "One moment…" : "Unlock Promptly Pro")
                    .font(.system(size: 17, weight: .bold))
            }
            .foregroundColor(.black)
            .frame(maxWidth: .infinity)
            .frame(height: 54)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.white))
        }
        .disabled(selectedPackage == nil || isPurchasing)
        .opacity(selectedPackage == nil ? 0.5 : 1)
    }

    private func periodText(_ pkg: Package) -> String {
        switch pkg.packageType {
        case .annual: return "per year"
        case .monthly: return "per month"
        case .weekly: return "per week"
        default: return ""
        }
    }

    /// Re-ruled 2026-08-22: the ANNUAL anchor reads monthly (Apple's sheet
    /// restates the full charge; per-week maximises the gap at commitment).
    private func monthlyAnchor(for pkg: Package) -> String? {
        if let perMonth = pkg.storeProduct.localizedPricePerMonth,
           let line = TrialCopy.monthlyEquivalent(perMonthPrice: perMonth) {
            return line
        }
        if let formatter = pkg.storeProduct.priceFormatter {
            return TrialCopy.monthlyEquivalent(fromYearlyPrice: pkg.storeProduct.price, using: formatter)
        }
        return nil
    }
}
