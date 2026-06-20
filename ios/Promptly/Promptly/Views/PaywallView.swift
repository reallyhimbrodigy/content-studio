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
        }
    }

    @ObservedObject private var subscription = SubscriptionService.shared
    @State private var selectedPackage: Package?
    @State private var isPurchasing = false
    @State private var showError = false
    @State private var errorMessage = ""

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

                    if let packages = currentPackages {
                        packagePicker(packages: packages)
                            .padding(.horizontal, 24)
                    } else {
                        ProgressView()
                            .tint(.white)
                            .padding(.vertical, 40)
                    }

                    Spacer().frame(height: 24)

                    ctaButton
                        .padding(.horizontal, 24)

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
        }
        .preferredColorScheme(.dark)
        .task {
            await subscription.refreshOfferings()
            // Default selection: pick the yearly package if present (better
            // value, hint at savings) — otherwise the first available.
            if let pkgs = currentPackages {
                selectedPackage = pkgs.first(where: { $0.packageType == .annual }) ?? pkgs.first
            }
        }
        .onChange(of: subscription.isPro) { _, isPro in
            if isPro { isPresented = false }
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
            Task {
                let ok = await subscription.purchase(pkg)
                if ok {
                    isPresented = false
                    await UsageService.shared.refresh()
                } else if let err = subscription.lastError {
                    errorMessage = err
                    showError = true
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

    private var fineprint: some View {
        Text("Auto-renews until cancelled. Cancel anytime in Settings.")
            .font(.system(size: 11))
            .foregroundColor(.white.opacity(0.4))
            .multilineTextAlignment(.center)
    }
}
