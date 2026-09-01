import SwiftUI
import RevenueCat

/// THE UPGRADE WALL (freemium, 2026-07-21 pivot — supersedes the trial wall).
/// Promptly is now permanent FREE + PRO, NO trials. This screen presents ONLY
/// the paid upgrade — no trial timeline, no "start free trial", no intro-offer
/// language anywhere. The honesty laws still hold:
///   - The BILLED amount is the most prominent price; the per-month equivalent
///     is a smaller anchor UNDER it, never above.
///   - Auto-renewal is never obscured (the fineprint names the charge + renewal).
///   - ONE wall. A decliner sees the SAME offer again — the abandon overlay
///     confirms no charge and returns here. Never a second flow or price.
///
/// Contexts: onboarding (the flow's final beat) · lapsed ("your videos are
/// waiting") · door (a free user tapped a Pro feature / hit a free limit).
/// The struct name is kept so existing call sites (OnboardingFlow, AppShell)
/// don't change.
struct TrialWallView: View {
    enum Context { case onboarding, lapsed, door }

    let context: Context
    let onPassed: () -> Void

    @ObservedObject private var subscription = SubscriptionService.shared
    @ObservedObject private var onboardingStateRef = OnboardingState.shared
    @State private var selectedPackage: Package?
    @State private var showAbandonRecovery = false
    @State private var confirmed: SubscriptionService.PurchaseConfirmation?

    // ── Derived ──────────────────────────────────────────────────────────────
    private var packages: [Package] {
        SubscriptionService.sortedByDuration(subscription.offerings?.current?.availablePackages ?? [])
    }
    private var billedPrice: String {
        selectedPackage?.storeProduct.localizedPriceString ?? "—"
    }
    private var billedPeriod: String { periodLabel(selectedPackage) }
    /// Monthly equivalent of an ANNUAL plan (re-ruled 2026-08-22: monthly, not
    /// per-week — Apple's sheet restates the full annual charge, and a per-week
    /// anchor maximises the gap at commitment). Storefront-aware. Per-row (the
    /// old selection-based property hid the annual anchor whenever another row
    /// was selected).
    private func monthlyEquivalent(for pkg: Package) -> String? {
        guard pkg.packageType == .annual,
              let price = pkg.storeProduct.pricePerMonth else { return nil }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.locale = pkg.storeProduct.priceFormatter?.locale ?? .current
        return f.string(from: price)
    }

