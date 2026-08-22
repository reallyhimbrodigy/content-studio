import SwiftUI
import RevenueCat

/// Conversion workstream item 1 — the FIRST-LAUNCH paywall.
///
/// Shown once, on first launch, BEFORE signup/onboarding, and always
/// dismissible (the X is never hidden). The mechanism (from the captions.ai
/// teardown): a dismissible wall costs nothing and takes paid-tier exposure
/// from ~7% to 100% — every user learns a paid tier exists in the first
/// seconds. Measured evidence says wall exposure correlates with HIGHER
/// pick-rates, so the success metrics are wall-views, dismiss rate, pick-rate
/// movement, and conversion per SKU — all against wall-views on the auth UUID.
///
/// Pre-auth purchase is architecturally allowed: RevenueCat runs under an
/// anonymous appUserID which aliases to the Supabase user at sign-in
/// (identify()); purchases are only ever blocked for a signed-in user who
/// cannot be aliased (billing-identity hardening). So the CTA can sell before
/// signup, and attribution merges later.
///
/// SKU presentation (ruled 2026-08-21): packages render in the OFFERING's own
/// order — annual first & pre-selected, weekly second, configured in the
/// RevenueCat dashboard, never hardcoded (reversing the order is a dashboard
/// change, not a build). Both SKUs read in weekly terms: the weekly SKU's
/// price line is per-week already; the annual row carries the per-week anchor.
///
/// Gated by /api/health.first_launch_paywall ("on"), cached, default OFF —
/// the wall ships dark and cannot brick a launch on a config fetch.
struct FirstLaunchPaywallView: View {
    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var onboarding = OnboardingState.shared

    @State private var selectedPackage: Package?
    @State private var isPurchasing = false
    @State private var didPurchaseHere = false

    private var packages: [Package] {
        subscription.offerings?.current?.availablePackages ?? []
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 64)

                    AnimatedPromptlyMark(size: 84, halo: true)
                        .padding(.bottom, 18)

