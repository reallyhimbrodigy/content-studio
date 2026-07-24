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
    @State private var selectedPackage: Package?
    @State private var showAbandonRecovery = false
    @State private var confirmed: SubscriptionService.PurchaseConfirmation?

    // ── Derived ──────────────────────────────────────────────────────────────
    private var packages: [Package] {
        subscription.offerings?.current?.availablePackages ?? []
    }
    private var billedPrice: String {
        selectedPackage?.storeProduct.localizedPriceString ?? "—"
    }
    private var billedPeriod: String { periodLabel(selectedPackage) }
    private var monthlyEquivalent: String? {
        guard let pkg = selectedPackage, pkg.packageType == .annual,
              let price = pkg.storeProduct.pricePerMonth else { return nil }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.locale = pkg.storeProduct.priceFormatter?.locale ?? .current
        return f.string(from: price)
    }

    private let proBenefits: [(icon: String, text: String)] = [
        ("infinity", "Unlimited videos a day"),
        ("arrow.uturn.left", "Re-edit any finished video"),
        ("wand.and.stars", "Lumen — the cinematic AI model"),
        ("square.stack.3d.up.fill", "Upload up to 10 at once"),
        ("bolt.fill", "Priority render queue"),
    ]

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let c = confirmed { confirmation(c) } else { wall }
            if showAbandonRecovery { abandonRecovery }
        }
        .onAppear {
            // UPGRADE-funnel entry (after free_limit_hit).
            Analytics.track("upgrade_wall_viewed", props: ["context": contextKey])
            selectDefaultPackage()
            if packages.isEmpty { Task { await subscription.refreshOfferings() } }
        }
        .onChange(of: subscription.offerings?.current?.availablePackages.count ?? 0) { _, _ in
            selectDefaultPackage()
        }
    }

    private func selectDefaultPackage() {
        guard selectedPackage == nil else { return }
        // Default to annual (best value) when present, else the first package.
        selectedPackage = packages.first(where: { $0.packageType == .annual }) ?? packages.first
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
                    Image(systemName: "crown.fill")
                        .font(.system(size: 30))
                        .foregroundColor(.yellow)
                    Text(context == .lapsed ? "Your videos are waiting" : "Unlock Promptly Pro")
                        .font(.system(size: 30, weight: .heavy))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                    Text(context == .lapsed
                         ? "Everything you made is still here. Go Pro to keep creating without limits."
                         : "Go beyond your one free video a day — everything, unlimited.")
                        .font(.system(size: 15))
                        .foregroundColor(.white.opacity(0.65))
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 24)

                // What Pro unlocks.
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(proBenefits, id: \.text) { b in
                        HStack(spacing: 14) {
                            Image(systemName: b.icon)
                                .font(.system(size: 16))
                                .foregroundColor(.yellow)
                                .frame(width: 26)
                            Text(b.text)
                                .font(.system(size: 16, weight: .medium))
                                .foregroundColor(.white)
                            Spacer()
                        }
                    }
                }
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
                    // UPGRADE-funnel: plan chosen (weekly/monthly/yearly).
                    Analytics.track("plan_selected", props: ["plan": subscription.planKey(pkg)])
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 8) {
                                Text(planTitle(pkg))
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundColor(.white)
                                if pkg.packageType == .annual {
                                    Text("BEST VALUE")
                                        .font(.system(size: 10, weight: .heavy))
                                        .foregroundColor(.black)
                                        .padding(.horizontal, 7).padding(.vertical, 3)
                                        .background(Color.yellow, in: Capsule())
                                }
                            }
                            // LAW: the billed amount is the big number.
                            Text("\(pkg.storeProduct.localizedPriceString) / \(periodLabel(pkg))")
                                .font(.system(size: 19, weight: .heavy))
                                .foregroundColor(.white)
                            if pkg.packageType == .annual, let m = monthlyEquivalent {
                                Text("that's \(m)/mo, billed yearly")
                                    .font(.system(size: 12))
                                    .foregroundColor(.white.opacity(0.55))
                            }
                        }
                        Spacer()
                        Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                            .font(.system(size: 22))
                            .foregroundColor(isSelected ? .yellow : .white.opacity(0.3))
                    }
                    .padding(16)
                    .background(Color.white.opacity(isSelected ? 0.10 : 0.05), in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16)
                        .stroke(isSelected ? Color.yellow.opacity(0.8) : Color.white.opacity(0.08), lineWidth: 1.5))
                }
            }
        }
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
        let ok = await subscription.purchase(pkg)
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

    // ── Honest transaction-abandon recovery ──────────────────────────────────
    private var abandonRecovery: some View {
        ZStack {
            Color.black.opacity(0.72).ignoresSafeArea()
            VStack(spacing: 16) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 38))
                    .foregroundColor(.green)
                Text("No charge was made")
                    .font(.system(size: 21, weight: .bold))
                    .foregroundColor(.white)
                Text("You can upgrade to Pro whenever you're ready — nothing was charged.")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.7))
                    .multilineTextAlignment(.center)
                Button {
                    withAnimation { showAbandonRecovery = false }
                } label: {
                    Text("Back to Pro")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity).frame(height: 50)
                        .background(Color.white, in: Capsule())
                }
            }
            .padding(26)
            .background(Color(white: 0.10), in: RoundedRectangle(cornerRadius: 24))
            .padding(.horizontal, 36)
        }
    }

    // ── Post-purchase confirmation (dates + amounts) ─────────────────────────
    private func confirmation(_ c: SubscriptionService.PurchaseConfirmation) -> some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 54))
                .foregroundColor(.green)
            Text("You're Pro")
                .font(.system(size: 26, weight: .heavy))
                .foregroundColor(.white)
            VStack(spacing: 8) {
                confirmationRow("Billed today", LocalizedStringKey(c.price))
                confirmationRow("Renews", "automatically, cancel anytime")
            }
            .padding(18)
            .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
            .padding(.horizontal, 24)
            Spacer()
            Button {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                onPassed()
            } label: {
                Text("Start creating")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundColor(.black)
                    .frame(maxWidth: .infinity).frame(height: 56)
                    .background(Color.white, in: Capsule())
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 28)
        }
    }

    private func confirmationRow(_ k: LocalizedStringKey, _ v: LocalizedStringKey) -> some View {
        HStack {
            Text(k).font(.system(size: 14)).foregroundColor(.white.opacity(0.55))
            Spacer()
            Text(v).font(.system(size: 14, weight: .semibold)).foregroundColor(.white)
        }
    }

    // ── Package helpers (weekly / monthly / annual) ──────────────────────────
    private func planTitle(_ pkg: Package) -> String {
        switch pkg.packageType {
        case .annual: return "Yearly"
        case .monthly: return "Monthly"
        case .weekly: return "Weekly"
        default: return pkg.storeProduct.localizedTitle
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