    // Benefits render via the shared PaywallFeatureChecklist (2026-08-26
    // rebuild) — one approved 5-bullet list for both purchase surfaces.

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let c = confirmed { confirmation(c) } else { wall }
            if showAbandonRecovery {
                AbandonRecoveryOverlay { withAnimation { showAbandonRecovery = false } }
            }
        }
        .onAppear {
            // UPGRADE-funnel entry (after free_limit_hit).
            Analytics.track("upgrade_wall_viewed", props: (["context": contextKey] as [String: Any]).merging(SubscriptionService.cachedStorefrontProps) { a, _ in a })
            selectDefaultPackage()
            if packages.isEmpty { Task { await subscription.refreshOfferings() } }
        }
        .onChange(of: subscription.offerings?.current?.availablePackages.count ?? 0) { _, _ in
            selectDefaultPackage()
        }
    }

    private func selectDefaultPackage() {
        guard selectedPackage == nil else { return }
        // Pre-selection follows the computed savings comparison (same live-price
        // math as the badge — Aug-18 item closed at both files), not position 0.
        selectedPackage = PlanSavings.defaultSelection(in: packages)
    }

    private var contextKey: String {
        switch context {
        case .onboarding: return "onboarding"
        case .lapsed: return "lapsed"
        case .door: return "door"
        }
    }

    // ── The wall ─────────────────────────────────────────────────────────────
    private var wall: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 20) {
                VStack(spacing: 10) {
                    // Brand mark, not a crown — consistent with PaywallView's header.
                    AnimatedPromptlyMark(size: 64, halo: true)
                    // (Header text cascades below; the mark animates itself.)
                    Text(context == .lapsed ? "Your videos are waiting" : "Unlock Promptly Pro")
                        .font(.system(size: 30, weight: .heavy))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                    Text(context == .lapsed
                         ? "Everything you made is still here. Go Pro to keep creating without limits."
                         : ProBenefits.paywallSubtitle)
                        .font(.system(size: 15))
                        .foregroundColor(.white.opacity(0.65))
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 24)

                // What Pro unlocks — the shared checklist (reference layout).
                PaywallFeatureChecklist()
                    .padding(18)
                    .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18))

                planPicker
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 200)
        }
        .safeAreaInset(edge: .bottom) { footer }
    }

    private var planPicker: some View {
        VStack(spacing: 10) {
            ForEach(packages, id: \.identifier) { pkg in
                let isSelected = selectedPackage?.identifier == pkg.identifier
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    selectedPackage = pkg
                    // UPGRADE-funnel: plan chosen (weekly/monthly/yearly). `context`
                    // names the surface, same key the purchase_* terminals carry.
                    Analytics.track("plan_selected", props: ["plan": subscription.planKey(pkg), "currency": pkg.storeProduct.currencyCode ?? "", "price": "\(pkg.storeProduct.price)", "context": contextKey].merging(SubscriptionService.cachedStorefrontProps) { a, _ in a })
                } label: {
                    // Reference structure (2026-08-26 rebuild): radio + bare-noun
                    // label + anchor subline left, billed price right, computed
                    // discount badge overhanging the annual card's top edge.
                    HStack(alignment: .center, spacing: 14) {
                        Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                            .font(.system(size: 22))
                            .foregroundColor(isSelected ? .white : .white.opacity(0.3))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(planTitle(pkg))
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(.white)
                            if pkg.packageType == .annual, let m = monthlyEquivalent(for: pkg) {
                                Text("that's \(m)/month, billed yearly")
                                    .font(.system(size: 12))
                                    .foregroundColor(.white.opacity(0.55))
                            }
                            // annual_dollar_line: the deal in dollars — same
                            // live storefront math as PaywallView's row (weekly
                            // must exist AND annual genuinely cheaper).
                            if pkg.packageType == .annual,
                               onboardingStateRef.annualDollarLineEnabled,
                               let dollarLine = PlanSavings.annualDollarLine(in: packages) {
                                Text(dollarLine)
                                    .font(.system(size: 11))
                                    .foregroundColor(.white.opacity(0.5))
                                    .onAppear {
                                        Analytics.track("annual_dollar_line_shown", props: ["context": contextKey])
                                    }
                            }
                        }
                        Spacer()
                        // LAW: the billed amount is the big number.
                        Text("\(pkg.storeProduct.localizedPriceString)/\(periodLabel(pkg))")
                            .font(.system(size: 17, weight: .heavy))
                            .foregroundColor(.white)
                    }
                    .padding(16)
                    .background(Color.white.opacity(isSelected ? 0.10 : 0.05), in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16)
                        .stroke(isSelected ? Color.white : Color.white.opacity(0.1), lineWidth: 1.5))
                    .overlay(alignment: .topTrailing) {
                        // Computed at render time from the live per-territory
                        // prices — floor(1 − y/(12·m)); never hardcoded.
                        if pkg.packageType == .annual,
                           let pct = PlanSavings.percentOff(in: packages) {
                            Text("\(pct)% OFF")
                                .font(.system(size: 10, weight: .heavy))
                                .tracking(0.4)
                                .foregroundColor(.black)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(Capsule().fill(Color.white))
                                .offset(x: -12, y: -9)
                        }
                    }
                }
            }
        }
        // Headroom for the annual card's badge overhang (reference layout).
        .padding(.top, 6)
    }

    private var footer: some View {
        VStack(spacing: 10) {
            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                Task { await buy() }
            } label: {
                Group {
                    if subscription.isLoadingPurchase {
                        ProgressView().tint(.black)
                    } else {
                        Text("Upgrade to Pro")
                            .font(.system(size: 17, weight: .bold))
                    }
                }
                .foregroundColor(.black)
                .frame(maxWidth: .infinity)
                .frame(height: 56)
                .background(Color.white, in: Capsule())
            }
            .disabled(selectedPackage == nil || subscription.isLoadingPurchase)

            // No trial anywhere — the charge is immediate and named.
            Text("You'll be charged \(billedPrice) \(billedPeriod). Auto-renews until cancelled — cancel anytime in your Apple Account settings.")
                .font(.system(size: 12))
                .foregroundColor(.white.opacity(0.55))
                .multilineTextAlignment(.center)

            Button("Restore purchases") {
                Task {
                    let ok = await subscription.restorePurchases()
                    Analytics.track("restore_result", props: ["ok": ok])
                    if ok && subscription.effectiveIsPro { onPassed() }
                }
            }
            .font(.system(size: 13, weight: .medium))
            .foregroundColor(.white.opacity(0.6))

            // Apple 3.1.2: a screen selling an auto-renewable subscription MUST
            // carry functional links to the Terms of Use (EULA) and Privacy Policy.
            HStack(spacing: 6) {
                Button("Terms of Use") { openLegal("https://usepromptly.app/terms.html") }
                Text("·").foregroundColor(.white.opacity(0.3))
                Button("Privacy Policy") { openLegal("https://usepromptly.app/privacy.html") }
            }
            .font(.system(size: 12, weight: .medium))
            .foregroundColor(.white.opacity(0.5))
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(.black.opacity(0.94))
    }

    // ── Purchase + terminal handling ─────────────────────────────────────────
    // The UPGRADE funnel terminals (purchase_started → purchase_completed /
    // purchase_failed, with billing_error + cancelled props) fire canonically
    // inside SubscriptionService.purchase, for BOTH paywalls and every cancel
    // path. This handler only drives the UI off the boolean result.
    private func buy() async {
        guard let pkg = selectedPackage else { return }
        let ok = await subscription.purchase(pkg, context: contextKey)
        if ok {
            if let c = subscription.lastConfirmation {
                withAnimation { confirmed = c }
            } else {
                onPassed()
            }
        } else if subscription.lastError == nil {
            // User closed Apple's sheet. Honest recovery, same offer, no new flow.
            withAnimation { showAbandonRecovery = true }
        }
    }

    // ── Post-purchase confirmation ───────────────────────────────────────────
    // The shared ProCelebrationView (defined in PaywallView.swift), so buying
    // from the wall lands the SAME "You're on Promptly Pro" moment as buying
    // from the paywall sheet. onPassed() advances the flow (onboarding) or
    // dismisses the wall (door/lapsed).
    private func confirmation(_ c: SubscriptionService.PurchaseConfirmation) -> some View {
        ProCelebrationView(price: c.price) { onPassed() }
    }

    // ── Package helpers (weekly / monthly / annual) ──────────────────────────
    private func planTitle(_ pkg: Package) -> String {
        // Bare nouns, our OWN labels — NEVER StoreKit's localizedTitle (the
        // Jul-24 rule; the old default branch here still fell back to it —
        // regression closed 2026-08-26).
        switch pkg.packageType {
        case .annual: return String(localized: "Year")
        case .monthly: return String(localized: "Month")
        case .weekly: return String(localized: "Week")
        default: return "Promptly Pro"
        }
    }
    private func periodLabel(_ pkg: Package?) -> String {
        switch pkg?.packageType {
        case .annual: return "year"
        case .monthly: return "month"
        case .weekly: return "week"
        default: return "period"
        }
    }

    private func openLegal(_ urlString: String) {
        if let url = URL(string: urlString) { UIApplication.shared.open(url) }
    }
}
