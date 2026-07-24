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
        case .concurrency:  return "One video at a time on Free"
        }
    }
    private var subtitle: String {
        switch reason {
        case .dailyRenders(_, let lim):
            return "Free includes \(lim) video render\(lim == 1 ? "" : "s") per day. Upgrade to Pro for unlimited."
        case .dailyChats(_, let lim):
            return "Free includes \(lim) AI chat messages per day. Upgrade for unlimited."
        case .reedit:
            return "Make changes to finished edits without re-uploading. Pro unlocks the re-edit flow plus unlimited renders and chats."
        case .manual:
            return "Unlimited renders, unlimited chats, and the re-edit feature."
        case .lumen:
            return "Lumen renders premium cinematic edits with generated graphics. Pro unlocks it — plus unlimited renders, chats, and re-edit."
        case .concurrency:
            return "Free processes one video at a time. Upgrade to Pro to run up to 10 in parallel."
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

                    fineprint
                        .padding(.horizontal, 32)
                        .padding(.top, 14)

                    VStack(spacing: 14) {
                        Button("Restore Purchases") {
                            Task {
                                let ok = await subscription.restorePurchases()
                                if ok { isPresented = false }
                            }
                        }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(.white.opacity(0.6))

                        // Apple 3.1.2: a subscription paywall MUST carry functional
                        // links to the Terms of Use (EULA) and the Privacy Policy.
                        HStack(spacing: 6) {
                            Button("Terms of Use") { openLegal("https://usepromptly.app/terms.html") }
                            Text("·").foregroundColor(.white.opacity(0.3))
                            Button("Privacy Policy") { openLegal("https://usepromptly.app/privacy.html") }
                        }
                        .font(.system(size: 12, weight: .medium))
                        .foregroundColor(.white.opacity(0.5))
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
            // UPGRADE-funnel entry — same canonical event the TrialWallView fires,
            // so both paywall surfaces feed one funnel. `reason`/`context` segments them.
            Analytics.track("upgrade_wall_viewed", props: ["context": reasonKey])
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

    /// Short, stable key for the paywall's trigger reason — travels as the
    /// `context` prop on `upgrade_wall_viewed` so the funnel can attribute views
    /// to their source (daily cap, re-edit, Lumen, manual).
    private var reasonKey: String {
        switch reason {
        case .dailyRenders: return "daily_renders"
        case .dailyChats:   return "daily_chats"
        case .reedit:       return "reedit"
        case .manual:       return "manual"
        case .lumen:        return "lumen"
        case .concurrency:  return "concurrency"
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

    /// Fix 1 anchor for a yearly plan. Prefers RevenueCat's own localized
    /// per-month string; falls back to price ÷ 12 formatted with the product's
    /// own formatter. Both are storefront-derived — never a hardcoded currency,
    /// so ₹19,900 renders "₹1,658/mo" and CAD renders CAD, worldwide, for free.
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
            // UPGRADE-funnel: plan chosen (weekly/monthly/yearly).
            Analytics.track("plan_selected", props: ["plan": subscription.planKey(pkg)])
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
                    // keeps the full annual number, kills the sticker shock. Both
                    // the RC per-month string and the divide-by-12 fallback derive
                    // currency + locale from StoreKit; no price literal in code.
                    if pkg.packageType == .annual, let monthly = monthlyAnchor(for: pkg) {
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

    /// FREEMIUM: a direct purchase, no trial — the CTA commits to the charge.
    private var ctaText: String { "Upgrade to Pro" }

    private func openLegal(_ urlString: String) {
        if let url = URL(string: urlString) { UIApplication.shared.open(url) }
    }

    private var fineprint: some View {
        // The required auto-renew disclosure (no trial, so no reminder line).
        Text(TrialCopy.fineprint)
            .font(.system(size: 11))
            .foregroundColor(.white.opacity(0.4))
            .multilineTextAlignment(.center)
    }

    /// Post-purchase confirmation — now the shared ProCelebrationView (below), so
    /// the "You're on Promptly Pro" moment is identical here and on the upgrade
    /// wall. Dismissing the sheet returns the user to whatever they were doing.
    private func confirmationView(_ c: SubscriptionService.PurchaseConfirmation) -> some View {
        ZStack(alignment: .topTrailing) {
            ProCelebrationView(price: c.price) { isPresented = false }

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

// MARK: - ProCelebrationView (the shared post-purchase "You're on Promptly Pro" moment)

/// The single post-purchase celebration, shared by EVERY purchase surface
/// (PaywallView sheet + TrialWallView wall) so the moment is byte-identical no
/// matter which one triggered the buy — replaces the two divergent local
/// confirmations ("You're Pro 🎉" gold vs "You're Pro" green). Presentation-only:
/// the purchase, entitlement sync, and analytics already fired in
/// SubscriptionService.purchase; this just celebrates and hands control back via
/// `onContinue` (dismiss the sheet, or advance the onboarding/door flow).
struct ProCelebrationView: View {
    let price: String
    let onContinue: () -> Void

    private let unlocked: [(icon: String, text: String)] = [
        ("infinity", "Unlimited videos, every day"),
        ("arrow.uturn.left", "Re-edit any finished video"),
        ("wand.and.stars", "Lumen — the cinematic model"),
        ("square.stack.3d.up.fill", "Upload up to 10 at once"),
    ]

    var body: some View {
        ZStack {
            // Dark ground with a gold-tinted top fade — the Pro visual language.
            ZStack {
                Color.black
                LinearGradient(
                    colors: [PromptlyGold.solid.opacity(0.14), .black, .black],
                    startPoint: .top, endPoint: .bottom
                )
            }
            .ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Spacer().frame(height: 88)

                    ZStack {
                        Circle()
                            .fill(.ultraThinMaterial)
                            .frame(width: 84, height: 84)
                            .overlay(Circle().stroke(Color.white.opacity(0.16), lineWidth: 0.5))
                            .shadow(color: PromptlyGold.solid.opacity(0.45), radius: 34, y: 0)
                        Image(systemName: "crown.fill")
                            .font(.system(size: 34, weight: .bold))
                            .foregroundStyle(PromptlyGold.gradient)
                    }
                    .padding(.bottom, 22)

                    Text(TrialCopy.proMomentTitle)
                        .font(.system(size: 28, weight: .heavy))
                        .foregroundColor(.white)
                        .multilineTextAlignment(.center)

                    Text("Everything's unlocked. No daily limit — create as much as you want.")
                        .font(.system(size: 15))
                        .foregroundColor(.white.opacity(0.72))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 36)
                        .padding(.top, 10)

                    VStack(alignment: .leading, spacing: 12) {
                        ForEach(unlocked, id: \.text) { item in
                            HStack(spacing: 12) {
                                Image(systemName: item.icon)
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundStyle(PromptlyGold.gradient)
                                    .frame(width: 22)
                                Text(item.text)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundColor(.white)
                                Spacer()
                            }
                        }
                    }
                    .padding(18)
                    .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .padding(.horizontal, 28)
                    .padding(.top, 26)

                    Text(TrialCopy.confirmationBody(price: price))
                        .font(.system(size: 12))
                        .foregroundColor(.white.opacity(0.5))
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 36)
                        .padding(.top, 16)

                    Spacer().frame(height: 32)

                    Button {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        onContinue()
                    } label: {
                        Text("Start creating")
                            .font(.system(size: 17, weight: .bold))
                            .foregroundColor(.black)
                            .frame(maxWidth: .infinity)
                            .frame(height: 56)
                            .background(Color.white, in: Capsule())
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 40)
                }
            }
        }
        .onAppear { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    }
}
