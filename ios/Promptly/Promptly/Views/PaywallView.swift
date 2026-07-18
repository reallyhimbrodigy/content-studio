import SwiftUI
import RevenueCat

/// Cream → gold gradient used across all Pro-themed UI. Anchors the
/// premium feel without going gaudy. Used on PROBadge, paywall CTAs,
/// and feature-row checkmarks.
enum PromptlyGold {
    static let gradient = LinearGradient(
        colors: [
            Color(red: 0.96, green: 0.89, blue: 0.74), // #F4E4BC cream
            Color(red: 0.78, green: 0.66, blue: 0.37), // #C8A95E gold
        ],
        startPoint: .topLeading, endPoint: .bottomTrailing
    )
    static let solid = Color(red: 0.78, green: 0.66, blue: 0.37)
}

// MARK: - PROBadge
//
// Small cream/gold pill used to mark Pro-gated features in the UI.
// Sized for inline use next to feature labels or in the corner of
// locked buttons.

struct PROBadge: View {
    var compact: Bool = false
    var body: some View {
        Text("PRO")
            .font(.system(size: compact ? 9 : 10, weight: .heavy))
            .tracking(0.6)
            .foregroundColor(.black)
            .padding(.horizontal, compact ? 5 : 7)
            .padding(.vertical, compact ? 2 : 3)
            .background(
                Capsule(style: .continuous)
                    .fill(PromptlyGold.gradient)
            )
            .accessibilityLabel("Pro feature")
    }
}

// MARK: - Paywall

/// Pro paywall sheet. Presented when the user hits a daily limit or taps
/// a Pro-locked feature (re-edit). Driven by SubscriptionService — fetches
/// offerings, runs the purchase, dismisses on success.
///
/// Reason copy is contextual: pass `.dailyRenders` when the user just
/// 402'd on /api/video-jobs, `.dailyChats` on chat, `.reedit` on the
/// locked re-edit button.
struct PaywallView: View {
    @Binding var isPresented: Bool
    let reason: PaywallReason

    private var title: String {
        switch reason {
        case .dailyRenders: return "You're out of free renders for today"
        case .dailyChats:   return "You're out of free chats for today"
        case .reedit:       return "Re-edit is a Pro feature"
        case .manual:       return "Unlock Promptly Pro"
        case .lumen:        return "Lumen is a Pro model"
        }
    }
    private var subtitle: String {
        switch reason {
        case .dailyRenders(_, let lim):
            return "Free includes \(lim) renders per day. Upgrade for unlimited."
        case .dailyChats(_, let lim):
            return "Free includes \(lim) AI chat messages per day. Upgrade for unlimited."
        case .reedit:
            return "Make changes to finished edits without re-uploading. Pro unlocks the re-edit flow plus unlimited renders and chats."
        case .manual:
            return "Unlimited renders, unlimited chats, and the re-edit feature."
        case .lumen:
            return "Lumen renders premium cinematic edits with generated graphics. Pro unlocks it — plus unlimited renders, chats, and re-edit."
        }
    }