                    Text("Videos that edit themselves")
                        .font(.system(size: 30, weight: .heavy))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)

                    Text("Talk to Promptly like an editor. Captions, cuts, graphics — done for you.")
                        .font(.system(size: 16))
                        .foregroundColor(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 10)

                    Spacer().frame(height: 26)

                    benefits
                        .padding(.horizontal, 30)

                    Spacer().frame(height: 24)

                    if !packages.isEmpty {
                        VStack(spacing: 10) {
                            ForEach(packages, id: \.identifier) { pkg in
                                packageRow(pkg)
                            }
                        }
                        .padding(.horizontal, 24)
                    } else if subscription.isLoadingOfferings {
                        ProgressView().tint(.white).padding(.vertical, 36)
                    }
                    // Offerings failed → no rows, no spinner: the wall still
                    // shows the brand + benefits, and the X moves them on. A
                    // first-launch wall must never strand a brand-new user.

                    Spacer().frame(height: 22)

                    ctaButton
                        .padding(.horizontal, 24)

                    Text(TrialCopy.fineprint)
                        .font(.system(size: 11))
                        .foregroundColor(.white.opacity(0.4))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 12)

                    VStack(spacing: 12) {
                        Button("Restore Purchases") {
                            Task {
                                if await subscription.restorePurchases() { finish() }
                            }
                        }
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.55))

                        HStack(spacing: 18) {
                            Button("Terms of Use") { openLegal("https://usepromptly.app/terms.html") }
                            Button("Privacy Policy") { openLegal("https://usepromptly.app/privacy.html") }
                        }
                        .font(.system(size: 12))
                        .foregroundColor(.white.opacity(0.35))
                    }
                    .padding(.top, 18)
                    .padding(.bottom, 40)
                }
            }

            // ALWAYS dismissible — the exposure is the point, not a trap.
            Button {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
                Analytics.track("paywall_dismiss", props: ["context": "first_launch"])
                finish()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(.white.opacity(0.6))
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(Color.white.opacity(0.08)))
                    .contentShape(Rectangle())
            }
            .padding(.top, 12)
            .padding(.trailing, 16)
            .accessibilityLabel("Not now")

            if didPurchaseHere, let confirmation = subscription.lastConfirmation {
                ProCelebrationView(price: confirmation.price) { finish() }
                    .transition(.opacity)
            }
        }
        .task {
            // Canonical shared paywall-impression funnel; context segments it.
            Analytics.track("upgrade_wall_viewed", props: ["context": "first_launch"])
            if packages.isEmpty { await subscription.refreshOfferings() }
            if selectedPackage == nil { selectedPackage = packages.first }
        }
        .onChange(of: subscription.offerings?.current?.availablePackages.count ?? 0) { _, _ in
            if selectedPackage == nil { selectedPackage = packages.first }
        }
    }

    // MARK: - Pieces

    private var benefits: some View {
        VStack(alignment: .leading, spacing: 12) {
            benefitRow(icon: "infinity", text: "Unlimited videos, no daily cap")
            benefitRow(icon: "captions.bubble.fill", text: "Captions, cuts and graphics — automatic")
            benefitRow(icon: "arrow.uturn.left", text: "Re-edit any finished video")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func benefitRow(icon: String, text: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(PromptlyGold.gradient)
                .frame(width: 24)
            Text(text)
                .font(.system(size: 15))
                .foregroundColor(.white.opacity(0.88))
        }
    }

    private func packageRow(_ pkg: Package) -> some View {
        let isSelected = selectedPackage?.identifier == pkg.identifier
        let isFirst = pkg.identifier == packages.first?.identifier
        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedPackage = pkg
            Analytics.track("plan_selected", props: ["plan": subscription.planKey(pkg)])
        } label: {
            HStack(spacing: 14) {
                ZStack {
                    Circle()
                        .stroke(isSelected ? PromptlyGold.solid : Color.white.opacity(0.2), lineWidth: 2)
                        .frame(width: 22, height: 22)
                    if isSelected {
                        Circle().fill(PromptlyGold.gradient).frame(width: 12, height: 12)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(pkg.packageType == .annual ? "Yearly"
                             : pkg.packageType == .monthly ? "Monthly"
                             : pkg.packageType == .weekly ? "Weekly"
                             : "Promptly Pro")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                        if isFirst {
                            Text("BEST VALUE")
                                .font(.system(size: 9, weight: .heavy))
                                .tracking(0.6)
                                .foregroundColor(.black)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(PromptlyGold.gradient))
                        }
                    }
                    Text("\(pkg.storeProduct.localizedPriceString) \(periodText(pkg))")
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.7))
                    // Both SKUs in weekly terms: annual carries the per-week
                    // anchor; the weekly SKU's price line is already per-week.
                    if pkg.packageType == .annual, let weekly = weeklyAnchor(for: pkg) {
                        Text(weekly)
                            .font(.system(size: 11, weight: .medium))
                            .foregroundColor(PromptlyGold.solid)
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color.white.opacity(isSelected ? 0.08 : 0.04))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(isSelected ? PromptlyGold.solid : Color.white.opacity(0.08),
                            lineWidth: isSelected ? 1.5 : 0.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var ctaButton: some View {
        Button {
            guard let pkg = selectedPackage, !isPurchasing else { return }
            isPurchasing = true
            Task {
                let ok = await subscription.purchase(pkg)
                isPurchasing = false
                if ok { withAnimation { didPurchaseHere = true } }
                // Cancel/failure: stay put — the X remains the exit.
            }
        } label: {
            HStack {
                if isPurchasing { ProgressView().tint(.black) }
                Text(isPurchasing ? "One moment…" : "Get Started")
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

    private func weeklyAnchor(for pkg: Package) -> String? {
        if let perWeek = pkg.storeProduct.localizedPricePerWeek,
           let line = TrialCopy.weeklyEquivalent(perWeekPrice: perWeek) {
            return line
        }
        if let formatter = pkg.storeProduct.priceFormatter {
            return TrialCopy.weeklyEquivalent(fromYearlyPrice: pkg.storeProduct.price, using: formatter)
        }
        return nil
    }

    private func finish() {
        withAnimation { onboarding.hasSeenFirstLaunchPaywall = true }
    }

    private func openLegal(_ url: String) {
        if let u = URL(string: url) { UIApplication.shared.open(u) }
    }
}
