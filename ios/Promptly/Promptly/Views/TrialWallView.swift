import SwiftUI
import RevenueCat

/// Beat 7 — THE WALL. The trial-timeline paywall: Cal AI's conversion science,
/// none of their violations. The laws this screen embodies (what got them
/// removed in April 2026, refused here):
///   - The BILLED amount is always the most prominent price; the monthly-
///     equivalent is an anchor line UNDER it, never above it.
///   - Auto-renewal is never obscured: the timeline's Day-3 row names the
///     charge and the fineprint says auto-renews, cancel anytime.
///   - ONE wall. A decliner sees the SAME offer again — the abandon-recovery
///     overlay confirms no charge was made and returns here. Never a second
///     flow, never a different price.
///   - Eligibility-truthful CTA: "Start free trial" ONLY when StoreKit says an
///     intro trial applies; otherwise "Get Pro now" with the immediate charge
///     named. A lapsed subscriber never sees a fake trial promise.
///
/// Contexts: onboarding (the flow's final beat) · lapsed (beat 10 — their
/// edits are waiting) · door (a `.none` user hit a feature door post-flip).
struct TrialWallView: View {
    enum Context { case onboarding, lapsed, door }

    let context: Context
    let onPassed: () -> Void

    @ObservedObject private var subscription = SubscriptionService.shared
    @State private var selectedPackage: Package?
    @State private var showAbandonRecovery = false
    @State private var confirmed: SubscriptionService.PurchaseConfirmation?