    @ObservedObject private var subscription = SubscriptionService.shared
    @State private var selectedPackage: Package?
    @State private var isPurchasing = false
    @State private var showError = false
    @State private var errorMessage = ""
    /// Non-nil once a purchase/trial completes here — swaps the paywall for the
    /// confirmation screen (trust-package Fix 3) instead of a silent dismiss.
    @State private var confirmation: SubscriptionService.PurchaseConfirmation?
    /// True from the moment the user taps buy, so the `isPro` auto-dismiss below
    /// doesn't race the confirmation screen out of existence.
    @State private var didPurchaseHere = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            backdrop.ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 60)

                    proCrown
                        .padding(.bottom, 20)

                    Text(title)
                        .font(.system(size: 28, weight: .bold))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 28)

                    Text(subtitle)
                        .font(.system(size: 16))
                        .foregroundColor(.white.opacity(0.7))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                        .padding(.top, 10)

                    Spacer().frame(height: 32)

                    featureList
                        .padding(.horizontal, 28)

                    Spacer().frame(height: 28)

                    if let packages = currentPackages, !packages.isEmpty {
                        packagePicker(packages: packages)
                            .padding(.horizontal, 24)
                    } else if subscription.isLoadingOfferings {
                        ProgressView()
                            .tint(.white)
                            .padding(.vertical, 40)
                    } else {
                        // Offerings settled with nothing to show (empty or a
                        // fetch error). Never an infinite spinner — a visible
                        // message + Retry. The single point of failure for all
                        // revenue does not get to fail invisibly.
                        offeringsUnavailable
                            .padding(.horizontal, 28)
                    }

                    Spacer().frame(height: 24)

                    ctaButton
                        .padding(.horizontal, 24)

                    // Fix 2 (copy): the reassurance the shipped paywall lacks —
                    // shown for a trial so the last thing read before committing
                    // isn't only the auto-renew warning.
                    if selectedIsTrial {
                        Text(TrialCopy.ctaReassurance)
                            .font(.system(size: 12))
                            .foregroundColor(.white.opacity(0.6))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 32)
                            .padding(.top, 10)
                    }

                    fineprint
                        .padding(.horizontal, 32)
                        .padding(.top, 14)

                    HStack(spacing: 18) {
                        Button("Restore Purchases") {
                            Task {
                                let ok = await subscription.restorePurchases()
                                if ok { isPresented = false }
                            }
                        }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.white.opacity(0.6))
                    }
                    .padding(.top, 20)
                    .padding(.bottom, 36)
                }
            }

            Button {
                isPresented = false
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            }
            .padding(.trailing, 18)
            .padding(.top, 14)

            // Fix 3: post-purchase confirmation replaces the silent dismiss —
            // rendered over the paywall the moment a purchase/trial completes.
            if let c = confirmation {
                confirmationView(c)
            }
        }
        .preferredColorScheme(.dark)
        .task {
            Analytics.track("paywall_view", props: ["reason": reasonKey])
            await subscription.refreshOfferings()
            // Default selection: pick the yearly package if present (better
            // value, hint at savings) — otherwise the first available.
            if let pkgs = currentPackages {
                selectedPackage = pkgs.first(where: { $0.packageType == .annual }) ?? pkgs.first
            }
        }
        .onChange(of: subscription.isPro) { _, isPro in
            // Auto-dismiss only when Pro is granted OUT OF BAND (a restore, or a
            // webhook/delegate update while the paywall is open). A purchase made
            // here shows the confirmation screen instead of vanishing, so don't
            // pull it out from under the user.
            if isPro && confirmation == nil && !didPurchaseHere { isPresented = false }
        }
        .alert("Purchase didn't complete", isPresented: $showError) {
            Button("OK") {}
        } message: {
            Text(errorMessage)
        }
    }

    // MARK: - Sub-views

    private var backdrop: some View {
        ZStack {
            Color.black
            LinearGradient(
                colors: [
                    Color(red: 0.96, green: 0.89, blue: 0.74).opacity(0.08),
                    Color.black,
                    Color.black,
                ],
                startPoint: .top, endPoint: .bottom
            )
        }
    }

    private var proCrown: some View {
        ZStack {
            Circle()
                .fill(.ultraThinMaterial)
                .frame(width: 72, height: 72)
                .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 0.5))
                .shadow(color: PromptlyGold.solid.opacity(0.4), radius: 30, y: 0)
            Image(systemName: "crown.fill")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(PromptlyGold.gradient)
        }
    }

    private var featureList: some View {
        VStack(alignment: .leading, spacing: 14) {
            featureRow(icon: "infinity", text: "Unlimited renders")
            featureRow(icon: "square.stack.3d.up.fill", text: "Upload up to 10 videos at a time")
            featureRow(icon: "bubble.left.and.bubble.right.fill", text: "Unlimited AI chats")
            featureRow(icon: "arrow.uturn.left", text: "Re-edit any finished video")
            featureRow(icon: "bolt.fill", text: "Priority render queue")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func featureRow(icon: String, text: String) -> some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(PromptlyGold.gradient)
                    .frame(width: 26, height: 26)
                Image(systemName: icon)
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(.black)
            }
            Text(text)
                .font(.system(size: 16, weight: .medium))
                .foregroundColor(.white)
            Spacer()
        }
    }

    private var currentPackages: [Package]? {
        guard let offering = subscription.offerings?.current
            ?? subscription.offerings?[SubscriptionService.defaultOfferingId] else {
            return nil
        }
        return offering.availablePackages
    }

    /// Short, stable key for the paywall's trigger reason — travels with the
    /// `paywall_view` event so the funnel can attribute views to their source.
    private var reasonKey: String {
        switch reason {
        case .dailyRenders: return "daily_renders"
        case .dailyChats:   return "daily_chats"
        case .reedit:       return "reedit"
        case .manual:       return "manual"
        case .lumen:        return "lumen"
        }
    }

    /// Shown when offerings settle with no purchasable packages — either the
    /// fetch threw or it returned zero packages (e.g. products not published
    /// for this storefront). Replaces the old infinite spinner: a visible
    /// reason + a Retry that re-runs the fetch.
    private var offeringsUnavailable: some View {
        VStack(spacing: 14) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28, weight: .semibold))
                .foregroundColor(.white.opacity(0.75))
            Text(subscription.offeringsError
                 ?? "We couldn't load subscription options. Please try again.")
                .font(.system(size: 14))
                .foregroundColor(.white.opacity(0.7))
                .multilineTextAlignment(.center)
            Button {
                Task { await subscription.refreshOfferings() }
            } label: {
                Text("Retry")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.black)
                    .padding(.horizontal, 30)
                    .frame(height: 46)
                    .background(Color.white)
                    .clipShape(Capsule())
            }
            .disabled(subscription.isLoadingOfferings)
        }
        .padding(.vertical, 28)
    }

    private func packagePicker(packages: [Package]) -> some View {
        VStack(spacing: 10) {
            ForEach(packages, id: \.identifier) { pkg in
                packageRow(pkg)
            }
        }
    }

    private func packageRow(_ pkg: Package) -> some View {
        let isSelected = selectedPackage?.identifier == pkg.identifier
        let priceText = pkg.storeProduct.localizedPriceString
        let intervalText: String = {
            switch pkg.packageType {
            case .annual: return "per year"
            case .monthly: return "per month"
            case .weekly: return "per week"
            default: return ""
            }
        }()
        let savingsLabel: String? = pkg.packageType == .annual ? "BEST VALUE" : nil

        return Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            selectedPackage = pkg
        } label: {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    Circle()
                        .stroke(isSelected ? PromptlyGold.solid : Color.white.opacity(0.2), lineWidth: 2)
                        .frame(width: 22, height: 22)
                    if isSelected {
                        Circle()
                            .fill(PromptlyGold.gradient)
                            .frame(width: 12, height: 12)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(pkg.storeProduct.localizedTitle.isEmpty
                             ? pkg.packageType == .annual ? "Yearly" : "Monthly"
                             : pkg.storeProduct.localizedTitle)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                        if let savingsLabel {
                            Text(savingsLabel)
                                .font(.system(size: 9, weight: .heavy))
                                .tracking(0.6)
                                .foregroundColor(.black)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill(PromptlyGold.gradient))
                        }
                    }
                    Text("\(priceText) \(intervalText)")
                        .font(.system(size: 13))
                        .foregroundColor(.white.opacity(0.7))
                    // Fix 1: honest per-month divisor under the yearly sticker —
                    // keeps the full annual number, kills the sticker shock.
                    if pkg.packageType == .annual,
                       let monthly = TrialCopy.monthlyEquivalent(perMonthPrice: pkg.storeProduct.localizedPricePerMonth) {
                        Text(monthly)
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
                    .stroke(isSelected ? PromptlyGold.solid : Color.white.opacity(0.08), lineWidth: isSelected ? 1.5 : 0.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var ctaButton: some View {
        Button {
            guard let pkg = selectedPackage else { return }
            didPurchaseHere = true
            Task {
                let ok = await subscription.purchase(pkg)
                if ok {
                    await UsageService.shared.refresh()
                    // Show the confirmation screen (Fix 3) instead of dismissing.
                    // Fall back to a plain dismiss only if no payload was produced.
                    confirmation = subscription.lastConfirmation
                    if confirmation == nil { isPresented = false }
                } else {
                    didPurchaseHere = false
                    if let err = subscription.lastError {
                        errorMessage = err
                        showError = true
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                if subscription.isLoadingPurchase {
                    ProgressView().tint(.black)
                } else {
                    Text(ctaText)
                        .font(.system(size: 17, weight: .bold))
                }
            }
            .foregroundColor(.black)
            .frame(maxWidth: .infinity)
            .frame(height: 56)
            .background(Color.white)
            .clipShape(Capsule())
        }
        .disabled(selectedPackage == nil || subscription.isLoadingPurchase)
        .opacity(selectedPackage == nil ? 0.4 : 1)
    }

    /// Surface the trial CTA when the selected package's offer is a free
    /// trial (configured at the App Store Connect level on the subscription).
    private var ctaText: String {
        if let pkg = selectedPackage,
           pkg.storeProduct.introductoryDiscount?.paymentMode == .freeTrial {
            return "Start free trial"
        }
        return "Continue"
    }

    /// Whether the selected package carries a free-trial intro offer — drives
    /// the trial-specific reassurance copy, CTA text, fineprint, and confirmation.
    private var selectedIsTrial: Bool {
        selectedPackage?.storeProduct.introductoryDiscount?.paymentMode == .freeTrial
    }

    private var fineprint: some View {
        // Fix 4: keep the required auto-renew disclosure, but for a trial pair it
        // with the reminder reassurance so the last line isn't only a warning.
        Text(TrialCopy.fineprint(isTrial: selectedIsTrial))
            .font(.system(size: 11))
            .foregroundColor(.white.opacity(0.4))
            .multilineTextAlignment(.center)
    }

    /// Fix 3: post-purchase confirmation — certainty over a silent dismiss. Names
    /// the trial-end date, the exact charge, and (only when a reminder was
    /// actually scheduled) the reminder promise. Fully covers the paywall.
    private func confirmationView(_ c: SubscriptionService.PurchaseConfirmation) -> some View {
        ZStack(alignment: .topTrailing) {
            backdrop.ignoresSafeArea()
            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 96)
                    ZStack {
                        Circle()
                            .fill(.ultraThinMaterial)
                            .frame(width: 80, height: 80)
                            .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 0.5))
                            .shadow(color: PromptlyGold.solid.opacity(0.4), radius: 30, y: 0)
                        Image(systemName: "checkmark")
                            .font(.system(size: 32, weight: .bold))
                            .foregroundStyle(PromptlyGold.gradient)
                    }
                    .padding(.bottom, 24)

                    Text(TrialCopy.confirmationTitle)
                        .font(.system(size: 27, weight: .bold))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)

                    Text(TrialCopy.confirmationBody(
                        isTrial: c.isTrial, price: c.price,
                        trialEnd: c.trialEnd, reminderScheduled: c.reminderScheduled))
                        .font(.system(size: 15))
                        .foregroundColor(.white.opacity(0.75))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 34)
                        .padding(.top, 12)

                    if let nudge = TrialCopy.confirmationReminderFallback(
                        reminderScheduled: c.reminderScheduled, isTrial: c.isTrial) {
                        Text(nudge)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(PromptlyGold.solid)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 34)
                            .padding(.top, 12)
                    }

                    Spacer().frame(height: 36)

                    Button {
                        isPresented = false
                    } label: {
                        Text("Start creating")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundColor(.black)
                            .frame(maxWidth: .infinity)
                            .frame(height: 56)
                            .background(Color.white)
                            .clipShape(Capsule())
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 40)
                }
            }

            Button {
                isPresented = false
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(.white)
                    .frame(width: 36, height: 36)
                    .background(.ultraThinMaterial)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.12), lineWidth: 0.5))
            }
            .padding(.trailing, 18)
            .padding(.top, 14)
        }
    }
}