    // ── Derived truth ────────────────────────────────────────────────────────
    private var packages: [Package] {
        subscription.offerings?.current?.availablePackages ?? []
    }
    private var trialEligible: Bool {
        selectedPackage?.storeProduct.introductoryDiscount?.paymentMode == .freeTrial
    }
    private var billedPrice: String {
        selectedPackage?.storeProduct.localizedPriceString ?? "—"
    }
    private var trialDays: Int {
        // Length of the intro period in days (e.g. 3 for the 3-day trial).
        guard let d = selectedPackage?.storeProduct.introductoryDiscount,
              d.paymentMode == .freeTrial else { return 3 }
        let p = d.subscriptionPeriod
        switch p.unit {
        case .day: return p.value
        case .week: return p.value * 7
        default: return 3
        }
    }
    private var monthlyEquivalent: String? {
        guard let pkg = selectedPackage, pkg.packageType == .annual,
              let price = pkg.storeProduct.pricePerMonth else { return nil }
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.locale = pkg.storeProduct.priceFormatter?.locale ?? .current
        return f.string(from: price)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if let c = confirmed {
                confirmation(c)
            } else {
                wall
            }

            if showAbandonRecovery {
                abandonRecovery
            }
        }
        .onAppear {
            Analytics.track("wall_view", props: ["context": contextKey])
            if selectedPackage == nil {
                selectedPackage = packages.first(where: { $0.packageType == .annual }) ?? packages.first
            }
            if packages.isEmpty {
                Task { await subscription.refreshOfferings() }
            }
        }
        .onChange(of: subscription.offerings?.current?.availablePackages.count ?? 0) { _, _ in
            if selectedPackage == nil {
                selectedPackage = packages.first(where: { $0.packageType == .annual }) ?? packages.first
            }
        }
    }

    private var contextKey: String {
        switch context {
        case .onboarding: return "onboarding"
        case .lapsed: return "lapsed"
        case .door: return "door"
        }
    }

    // ── The wall proper ──────────────────────────────────────────────────────
    private var wall: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 22) {
                VStack(spacing: 8) {
                    Text(context == .lapsed ? "Your videos are waiting" : "Start creating today")
                        .font(.system(size: 30, weight: .heavy))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                    Text(context == .lapsed
                         ? "Everything you made is still here. Pick up where you left off."
                         : trialEligible
                            ? "Try everything free for \(trialDays) days."
                            : "Full access to your AI studio.")
                        .font(.system(size: 15))
                        .foregroundColor(.white.opacity(0.65))
                        .multilineTextAlignment(.center)
                }
                .padding(.top, 26)

                // The timeline — only when a trial genuinely applies. Its whole
                // job is transparency: what happens on which day, including the
                // charge. A no-trial context gets no fake timeline.
                if trialEligible && context != .lapsed {
                    timeline
                }

                planPicker
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 210) // room for the pinned footer
        }
        .safeAreaInset(edge: .bottom) { footer }
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 0) {
            timelineRow(icon: "lock.open.fill", tint: .green,
                        title: "Today — full access",
                        line: "Unlimited renders, chats, and re-edit. Cancel anytime.",
                        last: false)
            timelineRow(icon: "bell.fill", tint: .yellow,
                        title: "Day \(max(trialDays - 1, 1)) — we remind you",
                        line: "A notification before your trial ends. We actually send it.",
                        last: false)
            timelineRow(icon: "creditcard.fill", tint: .white,
                        title: "Day \(trialDays) — \(billedPrice) is billed",
                        line: "Only if you haven't cancelled. Auto-renews until cancelled.",
                        last: true)
        }
        .padding(20)
        .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 20))
    }

    private func timelineRow(icon: String, tint: Color, title: String, line: String, last: Bool) -> some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(spacing: 0) {
                Image(systemName: icon)
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(.black)
                    .frame(width: 32, height: 32)
                    .background(tint, in: Circle())
                if !last {
                    Rectangle().fill(Color.white.opacity(0.18)).frame(width: 2, height: 34)
                }
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 16, weight: .bold))
                    .foregroundColor(.white)
                Text(line)
                    .font(.system(size: 13))
                    .foregroundColor(.white.opacity(0.6))
                    .padding(.bottom, last ? 0 : 12)
            }
        }
    }

    private var planPicker: some View {
        VStack(spacing: 10) {
            ForEach(packages, id: \.identifier) { pkg in
                let isSelected = selectedPackage?.identifier == pkg.identifier
                Button {
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    selectedPackage = pkg
                    Analytics.track("package_selected", props: ["type": pkg.packageType == .annual ? "annual" : "monthly"])
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(pkg.packageType == .annual ? "Yearly" : "Monthly")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(.white)
                            // LAW: the billed amount is the big number.
                            Text("\(pkg.storeProduct.localizedPriceString) / \(pkg.packageType == .annual ? "year" : "month")")
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
                        Text(trialEligible ? "Start free trial" : "Get Pro now")
                            .font(.system(size: 17, weight: .bold))
                    }
                }
                .foregroundColor(.black)
                .frame(maxWidth: .infinity)
                .frame(height: 56)
                .background(Color.white, in: Capsule())
            }
            .disabled(selectedPackage == nil || subscription.isLoadingPurchase)

            // Eligibility truth under the CTA: exactly what the tap does.
            Text(trialEligible
                 ? "\(trialDays) days free, then \(billedPrice). Auto-renews until cancelled — cancel anytime in Settings."
                 : "You'll be charged \(billedPrice) today. Auto-renews until cancelled — cancel anytime in Settings.")
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
        }
        .padding(.horizontal, 24)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .background(.black.opacity(0.94))
    }

    // ── Purchase + terminal events (always-fires purchase_result) ────────────
    private func buy() async {
        guard let pkg = selectedPackage else { return }
        Analytics.track("trial_wall_start", props: ["context": contextKey, "trial": trialEligible])
        let ok = await subscription.purchase(pkg)
        if ok {
            Analytics.track("purchase_result", props: [
                "outcome": trialEligible ? "success_trial" : "success_paid",
                "context": contextKey,
            ])
            if let c = subscription.lastConfirmation {
                withAnimation { confirmed = c }
            } else {
                onPassed()
            }
        } else if subscription.lastError == nil {
            // No error + no purchase = the user closed Apple's sheet. The
            // honest recovery: confirm no charge, same wall, same offer.
            Analytics.track("purchase_result", props: ["outcome": "cancelled", "context": contextKey])
            Analytics.track("trial_wall_bounce", props: ["context": contextKey])
            withAnimation { showAbandonRecovery = true }
        } else {
            Analytics.track("purchase_result", props: [
                "outcome": "failed", "context": contextKey,
                "error": subscription.lastError ?? "unknown",
            ])
        }
    }

    // ── Beat 8: honest transaction-abandon recovery ──────────────────────────
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
                Text("Your free trial is still here whenever you're ready.")
                    .font(.system(size: 15))
                    .foregroundColor(.white.opacity(0.7))
                    .multilineTextAlignment(.center)
                Button {
                    withAnimation { showAbandonRecovery = false }
                } label: {
                    Text("Back to the offer")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.black)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(Color.white, in: Capsule())
                }
            }
            .padding(26)
            .background(Color(white: 0.10), in: RoundedRectangle(cornerRadius: 24))
            .padding(.horizontal, 36)
        }
    }

    // ── Post-start: the Trust-Package confirmation (dates + amounts) ─────────
    private func confirmation(_ c: SubscriptionService.PurchaseConfirmation) -> some View {
        VStack(spacing: 18) {
            Spacer()
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 54))
                .foregroundColor(.green)
            Text(c.isTrial ? "Your free trial has started" : "You're Pro")
                .font(.system(size: 26, weight: .heavy))
                .foregroundColor(.white)
            VStack(spacing: 8) {
                if c.isTrial, let end = c.trialEnd {
                    confirmationRow("Trial ends", end.formatted(date: .abbreviated, time: .shortened))
                    confirmationRow("Then", "\(c.price) — only if you don't cancel")
                    confirmationRow("Reminder", c.reminderScheduled ? "scheduled before the charge" : "enable notifications to get one")
                } else {
                    confirmationRow("Billed today", c.price)
                }
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
                    .frame(maxWidth: .infinity)
                    .frame(height: 56)
                    .background(Color.white, in: Capsule())
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 28)
        }
    }

    private func confirmationRow(_ k: String, _ v: String) -> some View {
        HStack {
            Text(k).font(.system(size: 14)).foregroundColor(.white.opacity(0.55))
            Spacer()
            Text(v).font(.system(size: 14, weight: .semibold)).foregroundColor(.white)
        }
    }
}
